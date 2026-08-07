-- Shared Restec bill capacity boundary for POS payments, hosted sessions, and bill revisions.
begin;

create table public.financial_reservations (
  id uuid primary key default gen_random_uuid(),
  connection_id text not null references public.pos_connections(id) on delete restrict,
  bill_mapping_id uuid not null references public.bill_mappings(id) on delete restrict,
  reservation_identity text not null,
  channel text not null check (channel in ('external_payment','digital_session')),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 2147483647),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  request_hash text not null,
  state text not null check (state in (
    'reserved','ambiguous_pending_reconciliation','completed',
    'failed_released','expired_released','cancelled_released'
  )),
  expires_at timestamptz,
  authoritative_reference text,
  completed_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id,reservation_identity)
);
alter table public.financial_reservations enable row level security;
revoke all on public.financial_reservations from anon, authenticated;
create index financial_reservations_bill_state_idx
  on public.financial_reservations(bill_mapping_id,state,created_at);
create unique index financial_reservations_one_active_digital_bill_idx
  on public.financial_reservations(bill_mapping_id)
  where channel='digital_session' and state in ('reserved','ambiguous_pending_reconciliation');

create table public.bill_mutation_reservations (
  id uuid primary key default gen_random_uuid(),
  bill_mapping_id uuid not null references public.bill_mappings(id) on delete restrict,
  version integer not null check (version > 0),
  request_hash text not null,
  new_total_minor bigint not null check (new_total_minor >= 0 and new_total_minor <= 2147483647),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  state text not null check (state in ('reserved','ambiguous_pending_reconciliation','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bill_mapping_id,version)
);
alter table public.bill_mutation_reservations enable row level security;
revoke all on public.bill_mutation_reservations from anon, authenticated;
create unique index bill_mutation_one_active_bill_idx
  on public.bill_mutation_reservations(bill_mapping_id)
  where state in ('reserved','ambiguous_pending_reconciliation');

-- Existing completed facts become immutable capacity evidence. ON CONFLICT makes the
-- forward migration safe to rehearse without rewriting prior payment history.
insert into public.financial_reservations(
  connection_id,bill_mapping_id,reservation_identity,channel,amount_minor,currency,
  request_hash,state,authoritative_reference,completed_state,created_at,updated_at
)
select p.connection_id,p.bill_mapping_id,'external_payment:'||p.external_payment_id,
  'external_payment',p.amount,p.currency,p.request_hash,'completed',
  p.external_payment_id,p.public_state,p.created_at,p.created_at
from public.external_payments p
on conflict(connection_id,reservation_identity) do nothing;

insert into public.financial_reservations(
  connection_id,bill_mapping_id,reservation_identity,channel,amount_minor,currency,
  request_hash,state,expires_at,authoritative_reference,completed_state,created_at,updated_at
)
select s.connection_id,b.id,'payment_session:'||s.public_payment_session_id,
  'digital_session',s.amount_minor,s.currency,s.request_fingerprint,
  case
    when s.status in ('paid','refunded','partially_refunded') then 'completed'
    when s.status='failed' then 'failed_released'
    when s.status='expired' then 'expired_released'
    when s.status='cancelled' then 'cancelled_released'
    else 'reserved'
  end,
  s.expires_at,s.public_payment_session_id,
  case when s.status in ('paid','refunded','partially_refunded') then b.public_state else null end,
  s.created_at,s.updated_at
from public.payment_sessions s
join public.bill_mappings b
  on b.connection_id=s.connection_id and b.external_bill_id=s.external_bill_id
on conflict(connection_id,reservation_identity) do nothing;

create or replace function public.financial_projection_locked(p_bill_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with b as (
    select *,coalesce((
      select min(m.new_total_minor) from bill_mutation_reservations m
      where m.bill_mapping_id=bill_mappings.id
        and m.state in ('reserved','ambiguous_pending_reconciliation')
    ),(public_state->>'grand_total')::bigint) effective_total
    from bill_mappings where id=p_bill_id
  ), r as (
    select
      coalesce(sum(amount_minor) filter(where state='reserved'),0)::bigint active,
      coalesce(sum(amount_minor) filter(where state='ambiguous_pending_reconciliation'),0)::bigint ambiguous,
      coalesce(sum(amount_minor) filter(where state='completed'),0)::bigint completed
    from financial_reservations where bill_mapping_id=p_bill_id
  )
  select jsonb_build_object(
    'bill_total_minor',b.effective_total,
    'completed_payment_minor',greatest(
      coalesce((b.public_state->>'amount_paid')::bigint,0),r.completed
    ),
    'active_reserved_minor',r.active,
    'ambiguous_pending_minor',r.ambiguous,
    'refunded_minor',coalesce((b.public_state->>'amount_refunded')::bigint,0),
    'available_minor',greatest(0,b.effective_total
      -greatest(coalesce((b.public_state->>'amount_paid')::bigint,0),r.completed)
      +coalesce((b.public_state->>'amount_refunded')::bigint,0)-r.active-r.ambiguous)
  ) from b cross join r
$$;

create or replace function public.reserve_bill_capacity(
  p_connection_id text,p_external_bill_id text,p_reservation_identity text,p_channel text,
  p_amount_minor bigint,p_currency text,p_request_hash text,p_expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_bill bill_mappings%rowtype;
  v_existing financial_reservations%rowtype;
  v_projection jsonb;
begin
  if p_amount_minor<=0 or p_channel not in ('external_payment','digital_session') then
    raise exception using errcode='P0001',message='amount_mismatch';
  end if;
  select * into v_bill from bill_mappings
    where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  select * into v_existing from financial_reservations
    where connection_id=p_connection_id and reservation_identity=p_reservation_identity for update;
  if found then
    if v_existing.bill_mapping_id<>v_bill.id or v_existing.channel<>p_channel
      or v_existing.amount_minor<>p_amount_minor or v_existing.currency<>p_currency
      or v_existing.request_hash<>p_request_hash then
      raise exception using errcode='P0001',message='idempotency_conflict';
    end if;
    v_projection:=financial_projection_locked(v_bill.id);
    return jsonb_build_object('state',v_existing.state,'created',false,
      'projection',v_projection,'completed_state',v_existing.completed_state);
  end if;
  if (v_bill.public_state->>'currency')<>p_currency then
    raise exception using errcode='P0001',message='amount_mismatch';
  end if;
  if p_channel='digital_session' and exists(
    select 1 from financial_reservations where bill_mapping_id=v_bill.id
      and channel='digital_session' and state in ('reserved','ambiguous_pending_reconciliation')
  ) then raise exception using errcode='P0001',message='payment_in_progress'; end if;
  v_projection:=financial_projection_locked(v_bill.id);
  if p_amount_minor>(v_projection->>'available_minor')::bigint then
    raise exception using errcode='P0001',message='payment_capacity_conflict';
  end if;
  insert into financial_reservations(
    connection_id,bill_mapping_id,reservation_identity,channel,amount_minor,currency,
    request_hash,state,expires_at
  ) values(
    p_connection_id,v_bill.id,p_reservation_identity,p_channel,p_amount_minor,p_currency,
    p_request_hash,'reserved',p_expires_at
  );
  return jsonb_build_object('state','reserved','created',true,
    'projection',financial_projection_locked(v_bill.id));
end $$;

create or replace function public.mark_financial_reservation_ambiguous(
  p_connection_id text,p_reservation_identity text,p_request_hash text
) returns void language plpgsql security definer set search_path=public as $$
begin
  update financial_reservations set state='ambiguous_pending_reconciliation',updated_at=now()
    where connection_id=p_connection_id and reservation_identity=p_reservation_identity
      and request_hash=p_request_hash and state='reserved';
  if not found and not exists(
    select 1 from financial_reservations where connection_id=p_connection_id
      and reservation_identity=p_reservation_identity and request_hash=p_request_hash
      and state in ('ambiguous_pending_reconciliation','completed')
  ) then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
end $$;

create or replace function public.reserve_bill_mutation(
  p_connection_id text,p_external_bill_id text,p_version integer,p_request_hash text,
  p_new_total_minor bigint,p_currency text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_bill bill_mappings%rowtype;
  v_pending bill_mutation_reservations%rowtype;
  v_projection jsonb;
  v_protected bigint;
begin
  select * into v_bill from bill_mappings
    where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if not found then
    if p_version<>1 then raise exception using errcode='P0001',message='bill_version_conflict'; end if;
    return jsonb_build_object('kind','proceed');
  end if;
  if (v_bill.public_state->>'currency')<>p_currency then
    raise exception using errcode='P0001',message='amount_mismatch';
  end if;
  if p_version<v_bill.current_version or
    (p_version=v_bill.current_version and p_request_hash<>v_bill.last_request_hash) then
    raise exception using errcode='P0001',message='bill_version_conflict';
  end if;
  if p_version=v_bill.current_version then
    return jsonb_build_object('kind','replay','state',v_bill.public_state);
  end if;
  select * into v_pending from bill_mutation_reservations
    where bill_mapping_id=v_bill.id and state in ('reserved','ambiguous_pending_reconciliation')
    for update;
  if found then
    if v_pending.version<>p_version or v_pending.request_hash<>p_request_hash
      or v_pending.new_total_minor<>p_new_total_minor or v_pending.currency<>p_currency then
      raise exception using errcode='P0001',message='bill_version_conflict';
    end if;
    return jsonb_build_object('kind','proceed');
  end if;
  v_projection:=financial_projection_locked(v_bill.id);
  v_protected:=(v_projection->>'completed_payment_minor')::bigint
    -(v_projection->>'refunded_minor')::bigint
    +(v_projection->>'active_reserved_minor')::bigint
    +(v_projection->>'ambiguous_pending_minor')::bigint;
  if p_new_total_minor<v_protected then
    raise exception using errcode='P0001',message='bill_financial_floor_conflict';
  end if;
  insert into bill_mutation_reservations(
    bill_mapping_id,version,request_hash,new_total_minor,currency,state
  ) values(v_bill.id,p_version,p_request_hash,p_new_total_minor,p_currency,'reserved');
  return jsonb_build_object('kind','proceed');
end $$;

create or replace function public.mark_bill_mutation_ambiguous(
  p_connection_id text,p_external_bill_id text,p_version integer,p_request_hash text
) returns void language plpgsql security definer set search_path=public as $$
begin
  update bill_mutation_reservations m set state='ambiguous_pending_reconciliation',updated_at=now()
  from bill_mappings b where m.bill_mapping_id=b.id and b.connection_id=p_connection_id
    and b.external_bill_id=p_external_bill_id and m.version=p_version
    and m.request_hash=p_request_hash and m.state='reserved';
end $$;

create or replace function public.persist_restec_bill_state(
  p_connection_id text,p_external_bill_id text,p_public_bill_id text,p_private_reference text,
  p_version integer,p_request_hash text,p_public_state jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_existing bill_mappings%rowtype; v_pending bill_mutation_reservations%rowtype;
begin
  select * into v_existing from bill_mappings
    where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if found then
    if p_version<v_existing.current_version or
      (p_version=v_existing.current_version and p_request_hash<>v_existing.last_request_hash) then
      raise exception using errcode='P0001',message='bill_version_conflict';
    end if;
    if p_version=v_existing.current_version then return v_existing.public_state; end if;
    select * into v_pending from bill_mutation_reservations
      where bill_mapping_id=v_existing.id and version=p_version for update;
    if not found or v_pending.request_hash<>p_request_hash
      or v_pending.new_total_minor<>(p_public_state->>'grand_total')::bigint then
      raise exception using errcode='P0001',message='bill_financial_floor_conflict';
    end if;
    update bill_mappings set current_version=p_version,last_request_hash=p_request_hash,
      public_state=p_public_state,payment_status=p_public_state->>'payment_status',
      reconciliation_status=coalesce(p_public_state->>'reconciliation_status','pending'),updated_at=now()
      where id=v_existing.id;
    update bill_mutation_reservations set state='completed',updated_at=now() where id=v_pending.id;
  else
    insert into bill_mappings(connection_id,external_bill_id,public_restec_bill_id,
      private_paely_bill_reference,current_version,last_request_hash,payment_status,
      reconciliation_status,public_state)
    values(p_connection_id,p_external_bill_id,p_public_bill_id,p_private_reference,p_version,
      p_request_hash, p_public_state->>'payment_status',
      coalesce(p_public_state->>'reconciliation_status','pending'), p_public_state);
  end if;
  return p_public_state;
end $$;

create or replace function public.persist_restec_external_payment(
  p_connection_id text,p_external_bill_id text,p_external_payment_id text,p_public_payment_id text,
  p_request_hash text,p_amount integer,p_currency text,p_public_state jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_bill bill_mappings%rowtype;
  v_payment external_payments%rowtype;
  v_reservation financial_reservations%rowtype;
begin
  select * into v_bill from bill_mappings where connection_id=p_connection_id
    and external_bill_id=p_external_bill_id for update;
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  select * into v_reservation from financial_reservations
    where connection_id=p_connection_id
      and reservation_identity='external_payment:'||p_external_payment_id for update;
  if not found or v_reservation.bill_mapping_id<>v_bill.id
    or v_reservation.request_hash<>p_request_hash or v_reservation.amount_minor<>p_amount
    or v_reservation.currency<>p_currency then
    raise exception using errcode='P0001',message='payment_capacity_conflict';
  end if;
  select * into v_payment from external_payments where connection_id=p_connection_id
    and external_payment_id=p_external_payment_id;
  if found then
    if v_payment.bill_mapping_id<>v_bill.id or v_payment.request_hash<>p_request_hash then
      raise exception using errcode='P0001',message='idempotency_conflict';
    end if;
    return coalesce(v_payment.public_state,v_bill.public_state);
  end if;
  if v_reservation.state not in ('reserved','ambiguous_pending_reconciliation') then
    raise exception using errcode='P0001',message='payment_capacity_conflict';
  end if;
  insert into external_payments(connection_id,bill_mapping_id,external_payment_id,
    public_restec_payment_id,request_hash,amount,currency,status,public_state)
  values(p_connection_id,v_bill.id,p_external_payment_id,p_public_payment_id,p_request_hash,
    p_amount,p_currency,'completed',p_public_state);
  update financial_reservations set state='completed',authoritative_reference=p_external_payment_id,
    completed_state=p_public_state,updated_at=now() where id=v_reservation.id;
  update bill_mappings set public_state=p_public_state,
    payment_status=p_public_state->>'payment_status',updated_at=now() where id=v_bill.id;
  return p_public_state;
end $$;

create or replace function public.accept_payment_session_event(
  p_private_event_id text,p_event_type text,p_schema_version text,p_connection_id text,
  p_request_hash text,p_payload jsonb,p_public_event_id text,p_public_payload jsonb,
  p_public_payment_session_id text,p_requested_status text
) returns table(accepted boolean,event_id text)
language plpgsql security definer set search_path=public as $$
declare
  v_hash text; v_session payment_sessions%rowtype; v_bill bill_mappings%rowtype;
  v_reservation financial_reservations%rowtype;
begin
  insert into private_event_inbox(private_event_id,event_type,schema_version,connection_id,
    request_hash,payload,status,processed_at)
  values(p_private_event_id,p_event_type,p_schema_version,p_connection_id,p_request_hash,
    p_payload,'accepted',now()) on conflict(private_event_id) do nothing;
  if not found then
    select request_hash into v_hash from private_event_inbox where private_event_id=p_private_event_id;
    if v_hash<>p_request_hash then raise exception using errcode='P0001',message='replay_detected'; end if;
    return query select false,coalesce((select public_event_id from pos_outbox_events
      where connection_id=p_connection_id and deduplication_key=p_private_event_id limit 1),p_public_event_id);
    return;
  end if;
  select * into v_session from payment_sessions where public_payment_session_id=p_public_payment_session_id
    and connection_id=p_connection_id for update;
  if not found then
    update private_event_inbox set status='review_required',processed_at=null
      where private_event_id=p_private_event_id;
    insert into audit_logs(actor_type,connection_id,action,result,target_type,target_id,metadata)
    values('service',p_connection_id,'payment_session.event_unmatched','review_required',
      'payment_session',p_public_payment_session_id,jsonb_build_object('event_type',p_event_type));
    return query select true,p_public_event_id; return;
  end if;
  select * into v_bill from bill_mappings where connection_id=p_connection_id
    and external_bill_id=v_session.external_bill_id for update;
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  select * into v_reservation from financial_reservations
    where connection_id=p_connection_id
      and reservation_identity='payment_session:'||p_public_payment_session_id for update;
  if not found or v_reservation.bill_mapping_id<>v_bill.id
    or v_reservation.amount_minor<>v_session.amount_minor or v_reservation.currency<>v_session.currency then
    raise exception using errcode='P0001',message='payment_capacity_conflict';
  end if;
  if p_requested_status='paid' and v_reservation.state in
    ('failed_released','expired_released','cancelled_released') and
    v_reservation.amount_minor>(financial_projection_locked(v_bill.id)->>'available_minor')::bigint then
    raise exception using errcode='P0001',message='payment_capacity_conflict';
  end if;
  if p_requested_status='paid' and v_reservation.state='completed' then
    return query select false,coalesce((
      select public_event_id from pos_outbox_events
      where connection_id=p_connection_id
        and deduplication_key=v_reservation.authoritative_reference limit 1
    ),p_public_event_id);
    return;
  end if;
  perform transition_payment_session(p_public_payment_session_id,p_requested_status,
    (p_public_payload->>'created_at')::timestamptz);
  if p_requested_status='paid' then
    update financial_reservations set state='completed',authoritative_reference=p_private_event_id,
      completed_state=p_public_payload->'data'->'bill',updated_at=now() where id=v_reservation.id;
  elsif p_requested_status='failed' then
    update financial_reservations set state='failed_released',authoritative_reference=p_private_event_id,
      updated_at=now() where id=v_reservation.id and state<>'completed';
  elsif p_requested_status='expired' then
    update financial_reservations set state='expired_released',authoritative_reference=p_private_event_id,
      updated_at=now() where id=v_reservation.id and state<>'completed';
  elsif p_requested_status='cancelled' then
    update financial_reservations set state='cancelled_released',authoritative_reference=p_private_event_id,
      updated_at=now() where id=v_reservation.id and state<>'completed';
  end if;
  update bill_mappings set public_state=public_state||(p_public_payload->'data'->'bill')
    ||jsonb_build_object('updated_at',p_public_payload->>'created_at'),
    payment_status=p_public_payload->'data'->'bill'->>'payment_status',
    reconciliation_status='matched',updated_at=now() where id=v_bill.id
      and public_state->>'external_table_id'=p_public_payload->'data'->>'external_table_id';
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  insert into pos_outbox_events(public_event_id,connection_id,event_type,schema_version,payload,deduplication_key)
  values(p_public_event_id,p_connection_id,p_event_type,p_schema_version,p_public_payload,p_private_event_id);
  return query select true,p_public_event_id;
end $$;

revoke all on function public.financial_projection_locked(uuid) from public;
revoke all on function public.reserve_bill_capacity(text,text,text,text,bigint,text,text,timestamptz) from public;
revoke all on function public.mark_financial_reservation_ambiguous(text,text,text) from public;
revoke all on function public.reserve_bill_mutation(text,text,integer,text,bigint,text) from public;
revoke all on function public.mark_bill_mutation_ambiguous(text,text,integer,text) from public;
grant execute on function public.financial_projection_locked(uuid) to service_role;
grant execute on function public.reserve_bill_capacity(text,text,text,text,bigint,text,text,timestamptz) to service_role;
grant execute on function public.mark_financial_reservation_ambiguous(text,text,text) to service_role;
grant execute on function public.reserve_bill_mutation(text,text,integer,text,bigint,text) to service_role;
grant execute on function public.mark_bill_mutation_ambiguous(text,text,integer,text) to service_role;

commit;

-- Rollback/recovery: disable the Phase 1 routes first. Preserve both reservation tables as
-- financial evidence. Restore the prior RPC bodies only after all reserved/ambiguous rows are
-- reconciled; never drop or rewrite completed facts during rollback.
