begin;

create table public.reconciliation_cases (
  case_id text primary key check (case_id ~ '^rc_'),
  logical_identity text not null,
  environment public.restec_environment not null,
  partner_id text not null references public.partners(id) on delete restrict,
  location_id text not null references public.locations(id) on delete restrict,
  connection_id text not null references public.pos_connections(id) on delete restrict,
  subject_type text not null,
  subject_id text not null,
  case_type text not null,
  severity text not null check (severity in ('critical','high','medium','low')),
  status text not null check (status in ('open','auto_repair_pending','manual_review_required','in_progress','resolved','quarantined','dismissed_with_evidence')),
  detected_at timestamptz not null,
  first_detected_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  restec_state_snapshot jsonb not null default '{}',
  provider_state_snapshot jsonb,
  pos_delivery_state_snapshot jsonb,
  immutable_financial_evidence jsonb,
  difference_summary jsonb not null default '{}',
  recommended_action text not null,
  automatic_action_allowed boolean not null default false,
  assigned_to text,
  resolution text,
  resolution_evidence jsonb,
  resolved_at timestamptz,
  created_by text not null,
  last_action_id text,
  created_at timestamptz not null default now()
);
create unique index reconciliation_active_identity_idx on public.reconciliation_cases(logical_identity)
  where status not in ('resolved','dismissed_with_evidence');
create index reconciliation_scan_idx on public.reconciliation_cases(status,last_checked_at);
create index reconciliation_scope_idx on public.reconciliation_cases(environment,location_id,case_type);

create table public.reconciliation_actions (
  action_id text primary key check (action_id ~ '^ra_'),
  case_id text not null references public.reconciliation_cases(case_id) on delete restrict,
  action_type text not null,
  idempotency_identity text not null unique,
  requested_by text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  result text not null,
  error text,
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index reconciliation_actions_case_idx on public.reconciliation_actions(case_id,started_at desc);
alter table public.reconciliation_cases enable row level security;
alter table public.reconciliation_actions enable row level security;

create or replace function public.upsert_reconciliation_case(p_case jsonb)
returns public.reconciliation_cases language plpgsql security definer set search_path=public as $$
declare v public.reconciliation_cases;
begin
  insert into reconciliation_cases(case_id,logical_identity,environment,partner_id,location_id,connection_id,subject_type,subject_id,case_type,severity,status,detected_at,restec_state_snapshot,provider_state_snapshot,pos_delivery_state_snapshot,immutable_financial_evidence,difference_summary,recommended_action,automatic_action_allowed,assigned_to,created_by)
  values ('rc_'||substr(encode(digest(p_case->>'logical_identity','sha256'),'hex'),1,24),p_case->>'logical_identity',(p_case->>'environment')::restec_environment,p_case->>'partner_id',p_case->>'location_id',p_case->>'connection_id',p_case->>'subject_type',p_case->>'subject_id',p_case->>'case_type',p_case->>'severity',p_case->>'status',(p_case->>'detected_at')::timestamptz,p_case->'restec_state_snapshot',p_case->'provider_state_snapshot',p_case->'pos_delivery_state_snapshot',p_case->'immutable_financial_evidence',p_case->'difference_summary',p_case->>'recommended_action',(p_case->>'automatic_action_allowed')::boolean,p_case->>'assigned_to',p_case->>'created_by')
  on conflict (logical_identity) where status not in ('resolved','dismissed_with_evidence') do update set last_checked_at=now(), occurrence_count=reconciliation_cases.occurrence_count+1, detected_at=excluded.detected_at, restec_state_snapshot=excluded.restec_state_snapshot, provider_state_snapshot=excluded.provider_state_snapshot, difference_summary=excluded.difference_summary
  returning * into v;
  return v;
end $$;
revoke all on function public.upsert_reconciliation_case(jsonb) from public,anon,authenticated;
grant execute on function public.upsert_reconciliation_case(jsonb) to service_role;

commit;

-- Rollback: disable reconciliation workers, retain cases/actions for audit, then remove only after retention approval.
