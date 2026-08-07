begin;

alter table public.table_mappings add column if not exists qr_token_hash text;
alter table public.table_mappings add column if not exists qr_environment public.restec_environment;
alter table public.table_mappings add column if not exists qr_version integer not null default 0;
alter table public.table_mappings add column if not exists qr_rotated_at timestamptz;
create unique index if not exists table_mappings_qr_token_unique
  on public.table_mappings(qr_token_hash) where qr_token_hash is not null;

create table if not exists public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  connection_id text not null references public.pos_connections(id) on delete restrict,
  location_id text not null references public.locations(id) on delete restrict,
  table_mapping_id uuid not null references public.table_mappings(id) on delete restrict,
  bill_mapping_id uuid not null references public.bill_mappings(id) on delete restrict,
  restec_table_id text not null references public.pos_tables(id) on delete restrict,
  external_table_id text not null,
  external_bill_id text not null,
  environment public.restec_environment not null,
  generation integer not null,
  status text not null check(status in ('active','closed','cancelled','superseded')),
  opened_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  unique(connection_id, external_bill_id, generation)
);
create unique index if not exists table_sessions_one_active_table
  on public.table_sessions(connection_id, restec_table_id) where status='active';
create unique index if not exists table_sessions_one_active_bill
  on public.table_sessions(connection_id, external_bill_id) where status='active';

create table if not exists public.customer_table_visits (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  table_session_id uuid not null references public.table_sessions(id) on delete restrict,
  environment public.restec_environment not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create or replace function public.sync_table_lifecycle(
  p_connection_id text, p_location_id text, p_environment public.restec_environment,
  p_external_table_id text, p_external_bill_id text, p_terminal boolean
) returns void language plpgsql security definer set search_path=public as $$
declare v_table public.table_mappings%rowtype; v_bill public.bill_mappings%rowtype; v_prior public.table_sessions%rowtype; v_next_generation integer;
begin
  select * into v_table from public.table_mappings where connection_id=p_connection_id and external_table_id=p_external_table_id and active=true for update;
  if not found then raise exception using errcode='P0001', message='resource_not_found'; end if;
  select * into v_bill from public.bill_mappings where connection_id=p_connection_id and external_bill_id=p_external_bill_id;
  if not found then raise exception using errcode='P0001', message='resource_not_found'; end if;
  if p_terminal and exists (
    select 1 from public.financial_reservations
    where bill_mapping_id=v_bill.id and state in ('reserved','ambiguous_pending_reconciliation')
  ) then raise exception using errcode='P0001',message='payment_in_progress'; end if;
  select * into v_prior from public.table_sessions where connection_id=p_connection_id and external_bill_id=p_external_bill_id order by opened_at desc limit 1 for update;
  if found and v_prior.status in ('closed','cancelled') and not p_terminal then raise exception using errcode='P0001',message='bill_table_generation_conflict'; end if;
  if p_terminal then
    update public.table_sessions set status='closed', ended_at=now(), end_reason='bill_terminal'
      where connection_id=p_connection_id and external_bill_id=p_external_bill_id and status='active';
    return;
  end if;
  if exists(select 1 from public.table_sessions where connection_id=p_connection_id and restec_table_id=v_table.restec_table_id and status='active' and external_bill_id<>p_external_bill_id) then
    raise exception using errcode='P0001',message='table_active_bill_conflict';
  end if;
  update public.table_sessions set status='superseded', ended_at=now(), end_reason='table_move'
    where connection_id=p_connection_id and external_bill_id=p_external_bill_id and status='active' and restec_table_id<>v_table.restec_table_id;
  if not exists(select 1 from public.table_sessions where connection_id=p_connection_id and external_bill_id=p_external_bill_id and restec_table_id=v_table.restec_table_id and status='active') then
    select coalesce(max(generation),0)+1 into v_next_generation from public.table_sessions where connection_id=p_connection_id and restec_table_id=v_table.restec_table_id;
    insert into public.table_sessions(connection_id,location_id,table_mapping_id,bill_mapping_id,restec_table_id,external_table_id,external_bill_id,environment,generation,status)
    values(p_connection_id,p_location_id,v_table.id,v_bill.id,v_table.restec_table_id,p_external_table_id,p_external_bill_id,p_environment,v_next_generation,'active');
  end if;
end $$;
revoke all on function public.sync_table_lifecycle(text,text,public.restec_environment,text,text,boolean) from public;
grant execute on function public.sync_table_lifecycle(text,text,public.restec_environment,text,text,boolean) to service_role;
alter table public.table_sessions enable row level security;
alter table public.customer_table_visits enable row level security;
commit;

-- Rollback: disable QR resolution first. Preserve table_sessions and customer_table_visits for
-- audit/privacy investigation; forward-fix mappings or revoke tokens rather than dropping history.
