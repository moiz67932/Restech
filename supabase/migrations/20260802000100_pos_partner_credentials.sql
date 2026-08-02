-- Partner credential governance and atomic operator provisioning.
begin;

alter table public.locations
  add column if not exists external_location_id text;

create unique index if not exists locations_external_reference_idx
  on public.locations(restaurant_id, environment, external_location_id)
  where external_location_id is not null;

alter table public.api_keys
  add column if not exists scopes text[],
  add column if not exists location_scopes text[],
  add column if not exists credential_version integer,
  add column if not exists grace_ends_at timestamptz,
  add column if not exists rotated_from uuid references public.api_keys(id) on delete restrict,
  add column if not exists allowed_ip_cidrs text[] not null default '{}',
  add column if not exists mtls_subjects text[] not null default '{}';

update public.api_keys k
set scopes = array[
  'bills:read','bills:write','payments:write',
  'payment_sessions:read','payment_sessions:write','tables:read'
]::text[]
where scopes is null or cardinality(scopes)=0;

update public.api_keys k
set location_scopes = coalesce((
  select array_agg(l.id order by l.id)
  from public.locations l
  join public.restaurants r on r.id=l.restaurant_id
  where r.partner_id=k.partner_id and l.environment=k.environment
), '{}'::text[])
where location_scopes is null or cardinality(location_scopes)=0;

with numbered as (
  select id,row_number() over(partition by partner_id,environment order by created_at,id)::integer as version
  from public.api_keys
)
update public.api_keys k set credential_version=n.version
from numbered n where n.id=k.id and k.credential_version is null;

alter table public.api_keys
  alter column scopes set not null,
  alter column location_scopes set not null,
  alter column credential_version set not null;

create unique index if not exists api_keys_partner_environment_version_idx
  on public.api_keys(partner_id,environment,credential_version);

create or replace function public.default_api_key_access_scope()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.scopes is null or cardinality(new.scopes)=0 then
    new.scopes := array[
      'bills:read','bills:write','payments:write',
      'payment_sessions:read','payment_sessions:write','tables:read'
    ]::text[];
  end if;
  if new.location_scopes is null or cardinality(new.location_scopes)=0 then
    select coalesce(array_agg(l.id order by l.id),'{}'::text[]) into new.location_scopes
    from public.locations l join public.restaurants r on r.id=l.restaurant_id
    where r.partner_id=new.partner_id and l.environment=new.environment;
  end if;
  if new.credential_version is null then
    select coalesce(max(k.credential_version),0)+1 into new.credential_version
    from public.api_keys k
    where k.partner_id=new.partner_id and k.environment=new.environment;
  end if;
  return new;
end $$;

drop trigger if exists api_keys_default_access_scope on public.api_keys;
create trigger api_keys_default_access_scope before insert on public.api_keys
for each row execute function public.default_api_key_access_scope();

create table if not exists public.partner_integration_profiles(
  partner_id text not null references public.partners(id) on delete restrict,
  environment public.restec_environment not null,
  technical_contacts jsonb not null default '[]'::jsonb,
  allowed_ip_requirements text[] not null default '{}',
  mtls_details jsonb,
  inbound_auth_details jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(partner_id,environment)
);
alter table public.partner_integration_profiles enable row level security;
revoke all on public.partner_integration_profiles from anon,authenticated;

