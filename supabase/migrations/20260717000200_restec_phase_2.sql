begin;

alter table public.api_keys add column if not exists encrypted_signing_secret text;
alter table public.replay_records add column if not exists request_hash text;
alter table public.replay_records add column if not exists environment public.restec_environment;
alter table public.replay_records add column if not exists signed_timestamp bigint;
alter table public.idempotency_records add column if not exists updated_at timestamptz not null default now();
alter table public.idempotency_records drop constraint if exists idempotency_records_status_check;
alter table public.idempotency_records add constraint idempotency_records_status_check check(status in('processing','completed','failed'));
alter table public.external_payments add column if not exists public_state jsonb;
alter table public.pos_connections drop constraint if exists pos_connections_location_id_environment_key;
create unique index if not exists pos_connections_location_connector_key on public.pos_connections(location_id,environment,connector_type);
alter table public.pos_outbox_events add constraint pos_outbox_attempt_count_nonnegative check(attempt_count >= 0) not valid;
alter table public.pos_outbox_events validate constraint pos_outbox_attempt_count_nonnegative;
create unique index if not exists api_keys_environment_prefix_key on public.api_keys(environment,key_prefix);
create index if not exists replay_partner_environment_expiry_idx on public.replay_records(partner_id,environment,expires_at);
create index if not exists external_payment_public_id_idx on public.external_payments(public_restec_payment_id);
create index if not exists delivery_attempt_event_created_idx on public.webhook_delivery_attempts(outbox_event_id,created_at desc);

create or replace function public.accept_private_event(p_private_event_id text,p_event_type text,p_schema_version text,p_connection_id text,p_request_hash text,p_payload jsonb,p_public_event_id text,p_public_payload jsonb)
returns table(accepted boolean,event_id text) language plpgsql security definer set search_path=public as $$
declare v_hash text;
begin
  insert into paely_event_inbox(private_event_id,event_type,schema_version,connection_id,request_hash,payload,status,processed_at) values(p_private_event_id,p_event_type,p_schema_version,p_connection_id,p_request_hash,p_payload,'accepted',now()) on conflict(private_event_id) do nothing;
  if not found then
    select request_hash into v_hash from paely_event_inbox where private_event_id=p_private_event_id;
    if v_hash<>p_request_hash then raise exception using errcode='P0001',message='replay_detected'; end if;
    return query select true,o.public_event_id from pos_outbox_events o where o.connection_id=p_connection_id and o.deduplication_key=p_private_event_id limit 1;
    return;
  end if;
  insert into pos_outbox_events(public_event_id,connection_id,event_type,schema_version,payload,deduplication_key) values(p_public_event_id,p_connection_id,p_event_type,p_schema_version,p_public_payload,p_private_event_id);
  return query select true,p_public_event_id;
end $$;

