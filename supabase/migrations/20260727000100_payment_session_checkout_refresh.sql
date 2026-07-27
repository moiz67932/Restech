-- Serialize on-demand Paely checkout-token refreshes per Restec payment session.
-- The lease never changes financial state or provider identity.
begin;

alter table public.payment_sessions
  add column if not exists checkout_refresh_lock_token uuid,
  add column if not exists checkout_refresh_lock_expires_at timestamptz;

alter table public.payment_sessions
  drop constraint if exists payment_sessions_checkout_refresh_lease_pair;
alter table public.payment_sessions
  add constraint payment_sessions_checkout_refresh_lease_pair check (
    (checkout_refresh_lock_token is null) =
    (checkout_refresh_lock_expires_at is null)
  );

create or replace function public.claim_payment_session_checkout_refresh(
  p_public_payment_session_id text,
  p_lock_token uuid,
  p_lease_seconds integer
) returns setof public.payment_sessions
language sql
security definer
set search_path = public
as $$
  update public.payment_sessions
  set checkout_refresh_lock_token = p_lock_token,
      checkout_refresh_lock_expires_at =
        now() + make_interval(secs => greatest(5, least(p_lease_seconds, 120))),
      updated_at = now()
  where public_payment_session_id = p_public_payment_session_id
    and status = 'requires_customer_action'
    and expires_at > now()
    and private_payment_session_reference is not null
    and (
      checkout_refresh_lock_token is null
      or checkout_refresh_lock_expires_at <= now()
    )
  returning *;
$$;

create or replace function public.complete_payment_session_checkout_refresh(
  p_public_payment_session_id text,
  p_private_payment_session_reference text,
  p_lock_token uuid,
  p_encrypted_provider_checkout_url text,
  p_provider_checkout_host text
) returns setof public.payment_sessions
language sql
security definer
set search_path = public
as $$
  update public.payment_sessions
  set encrypted_provider_checkout_url = p_encrypted_provider_checkout_url,
      provider_checkout_host = lower(p_provider_checkout_host),
      checkout_refresh_lock_token = null,
      checkout_refresh_lock_expires_at = null,
      updated_at = now()
  where public_payment_session_id = p_public_payment_session_id
    and private_payment_session_reference = p_private_payment_session_reference
    and status = 'requires_customer_action'
    and expires_at > now()
    and checkout_refresh_lock_token = p_lock_token
    and p_encrypted_provider_checkout_url <> ''
    and p_provider_checkout_host <> ''
  returning *;
$$;

create or replace function public.release_payment_session_checkout_refresh(
  p_public_payment_session_id text,
  p_lock_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.payment_sessions
  set checkout_refresh_lock_token = null,
      checkout_refresh_lock_expires_at = null,
      updated_at = now()
  where public_payment_session_id = p_public_payment_session_id
    and checkout_refresh_lock_token = p_lock_token;
  return found;
end;
$$;

revoke all on function public.claim_payment_session_checkout_refresh(text,uuid,integer)
  from public;
revoke all on function public.complete_payment_session_checkout_refresh(text,text,uuid,text,text)
  from public;
revoke all on function public.release_payment_session_checkout_refresh(text,uuid)
  from public;
grant execute on function public.claim_payment_session_checkout_refresh(text,uuid,integer)
  to service_role;
grant execute on function public.complete_payment_session_checkout_refresh(text,text,uuid,text,text)
  to service_role;
grant execute on function public.release_payment_session_checkout_refresh(text,uuid)
  to service_role;

commit;

-- Rollback only after disabling payment-session redirects: drop the three functions,
-- then drop the lease constraint and the two checkout_refresh_* columns. Preserve
-- encrypted checkout URLs and all payment-session financial evidence.