create or replace function public.provision_pos_partner(
  p_partner_id text,
  p_partner_name text,
  p_restaurant_id text,
  p_restaurant_name text,
  p_location_id text,
  p_location_name text,
  p_external_location_id text,
  p_environment public.restec_environment,
  p_connection_id text,
  p_private_location_reference uuid,
  p_private_connection_reference uuid,
  p_key_prefix text,
  p_key_hash text,
  p_encrypted_request_signing_secret text,
  p_scopes text[],
  p_expires_at timestamptz,
  p_encrypted_connector_configuration text,
  p_callback_url text,
  p_encrypted_webhook_secret text,
  p_technical_contacts jsonb,
  p_allowed_ip_requirements text[],
  p_mtls_details jsonb,
  p_inbound_auth_details jsonb
) returns table(
  partner_id text,
  restaurant_id text,
  location_id text,
  connection_id text,
  credential_version integer
)
language plpgsql security definer set search_path=public as $$
declare v_version integer;
begin
  if p_callback_url !~ '^https://' or p_scopes is null or cardinality(p_scopes)=0 then
    raise exception using errcode='P0001',message='invalid_partner_provisioning_input';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_partner_id||':'||p_environment::text));
  insert into public.partners(id,name,status) values(p_partner_id,p_partner_name,'active')
    on conflict(id) do nothing;
  insert into public.restaurants(id,partner_id,name)
    values(p_restaurant_id,p_partner_id,p_restaurant_name);
  insert into public.locations(
    id,restaurant_id,environment,name,external_location_id,private_location_reference
  ) values(
    p_location_id,p_restaurant_id,p_environment,p_location_name,
    p_external_location_id,p_private_location_reference
  );
  insert into public.pos_connections(
    id,partner_id,location_id,environment,connector_type,connector_version,
    encrypted_configuration,status,private_connection_reference
  ) values(
    p_connection_id,p_partner_id,p_location_id,p_environment,'canonical_rest','1.0.0',
    p_encrypted_connector_configuration,'active',p_private_connection_reference
  );
  insert into public.webhook_endpoints(
    connection_id,url,encrypted_signing_secret,status
  ) values(p_connection_id,p_callback_url,p_encrypted_webhook_secret,'active');
  select coalesce(max(k.credential_version),0)+1 into v_version
  from public.api_keys k where k.partner_id=p_partner_id and k.environment=p_environment;
  insert into public.api_keys(
    partner_id,environment,key_prefix,key_hash,status,encrypted_signing_secret,
    scopes,location_scopes,credential_version,expires_at,
    allowed_ip_cidrs,mtls_subjects
  ) values(
    p_partner_id,p_environment,p_key_prefix,p_key_hash,'active',
    p_encrypted_request_signing_secret,p_scopes,array[p_location_id],v_version,p_expires_at,
    coalesce(p_allowed_ip_requirements,'{}'::text[]),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_mtls_details->'subjects','[]'::jsonb))),'{}'::text[])
  );
  insert into public.partner_integration_profiles(
    partner_id,environment,technical_contacts,allowed_ip_requirements,mtls_details,inbound_auth_details
  ) values(
    p_partner_id,p_environment,coalesce(p_technical_contacts,'[]'::jsonb),
    coalesce(p_allowed_ip_requirements,'{}'::text[]),p_mtls_details,p_inbound_auth_details
  ) on conflict(partner_id,environment) do update set
    technical_contacts=excluded.technical_contacts,
    allowed_ip_requirements=excluded.allowed_ip_requirements,
    mtls_details=excluded.mtls_details,
    inbound_auth_details=excluded.inbound_auth_details,
    updated_at=now();
  return query select p_partner_id,p_restaurant_id,p_location_id,p_connection_id,v_version;
end $$;

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
) returns integer
language plpgsql security definer set search_path=public as $$
declare v_version integer; v_rotated_from uuid;
begin
  if p_grace_seconds<0 or p_grace_seconds>604800 then
    raise exception using errcode='P0001',message='invalid_rotation_grace';
  end if;
  if exists(
    select 1 from unnest(p_location_scopes) scope(location_id)
    where not exists(
      select 1 from public.locations l join public.restaurants r on r.id=l.restaurant_id
      where l.id=scope.location_id and r.partner_id=p_partner_id and l.environment=p_environment
    )
  ) then raise exception using errcode='P0001',message='invalid_location_scope'; end if;
  perform pg_advisory_xact_lock(hashtext(p_partner_id||':'||p_environment::text));
  select id into v_rotated_from from public.api_keys
  where partner_id=p_partner_id and environment=p_environment and status='active'
  order by credential_version desc limit 1;
  if v_rotated_from is null then
    raise exception using errcode='P0001',message='active_credential_not_found';
  end if;
  update public.api_keys set status='overlap',grace_ends_at=now()+make_interval(secs=>p_grace_seconds)
  where partner_id=p_partner_id and environment=p_environment and status='active';
  select coalesce(max(credential_version),0)+1 into v_version from public.api_keys
  where partner_id=p_partner_id and environment=p_environment;
  insert into public.api_keys(
    partner_id,environment,key_prefix,key_hash,status,encrypted_signing_secret,
    scopes,location_scopes,credential_version,expires_at,rotated_from
  ) values(
    p_partner_id,p_environment,p_key_prefix,p_key_hash,'active',
    p_encrypted_request_signing_secret,p_scopes,p_location_scopes,v_version,p_expires_at,
    v_rotated_from
  );
  return v_version;
end $$;

create or replace function public.revoke_pos_partner_credential(p_key_prefix text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.api_keys set status='revoked',revoked_at=now(),grace_ends_at=null
  where key_prefix=p_key_prefix and status<>'revoked';
  return found;
end $$;

revoke all on function public.provision_pos_partner(
  text,text,text,text,text,text,text,public.restec_environment,text,uuid,uuid,text,text,text,text[],timestamptz,text,text,text,jsonb,text[],jsonb,jsonb
) from public,anon,authenticated;
revoke all on function public.rotate_pos_partner_credential(
  text,public.restec_environment,text,text,text,text[],text[],timestamptz,integer
) from public,anon,authenticated;
revoke all on function public.revoke_pos_partner_credential(text) from public,anon,authenticated;
grant execute on function public.provision_pos_partner(
  text,text,text,text,text,text,text,public.restec_environment,text,uuid,uuid,text,text,text,text[],timestamptz,text,text,text,jsonb,text[],jsonb,jsonb
) to service_role;
grant execute on function public.rotate_pos_partner_credential(
  text,public.restec_environment,text,text,text,text[],text[],timestamptz,integer
) to service_role;
grant execute on function public.revoke_pos_partner_credential(text) to service_role;

commit;

-- Rollback must preserve issued credential/audit rows. Revoke the operator functions first,
-- disable affected credentials, then remove additive metadata only after retention approval.
