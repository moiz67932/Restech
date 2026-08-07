-- Phase 6: additive webhook secret versioning and stable outbox binding.
-- Existing endpoint ciphertext is copied as-is. This migration never decrypts,
-- rewrites, revokes, or replaces an existing secret.
begin;

create table if not exists public.webhook_secret_versions(
  id uuid primary key default gen_random_uuid(),
  connection_id text not null references public.pos_connections(id) on delete restrict,
  version integer not null check(version > 0),
  encrypted_secret text not null,
  status text not null check(status in ('pending','active','grace','retired','revoked')),
  valid_from timestamptz not null default now(),
  grace_until timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(connection_id,version)
);
create unique index if not exists webhook_secret_versions_one_active
  on public.webhook_secret_versions(connection_id) where status='active';
create index if not exists webhook_secret_versions_delivery_lookup
  on public.webhook_secret_versions(connection_id,version,status);
alter table public.webhook_secret_versions enable row level security;
revoke all on public.webhook_secret_versions from anon,authenticated;

alter table public.pos_outbox_events
  add column if not exists signing_secret_version integer;

insert into public.webhook_secret_versions(connection_id,version,encrypted_secret,status,valid_from)
select connection_id,1,encrypted_signing_secret,'active',created_at
from public.webhook_endpoints
where status='active'
on conflict(connection_id,version) do nothing;

update public.pos_outbox_events
set signing_secret_version=1
where signing_secret_version is null;
alter table public.pos_outbox_events
  alter column signing_secret_version set default 1,
  alter column signing_secret_version set not null;
alter table public.pos_outbox_events
  add constraint pos_outbox_signing_secret_version_positive
  check(signing_secret_version > 0) not valid;
alter table public.pos_outbox_events validate constraint pos_outbox_signing_secret_version_positive;

create or replace function public.bind_outbox_webhook_secret_version()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.signing_secret_version is null then
    select version into new.signing_secret_version
    from public.webhook_secret_versions
    where connection_id=new.connection_id and status='active'
    order by version desc limit 1;
  end if;
  if new.signing_secret_version is null then
    raise exception using errcode='P0001',message='webhook_secret_not_configured';
  end if;
  return new;
end $$;
drop trigger if exists pos_outbox_bind_webhook_secret_version on public.pos_outbox_events;
create trigger pos_outbox_bind_webhook_secret_version
before insert on public.pos_outbox_events
for each row execute function public.bind_outbox_webhook_secret_version();

create or replace function public.rotate_webhook_secret(
  p_connection_id text,
  p_encrypted_secret text,
  p_grace_seconds integer default 86400
) returns integer language plpgsql security definer set search_path=public as $$
declare v_previous integer; v_next integer; v_until timestamptz;
begin
  if p_encrypted_secret is null or p_grace_seconds<0 or p_grace_seconds>604800 then
    raise exception using errcode='P0001',message='invalid_webhook_rotation_input';
  end if;
  perform pg_advisory_xact_lock(hashtext('restec.webhook:'||p_connection_id));
  select version into v_previous from public.webhook_secret_versions
  where connection_id=p_connection_id and status in ('active','grace')
  order by version desc limit 1;
  if v_previous is null then
    raise exception using errcode='P0001',message='active_webhook_secret_not_found';
  end if;
  v_until := now()+make_interval(secs=>p_grace_seconds);
  update public.webhook_secret_versions
  set status='grace',grace_until=v_until
  where connection_id=p_connection_id and version=v_previous and status='active';
  select coalesce(max(version),0)+1 into v_next
  from public.webhook_secret_versions where connection_id=p_connection_id;
  insert into public.webhook_secret_versions(connection_id,version,encrypted_secret,status,valid_from)
  values(p_connection_id,v_next,p_encrypted_secret,'active',now());
  insert into public.audit_logs(actor_type,connection_id,action,result,target_type,target_id,metadata)
  values('operator',p_connection_id,'webhook_secret_rotated','accepted','webhook_secret_version',p_connection_id||':'||v_next,
    jsonb_build_object('previous_version',v_previous,'new_version',v_next,'grace_seconds',p_grace_seconds));
  return v_next;
end $$;

