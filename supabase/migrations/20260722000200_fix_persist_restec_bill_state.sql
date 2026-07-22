-- Fix the bill-state insert projection. The previous function placed the full JSONB state in
-- payment_status and placed reconciliation_status text in public_state, causing PostgreSQL 42804
-- after Paely had already committed the bill.
begin;

create or replace function public.persist_restec_bill_state(
  p_connection_id text,
  p_external_bill_id text,
  p_public_bill_id text,
  p_private_reference text,
  p_version integer,
  p_request_hash text,
  p_public_state jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_existing public.bill_mappings%rowtype;
begin
  select * into v_existing
  from public.bill_mappings
  where connection_id=p_connection_id
    and external_bill_id=p_external_bill_id
  for update;

  if found then
    if p_version < v_existing.current_version then
      raise exception using errcode='P0001',message='bill_version_conflict';
    end if;
    if p_version = v_existing.current_version
       and p_request_hash <> v_existing.last_request_hash then
      raise exception using errcode='P0001',message='bill_version_conflict';
    end if;
    if p_version = v_existing.current_version then
      return v_existing.public_state;
    end if;
    if coalesce((p_public_state->>'grand_total')::integer,0)
       < coalesce((v_existing.public_state->>'amount_paid')::integer,0)
         - coalesce((v_existing.public_state->>'amount_refunded')::integer,0) then
      raise exception using errcode='P0001',message='amount_mismatch';
    end if;

    update public.bill_mappings
    set current_version=p_version,
        last_request_hash=p_request_hash,
        public_state=p_public_state,
        payment_status=p_public_state->>'payment_status',
        reconciliation_status=coalesce(p_public_state->>'reconciliation_status','pending'),
        updated_at=now()
    where id=v_existing.id;
  else
    insert into public.bill_mappings(
      connection_id,
      external_bill_id,
      public_restec_bill_id,
      private_paely_bill_reference,
      current_version,
      last_request_hash,
      payment_status,
      reconciliation_status,
      public_state
    ) values(
      p_connection_id,
      p_external_bill_id,
      p_public_bill_id,
      p_private_reference,
      p_version,
      p_request_hash,
      p_public_state->>'payment_status',
      coalesce(p_public_state->>'reconciliation_status','pending'),
      p_public_state
    );
  end if;

  return p_public_state;
end
$$;

revoke all on function public.persist_restec_bill_state(text,text,text,text,integer,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.persist_restec_bill_state(text,text,text,text,integer,text,jsonb)
  to service_role;

commit;

-- Rollback: restore the preceding function definition only as part of a controlled application
-- rollback. Do not remove bill mappings already committed by this corrected function.