create or replace function public.persist_restec_bill_state(
  p_connection_id text,p_external_bill_id text,p_public_bill_id text,p_private_reference text,
  p_version integer,p_request_hash text,p_public_state jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_existing bill_mappings%rowtype;
begin
  select * into v_existing from bill_mappings where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if found then
    if p_version < v_existing.current_version then raise exception using errcode='P0001',message='bill_version_conflict'; end if;
    if p_version = v_existing.current_version and p_request_hash <> v_existing.last_request_hash then raise exception using errcode='P0001',message='bill_version_conflict'; end if;
    if p_version = v_existing.current_version then return v_existing.public_state; end if;
    if coalesce((p_public_state->>'grand_total')::integer,0) < coalesce((v_existing.public_state->>'amount_paid')::integer,0)-coalesce((v_existing.public_state->>'amount_refunded')::integer,0) then raise exception using errcode='P0001',message='amount_mismatch'; end if;
    update bill_mappings set current_version=p_version,last_request_hash=p_request_hash,public_state=p_public_state,payment_status=p_public_state->>'payment_status',reconciliation_status=coalesce(p_public_state->>'reconciliation_status','pending'),updated_at=now() where id=v_existing.id;
  else
    insert into bill_mappings(connection_id,external_bill_id,public_restec_bill_id,private_paely_bill_reference,current_version,last_request_hash,payment_status,reconciliation_status,public_state)
    values(p_connection_id,p_external_bill_id,p_public_bill_id,p_private_reference,p_version,p_request_hash,p_public_state,p_public_state->>'payment_status',coalesce(p_public_state->>'reconciliation_status','pending'));
  end if;
  return p_public_state;
end $$;

create or replace function public.persist_restec_external_payment(
  p_connection_id text,p_external_bill_id text,p_external_payment_id text,p_public_payment_id text,
  p_request_hash text,p_amount integer,p_currency text,p_public_state jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_bill bill_mappings%rowtype; v_payment external_payments%rowtype;
begin
  select * into v_bill from bill_mappings where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  select * into v_payment from external_payments where bill_mapping_id=v_bill.id and external_payment_id=p_external_payment_id;
  if found then
    if v_payment.request_hash<>p_request_hash then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
    return coalesce(v_payment.public_state,v_bill.public_state);
  end if;
  if (v_bill.public_state->>'currency')<>p_currency then raise exception using errcode='P0001',message='amount_mismatch'; end if;
  if p_amount>coalesce((v_bill.public_state->>'amount_due')::integer,0) then raise exception using errcode='P0001',message='bill_already_paid'; end if;
  if (v_bill.public_state->>'payment_status')='payment_in_progress' then raise exception using errcode='P0001',message='payment_in_progress'; end if;
  insert into external_payments(bill_mapping_id,external_payment_id,public_restec_payment_id,request_hash,amount,currency,status,public_state)
  values(v_bill.id,p_external_payment_id,p_public_payment_id,p_request_hash,p_amount,p_currency,'completed',p_public_state);
  update bill_mappings set public_state=p_public_state,payment_status=p_public_state->>'payment_status',updated_at=now() where id=v_bill.id;
  return p_public_state;
end $$;

create or replace function public.complete_pos_outbox_delivery(p_event_id uuid,p_attempt integer,p_status integer,p_duration integer)
returns void language plpgsql security definer set search_path=public as $$ begin
  insert into webhook_delivery_attempts(outbox_event_id,attempt_number,response_status,outcome,duration_ms) values(p_event_id,p_attempt,p_status,'delivered',p_duration) on conflict(outbox_event_id,attempt_number) do nothing;
  update pos_outbox_events set status='delivered',attempt_count=greatest(attempt_count,p_attempt),delivered_at=now(),locked_at=null,lock_expires_at=null,last_error_code=null where id=p_event_id;
end $$;
create or replace function public.fail_pos_outbox_delivery(p_event_id uuid,p_attempt integer,p_status integer,p_outcome text,p_error text,p_duration integer,p_next timestamptz)
returns void language plpgsql security definer set search_path=public as $$ begin
  insert into webhook_delivery_attempts(outbox_event_id,attempt_number,response_status,outcome,error_code,duration_ms) values(p_event_id,p_attempt,p_status,p_outcome,p_error,p_duration) on conflict(outbox_event_id,attempt_number) do nothing;
  update pos_outbox_events set status=case when p_outcome='permanent_failure' then 'dead_letter'::outbox_status else 'pending'::outbox_status end,attempt_count=greatest(attempt_count,p_attempt),next_attempt_at=coalesce(p_next,next_attempt_at),locked_at=null,lock_expires_at=null,last_error_code=p_error where id=p_event_id;
end $$;
create or replace function public.release_expired_pos_outbox_leases() returns integer language plpgsql security definer set search_path=public as $$ declare v_count integer; begin update pos_outbox_events set status='pending',locked_at=null,lock_expires_at=null where status='processing' and lock_expires_at<now(); get diagnostics v_count=row_count; return v_count; end $$;
create or replace function public.replay_pos_outbox_event(p_event_id uuid) returns void language plpgsql security definer set search_path=public as $$ begin update pos_outbox_events set status='pending',next_attempt_at=now(),locked_at=null,lock_expires_at=null,last_error_code=null where id=p_event_id and status='dead_letter'; if not found then raise exception using errcode='P0001',message='event_not_replayable'; end if; end $$;

revoke all on function public.persist_restec_bill_state(text,text,text,text,integer,text,jsonb) from public;
revoke all on function public.persist_restec_external_payment(text,text,text,text,text,integer,text,jsonb) from public;
revoke all on function public.complete_pos_outbox_delivery(uuid,integer,integer,integer) from public;
revoke all on function public.fail_pos_outbox_delivery(uuid,integer,integer,text,text,integer,timestamptz) from public;
revoke all on function public.release_expired_pos_outbox_leases() from public;
revoke all on function public.replay_pos_outbox_event(uuid) from public;
grant execute on function public.persist_restec_bill_state(text,text,text,text,integer,text,jsonb) to service_role;
grant execute on function public.persist_restec_external_payment(text,text,text,text,text,integer,text,jsonb) to service_role;
grant execute on function public.complete_pos_outbox_delivery(uuid,integer,integer,integer) to service_role;
grant execute on function public.fail_pos_outbox_delivery(uuid,integer,integer,text,text,integer,timestamptz) to service_role;
grant execute on function public.release_expired_pos_outbox_leases() to service_role;
grant execute on function public.replay_pos_outbox_event(uuid) to service_role;
commit;
-- Rollback: revoke new RPCs first. Preserve payment, inbox, outbox, delivery, idempotency and audit evidence; drop additive columns only after retention review.
