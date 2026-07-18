-- Final durability and projection hardening for the Restec integration.
begin;

alter type public.outbox_status add value if not exists 'cancelled';

alter table if exists public.paely_event_inbox rename to private_event_inbox;

alter table public.external_payments add column if not exists connection_id text;
update public.external_payments p
set connection_id=b.connection_id
from public.bill_mappings b
where p.bill_mapping_id=b.id and p.connection_id is null;
alter table public.external_payments alter column connection_id set not null;
alter table public.external_payments
  add constraint external_payments_connection_fk foreign key(connection_id)
  references public.pos_connections(id) on delete restrict;
create unique index if not exists external_payments_connection_external_id_key
  on public.external_payments(connection_id,external_payment_id);

create table if not exists public.sandbox_scenarios (
  id uuid primary key default gen_random_uuid(),
  connection_id text not null references public.pos_connections(id) on delete restrict,
  scenario text not null,
  external_bill_id text not null,
  requested_amount integer check (requested_amount is null or requested_amount > 0),
  public_event_id text check (public_event_id is null or public_event_id ~ '^evt_'),
  status text not null check (status in ('accepted','completed','failed')) default 'accepted',
  created_at timestamptz not null default now()
);
alter table public.sandbox_scenarios enable row level security;
revoke all on public.sandbox_scenarios from anon, authenticated;
create index if not exists sandbox_scenarios_connection_created_idx
  on public.sandbox_scenarios(connection_id, created_at desc);

create unique index if not exists webhook_endpoints_one_active_connection_idx
  on public.webhook_endpoints(connection_id) where status = 'active';

create or replace function public.accept_private_event(
  p_private_event_id text,
  p_event_type text,
  p_schema_version text,
  p_connection_id text,
  p_request_hash text,
  p_payload jsonb,
  p_public_event_id text,
  p_public_payload jsonb
) returns table(accepted boolean,event_id text)
language plpgsql security definer set search_path=public as $$
declare
  v_hash text;
  v_bill_count integer;
begin
  insert into private_event_inbox(
    private_event_id,event_type,schema_version,connection_id,request_hash,payload,status,processed_at
  ) values(
    p_private_event_id,p_event_type,p_schema_version,p_connection_id,p_request_hash,p_payload,'accepted',now()
  ) on conflict(private_event_id) do nothing;

  if not found then
    select request_hash into v_hash from private_event_inbox where private_event_id=p_private_event_id;
    if v_hash<>p_request_hash then
      raise exception using errcode='P0001',message='replay_detected';
    end if;
    return query
      select false,o.public_event_id
      from pos_outbox_events o
      where o.connection_id=p_connection_id and o.deduplication_key=p_private_event_id
      limit 1;
    if not found then
      raise exception using errcode='P0001',message='resource_not_found';
    end if;
    return;
  end if;

  update bill_mappings
  set public_state = public_state
      || (p_public_payload->'data'->'bill')
      || jsonb_build_object('updated_at', p_public_payload->>'created_at'),
      payment_status = p_public_payload->'data'->'bill'->>'payment_status',
      reconciliation_status = 'matched',
      updated_at = now()
  where connection_id=p_connection_id
    and external_bill_id=p_public_payload->'data'->>'external_bill_id'
    and public_state->>'external_table_id'=p_public_payload->'data'->>'external_table_id';
  get diagnostics v_bill_count=row_count;
  if v_bill_count<>1 then
    raise exception using errcode='P0001',message='resource_not_found';
  end if;

  insert into pos_outbox_events(
    public_event_id,connection_id,event_type,schema_version,payload,deduplication_key
  ) values(
    p_public_event_id,p_connection_id,p_event_type,p_schema_version,p_public_payload,p_private_event_id
  );
  return query select true,p_public_event_id;
end $$;

revoke all on function public.accept_private_event(text,text,text,text,text,jsonb,text,jsonb) from public;
grant execute on function public.accept_private_event(text,text,text,text,text,jsonb,text,jsonb) to service_role;

create or replace function public.persist_restec_external_payment(
  p_connection_id text,p_external_bill_id text,p_external_payment_id text,p_public_payment_id text,
  p_request_hash text,p_amount integer,p_currency text,p_public_state jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_bill bill_mappings%rowtype; v_payment external_payments%rowtype;
begin
  select * into v_bill from bill_mappings where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  select * into v_payment from external_payments where connection_id=p_connection_id and external_payment_id=p_external_payment_id;
  if found then
    if v_payment.bill_mapping_id<>v_bill.id or v_payment.request_hash<>p_request_hash then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
    return coalesce(v_payment.public_state,v_bill.public_state);
  end if;
  if (v_bill.public_state->>'currency')<>p_currency then raise exception using errcode='P0001',message='amount_mismatch'; end if;
  if p_amount>coalesce((v_bill.public_state->>'amount_due')::integer,0) or coalesce((v_bill.public_state->>'amount_due')::integer,0)=0 then raise exception using errcode='P0001',message='bill_already_paid'; end if;
  if (v_bill.public_state->>'payment_status')='payment_in_progress' then raise exception using errcode='P0001',message='payment_in_progress'; end if;
  insert into external_payments(connection_id,bill_mapping_id,external_payment_id,public_restec_payment_id,request_hash,amount,currency,status,public_state)
  values(p_connection_id,v_bill.id,p_external_payment_id,p_public_payment_id,p_request_hash,p_amount,p_currency,'completed',p_public_state);
  update bill_mappings set public_state=p_public_state,payment_status=p_public_state->>'payment_status',updated_at=now() where id=v_bill.id;
  return p_public_state;
end $$;
revoke all on function public.persist_restec_external_payment(text,text,text,text,text,integer,text,jsonb) from public;
grant execute on function public.persist_restec_external_payment(text,text,text,text,text,integer,text,jsonb) to service_role;

drop function if exists public.replay_pos_outbox_event(uuid);
create function public.replay_pos_outbox_event(p_event_id text) returns void
language plpgsql security definer set search_path=public as $$
begin
  update pos_outbox_events
  set status='pending',next_attempt_at=now(),locked_at=null,lock_expires_at=null,last_error_code=null
  where public_event_id=p_event_id and status='dead_letter';
  if not found then raise exception using errcode='P0001',message='event_not_replayable'; end if;
end $$;
revoke all on function public.replay_pos_outbox_event(text) from public;
grant execute on function public.replay_pos_outbox_event(text) to service_role;

commit;

-- Rollback: preserve inbox, outbox, bill projections, delivery evidence and sandbox audit rows.
-- Restore the previous accept_private_event body before renaming private_event_inbox back. Enum
-- values cannot be safely removed in place; leave cancelled until a controlled type migration.
