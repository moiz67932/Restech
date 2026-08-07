-- Phase 4: deduplicate different technical events for one logical payment-session terminal state.
begin;

create or replace function public.accept_payment_session_event(
  p_private_event_id text,p_event_type text,p_schema_version text,p_connection_id text,
  p_request_hash text,p_payload jsonb,p_public_event_id text,p_public_payload jsonb,
  p_public_payment_session_id text,p_requested_status text
) returns table(accepted boolean,event_id text)
language plpgsql security definer set search_path=public as $$
declare
  v_hash text; v_existing_event_id text; v_session payment_sessions%rowtype;
  v_bill bill_mappings%rowtype; v_reservation financial_reservations%rowtype;
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

  select * into v_session from payment_sessions
    where public_payment_session_id=p_public_payment_session_id and connection_id=p_connection_id
    for update;
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

  if v_session.status=p_requested_status then
    select public_event_id into v_existing_event_id from pos_outbox_events
      where connection_id=p_connection_id and event_type=p_event_type
        and payload->'data'->>'payment_session_id'=p_public_payment_session_id
      order by created_at limit 1;
    if found then
      return query select false,v_existing_event_id;
      return;
    end if;
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

revoke all on function public.accept_payment_session_event(text,text,text,text,text,jsonb,text,jsonb,text,text) from public;
grant execute on function public.accept_payment_session_event(text,text,text,text,text,jsonb,text,jsonb,text,text) to service_role;

commit;

-- Rollback: restore the Phase 1 function body. Preserve payment sessions, reservations, inbox,
-- outbox, and audit evidence; this migration performs no destructive history rewrite.