create or replace function public.revoke_webhook_secret(p_connection_id text,p_version integer)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.webhook_secret_versions
  set status='revoked',revoked_at=now(),grace_until=null
  where connection_id=p_connection_id and version=p_version and status<>'revoked';
  if not found then return false; end if;
  insert into public.audit_logs(actor_type,connection_id,action,result,target_type,target_id,metadata)
  values('operator',p_connection_id,'webhook_secret_emergency_revoked','accepted','webhook_secret_version',p_connection_id||':'||p_version,
    jsonb_build_object('version',p_version));
  return true;
end $$;

create or replace function public.expire_webhook_secret_grace()
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  update public.webhook_secret_versions
  set status='retired',retired_at=now()
  where status='grace' and grace_until is not null and grace_until<=now();
  get diagnostics v_count=row_count;
  return v_count;
end $$;

-- API rotation is deliberately scope-preserving. Scope changes require a
-- separate, reviewed operation and are never smuggled into key replacement.
create or replace function public.rotate_pos_partner_credential(
  p_partner_id text,
  p_environment public.restec_environment,
  p_key_prefix text,
  p_key_hash text,
  p_encrypted_request_signing_secret text,
  p_scopes text[],
  p_location_scopes text[],
  p_expires_at timestamptz,
  p_grace_seconds integer default 86400
) returns integer language plpgsql security definer set search_path=public as $$
declare v_version integer; v_rotated_from uuid; v_scopes text[]; v_locations text[];
begin
  if p_grace_seconds<0 or p_grace_seconds>604800 then
    raise exception using errcode='P0001',message='invalid_rotation_grace';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_partner_id||':'||p_environment::text));
  select id,scopes,location_scopes into v_rotated_from,v_scopes,v_locations
  from public.api_keys
  where partner_id=p_partner_id and environment=p_environment and status='active'
  order by credential_version desc limit 1;
  if v_rotated_from is null then
    raise exception using errcode='P0001',message='active_credential_not_found';
  end if;
  update public.api_keys set status='overlap',grace_ends_at=now()+make_interval(secs=>p_grace_seconds)
  where id=v_rotated_from;
  select coalesce(max(credential_version),0)+1 into v_version
  from public.api_keys where partner_id=p_partner_id and environment=p_environment;
  insert into public.api_keys(
    partner_id,environment,key_prefix,key_hash,status,encrypted_signing_secret,
    scopes,location_scopes,credential_version,expires_at,rotated_from
  ) values(
    p_partner_id,p_environment,p_key_prefix,p_key_hash,'active',p_encrypted_request_signing_secret,
    v_scopes,v_locations,v_version,p_expires_at,v_rotated_from
  );
  insert into public.audit_logs(actor_type,partner_id,action,result,target_type,target_id,metadata)
  values('operator',p_partner_id,'api_credential_rotated','accepted','api_key',p_key_prefix,
    jsonb_build_object('version',v_version,'previous_key_id',v_rotated_from,'grace_seconds',p_grace_seconds));
  return v_version;
end $$;

create or replace function public.revoke_pos_partner_credential(p_key_prefix text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_partner text; v_id uuid;
begin
  update public.api_keys set status='revoked',revoked_at=now(),grace_ends_at=null
  where key_prefix=p_key_prefix and status<>'revoked'
  returning id,partner_id into v_id,v_partner;
  if not found then return false; end if;
  insert into public.audit_logs(actor_type,partner_id,action,result,target_type,target_id,metadata)
  values('operator',v_partner,'api_credential_revoked','accepted','api_key',p_key_prefix,
    jsonb_build_object('key_id',v_id));
  return true;
end $$;

revoke all on function public.rotate_webhook_secret(text,text,integer) from public,anon,authenticated;
revoke all on function public.revoke_webhook_secret(text,integer) from public,anon,authenticated;
grant execute on function public.rotate_webhook_secret(text,text,integer) to service_role;
grant execute on function public.revoke_webhook_secret(text,integer) to service_role;
revoke all on function public.expire_webhook_secret_grace() from public,anon,authenticated;
grant execute on function public.expire_webhook_secret_grace() to service_role;

commit;

-- Rollback: revoke operator functions first. Preserve version rows and outbox
-- binding evidence; remove additive columns only after retention approval.
