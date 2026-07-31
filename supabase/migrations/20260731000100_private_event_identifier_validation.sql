-- Resolve Paely-private identifiers to Restec-public identifiers and validate all immutable
-- hosted-payment associations before durable inbox acceptance.
begin;

create unique index if not exists locations_private_reference_idx
  on public.locations(private_location_reference);
create unique index if not exists pos_connections_private_reference_idx
  on public.pos_connections(private_connection_reference);

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
  v_session public.payment_sessions%rowtype;
  v_connection public.pos_connections%rowtype;
  v_location public.locations%rowtype;
  v_bill_count integer;
begin
  select * into v_connection from public.pos_connections
  where private_connection_reference=(p_payload->'data'->>'connection_id')::uuid
    and status='active';
  if not found then
    raise exception using errcode='P0001',message='paely_connection_mapping_not_found';
  end if;

  select * into v_location from public.locations
  where private_location_reference=(p_payload->'data'->>'location_id')::uuid;
  if not found then
    raise exception using errcode='P0001',message='paely_location_mapping_not_found';
  end if;

  select * into v_session from public.payment_sessions
  where public_payment_session_id=p_public_payment_session_id for update;
  if not found then
    raise exception using errcode='P0001',message='resource_not_found';
  end if;

  if v_connection.id<>p_connection_id
    or v_connection.id<>v_session.connection_id
    or v_session.private_connection_reference<>(p_payload->'data'->>'connection_id')::uuid then
    raise exception using errcode='P0001',message='connection_reference_mismatch';
  end if;
  if v_location.id<>v_session.location_id
    or v_connection.location_id<>v_location.id
    or v_session.private_location_reference<>(p_payload->'data'->>'location_id')::uuid then
    raise exception using errcode='P0001',message='location_reference_mismatch';
  end if;
  if v_connection.environment::text<>v_session.environment
    or v_location.environment::text<>v_session.environment then
    raise exception using errcode='P0001',message='location_reference_mismatch';
  end if;
  if v_session.private_payment_session_reference is distinct from
    p_payload->'data'->'payment_session'->>'private_payment_session_id' then
    raise exception using errcode='P0001',message='payment_session_reference_mismatch';
  end if;
  if v_session.external_bill_id<>p_payload->'data'->>'external_bill_id' then
    raise exception using errcode='P0001',message='external_bill_reference_mismatch';
  end if;
  if v_session.amount_minor<>(p_payload->'data'->'payment'->>'amount')::bigint
    or v_session.currency<>p_payload->'data'->'payment'->>'currency' then
    raise exception using errcode='P0001',message='amount_mismatch';
  end if;
  if v_session.method<>p_payload->'data'->'payment'->>'method' then
    raise exception using errcode='P0001',message='payment_method_mismatch';
  end if;
  if p_payload->'data'->'payment_session'->>'status'<>p_requested_status then
    raise exception using errcode='P0001',message='payment_status_mismatch';
  end if;

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

revoke all on function public.accept_payment_session_event(text,text,text,text,text,jsonb,text,jsonb,text,text) from public;
grant execute on function public.accept_payment_session_event(text,text,text,text,text,jsonb,text,jsonb,text,text) to service_role;

commit;

-- Rollback: deploy the prior accept_payment_session_event definition. Preserve all financial,
-- inbox, outbox, session, and audit evidence; do not remove the uniqueness guarantees.
