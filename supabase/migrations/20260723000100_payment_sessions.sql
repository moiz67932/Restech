-- Additive hosted-payment session projection, state transition RPCs, and sandbox receipt evidence.
begin;

create table if not exists public.payment_sessions (
  id uuid primary key default gen_random_uuid(),
  public_payment_session_id text not null unique
    check (public_payment_session_id ~ '^rps_(test|live)_[A-Za-z0-9]+$'),
  environment text not null check (environment in ('sandbox','production')),
  partner_id text not null references public.partners(id) on delete restrict,
  connection_id text not null references public.pos_connections(id) on delete restrict,
  location_id text not null references public.locations(id) on delete restrict,
  external_bill_id text not null,
  private_location_reference uuid not null,
  private_connection_reference uuid not null,
  private_payment_session_reference text,
  encrypted_provider_checkout_url text,
  provider_checkout_host text,
  method text not null check (method in ('card','google_pay')),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 2147483647),
  currency text not null check (currency = 'PKR'),
  status text not null check (status in (
    'creating','requires_customer_action','processing','paid','failed','expired','cancelled',
    'refunded','partially_refunded'
  )),
  expires_at timestamptz not null,
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  idempotency_key text not null,
  request_fingerprint text not null,
  last_public_error_code text,
  last_private_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(partner_id,location_id,external_bill_id,idempotency_key)
);
alter table public.payment_sessions enable row level security;
revoke all on public.payment_sessions from anon, authenticated;
create index if not exists payment_sessions_connection_bill_idx
  on public.payment_sessions(connection_id,external_bill_id,created_at desc);
create index if not exists payment_sessions_private_reference_idx
  on public.payment_sessions(private_payment_session_reference)
  where private_payment_session_reference is not null;
create index if not exists payment_sessions_expiry_idx
  on public.payment_sessions(status,expires_at);
create unique index if not exists payment_sessions_one_active_bill_idx
  on public.payment_sessions(connection_id,external_bill_id)
  where status in ('creating','requires_customer_action','processing');

create table if not exists public.mock_pos_receipts (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique check (event_id ~ '^evt_'),
  connection_id text not null references public.pos_connections(id) on delete restrict,
  request_hash text not null,
  event_type text not null,
  received_at timestamptz not null default now()
);
alter table public.mock_pos_receipts enable row level security;
revoke all on public.mock_pos_receipts from anon, authenticated;
create index if not exists mock_pos_receipts_received_idx
  on public.mock_pos_receipts(received_at desc);

create or replace function public.transition_payment_session(
  p_public_payment_session_id text,
  p_requested_status text,
  p_occurred_at timestamptz
) returns table(changed boolean,session jsonb)
language plpgsql security definer set search_path=public as $$
declare
  v_session public.payment_sessions%rowtype;
  v_allowed boolean := false;
begin
  select * into v_session from public.payment_sessions
  where public_payment_session_id=p_public_payment_session_id for update;
  if not found then
    raise exception using errcode='P0001',message='resource_not_found';
  end if;
  if v_session.status=p_requested_status then
    return query select false,to_jsonb(v_session);
    return;
  end if;
  v_allowed :=
    (v_session.status='creating' and p_requested_status in ('requires_customer_action','processing','paid','failed','expired'))
    or (v_session.status='requires_customer_action' and p_requested_status in ('processing','paid','failed','expired','cancelled'))
    or (v_session.status='processing' and p_requested_status in ('paid','failed','expired','cancelled'))
    or (v_session.status in ('failed','expired','cancelled') and p_requested_status='paid')
    or (v_session.status='paid' and p_requested_status in ('partially_refunded','refunded'))
    or (v_session.status='partially_refunded' and p_requested_status in ('partially_refunded','refunded'));
  if not v_allowed then
    raise exception using errcode='P0001',message='invalid_status_transition';
  end if;
  update public.payment_sessions set
    status=p_requested_status,
    paid_at=case when p_requested_status='paid' then coalesce(paid_at,p_occurred_at) else paid_at end,
    failed_at=case when p_requested_status='failed' then coalesce(failed_at,p_occurred_at) else failed_at end,
    cancelled_at=case when p_requested_status='cancelled' then coalesce(cancelled_at,p_occurred_at) else cancelled_at end,
    last_private_status=p_requested_status,
    updated_at=p_occurred_at
  where id=v_session.id returning * into v_session;
  return query select true,to_jsonb(v_session);
