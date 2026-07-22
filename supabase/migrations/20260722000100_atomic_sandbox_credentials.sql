-- Store the non-production demo credentials in one transaction. Any failed prerequisite or
-- write raises an exception and PostgreSQL rolls the entire function call back.
begin;

create or replace function public.store_sandbox_credentials(
  p_partner_id text,
  p_key_prefix text,
  p_key_hash text,
  p_encrypted_request_signing_secret text,
  p_encrypted_connector_configuration text,
  p_encrypted_webhook_secret text
) returns table(
  api_key_hash_stored boolean,
  request_signing_secret_stored boolean,
  connector_configuration_count integer,
  webhook_secret_count integer,
  webhook_secret_stored boolean
)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_api_key_id uuid;
  v_connection_count integer;
  v_webhook_count integer;
  v_api_key_hash_stored boolean;
  v_request_signing_secret_stored boolean;
  v_webhook_secret_stored boolean;
begin
  if p_partner_id <> 'ptr_sandbox_demo' then
    raise exception using errcode='P0001',message='sandbox_partner_required';
  end if;
  if p_key_prefix is null or p_key_hash is null or p_encrypted_request_signing_secret is null
     or p_encrypted_connector_configuration is null or p_encrypted_webhook_secret is null then
    raise exception using errcode='P0001',message='sandbox_credentials_incomplete';
  end if;

  perform pg_advisory_xact_lock(hashtext('restec.store_sandbox_credentials'));

  perform 1 from public.partners
  where id=p_partner_id and status='active';
  if not found then
    raise exception using errcode='P0001',message='sandbox_partner_seed_missing';
  end if;

  select count(*)::integer into v_connection_count
  from public.pos_connections
  where id in ('con_sandbox_canonical','con_sandbox_mock')
    and partner_id=p_partner_id and environment='sandbox' and status='active';
  if v_connection_count <> 2 then
    raise exception using errcode='P0001',message='sandbox_connection_seed_missing';
  end if;

  select count(*)::integer into v_webhook_count
  from public.webhook_endpoints
  where connection_id='con_sandbox_canonical' and status='active';
  if v_webhook_count <> 1 then
    raise exception using errcode='P0001',message='sandbox_webhook_seed_invalid';
  end if;

  insert into public.api_keys(
    partner_id,environment,key_prefix,key_hash,status,encrypted_signing_secret
  ) values(
    p_partner_id,'sandbox',p_key_prefix,p_key_hash,'active',p_encrypted_request_signing_secret
  ) returning id into v_api_key_id;

  update public.pos_connections
  set encrypted_configuration=p_encrypted_connector_configuration,updated_at=now()
  where id in ('con_sandbox_canonical','con_sandbox_mock')
    and partner_id=p_partner_id and environment='sandbox' and status='active';
  get diagnostics v_connection_count=row_count;
  if v_connection_count <> 2 then
    raise exception using errcode='P0001',message='sandbox_connector_update_incomplete';
  end if;

  update public.webhook_endpoints
  set encrypted_signing_secret=p_encrypted_webhook_secret,updated_at=now()
  where connection_id='con_sandbox_canonical' and status='active';
  get diagnostics v_webhook_count=row_count;
  if v_webhook_count <> 1 then
    raise exception using errcode='P0001',message='sandbox_webhook_update_incomplete';
  end if;

  select
    ak.key_hash=p_key_hash,
    ak.encrypted_signing_secret=p_encrypted_request_signing_secret
  into v_api_key_hash_stored,v_request_signing_secret_stored
  from public.api_keys ak where ak.id=v_api_key_id;

  select we.encrypted_signing_secret=p_encrypted_webhook_secret
  into v_webhook_secret_stored
  from public.webhook_endpoints we
  where we.connection_id='con_sandbox_canonical' and we.status='active';

  return query select
    v_api_key_hash_stored,
    v_request_signing_secret_stored,
    v_connection_count,
    v_webhook_count,
    v_webhook_secret_stored;
end
$$;

revoke all on function public.store_sandbox_credentials(text,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.store_sandbox_credentials(text,text,text,text,text,text)
  to service_role;

commit;

-- Rollback: revoke and drop store_sandbox_credentials(text,text,text,text,text,text). Preserve
-- issued API-key rows and encrypted sandbox connector/webhook values unless explicitly revoked.