end $$;

create or replace function public.accept_payment_session_event(
  p_private_event_id text,
  p_event_type text,
  p_schema_version text,
  p_connection_id text,
  p_request_hash text,
  p_payload jsonb,
  p_public_event_id text,
  p_public_payload jsonb,
  p_public_payment_session_id text,
  p_requested_status text
) returns table(accepted boolean,event_id text)
language plpgsql security definer set search_path=public as $$
declare
  v_hash text;
  v_session_id uuid;
  v_bill_count integer;
begin
  insert into public.private_event_inbox(
    private_event_id,event_type,schema_version,connection_id,request_hash,payload,status,processed_at
  ) values(
    p_private_event_id,p_event_type,p_schema_version,p_connection_id,p_request_hash,p_payload,'accepted',now()
  ) on conflict(private_event_id) do nothing;
  if not found then
    select request_hash into v_hash from public.private_event_inbox
      where private_event_id=p_private_event_id;
    if v_hash<>p_request_hash then
      raise exception using errcode='P0001',message='replay_detected';
    end if;
    return query select false,coalesce((
      select public_event_id from public.pos_outbox_events
      where connection_id=p_connection_id and deduplication_key=p_private_event_id limit 1
    ),p_public_event_id);
    return;
  end if;

  select id into v_session_id from public.payment_sessions
  where public_payment_session_id=p_public_payment_session_id
    and connection_id=p_connection_id for update;
  if not found then
    update public.private_event_inbox set status='review_required',processed_at=null
      where private_event_id=p_private_event_id;
    insert into public.audit_logs(
      actor_type,connection_id,action,result,target_type,target_id,metadata
    ) values(
      'service',p_connection_id,'payment_session.event_unmatched','review_required',
      'payment_session',p_public_payment_session_id,jsonb_build_object('event_type',p_event_type)
    );
    return query select true,p_public_event_id;
    return;
  end if;

  perform public.transition_payment_session(
    p_public_payment_session_id,p_requested_status,(p_public_payload->>'created_at')::timestamptz
  );
  update public.bill_mappings
  set public_state=public_state
      || (p_public_payload->'data'->'bill')
      || jsonb_build_object('updated_at',p_public_payload->>'created_at'),
      payment_status=p_public_payload->'data'->'bill'->>'payment_status',
      reconciliation_status='matched',
      updated_at=now()
  where connection_id=p_connection_id
    and external_bill_id=p_public_payload->'data'->>'external_bill_id'
    and public_state->>'external_table_id'=p_public_payload->'data'->>'external_table_id';
  get diagnostics v_bill_count=row_count;
  if v_bill_count<>1 then
    raise exception using errcode='P0001',message='resource_not_found';
  end if;
  insert into public.pos_outbox_events(
    public_event_id,connection_id,event_type,schema_version,payload,deduplication_key
  ) values(
    p_public_event_id,p_connection_id,p_event_type,p_schema_version,p_public_payload,p_private_event_id
  );
  return query select true,p_public_event_id;
end $$;

revoke all on function public.transition_payment_session(text,text,timestamptz) from public;
revoke all on function public.accept_payment_session_event(text,text,text,text,text,jsonb,text,jsonb,text,text) from public;
grant execute on function public.transition_payment_session(text,text,timestamptz) to service_role;
grant execute on function public.accept_payment_session_event(text,text,text,text,text,jsonb,text,jsonb,text,text) to service_role;

commit;

-- Rollback: disable RESTEC_PAYMENT_SESSIONS_ENABLED and revert application code. Preserve
-- payment_sessions, private_event_inbox, pos_outbox_events, mock_pos_receipts, and audit rows as
-- financial evidence. Do not destructively drop or rewrite them; retire RPC execute grants only
-- after all in-flight sandbox sessions and deliveries have been reconciled.
