-- Phase 5: additive immutable financial-correction ledger.
-- Corrections are facts after payment completion; the payment row is never edited.
begin;

create table if not exists public.financial_corrections (
  id uuid primary key default gen_random_uuid(),
  correction_id text not null unique check (correction_id ~ '^cor_'),
  logical_identity text not null unique,
  type text not null check (type in ('refund','void','reversal','chargeback','dispute')),
  status text not null check (status in ('completed','ambiguous','review_required')),
  connection_id uuid not null references public.pos_connections(id) on delete restrict,
  external_bill_id text not null,
  original_payment_id text not null,
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 2147483647),
  currency text not null,
  authority text not null check (authority = 'provider'),
  source text not null check (source = 'provider_event'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.financial_corrections enable row level security;
revoke all on public.financial_corrections from anon, authenticated;
create index if not exists financial_corrections_bill_idx
  on public.financial_corrections(connection_id, external_bill_id, occurred_at);

create or replace function public.record_provider_correction(
  p_correction_id text, p_logical_identity text, p_type text, p_status text,
  p_connection_id text, p_external_bill_id text, p_original_payment_id text,
  p_amount_minor bigint, p_currency text, p_occurred_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_existing financial_corrections%rowtype;
  v_bill bill_mappings%rowtype;
  v_prior bigint;
  v_status text := p_status;
  v_refunded bigint;
  v_state jsonb;
begin
  select * into v_existing from financial_corrections
    where logical_identity=p_logical_identity for update;
  if found then
    select * into v_bill from bill_mappings
      where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
    if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
    return jsonb_build_object('duplicate',true,'bill',v_bill.public_state);
  end if;
  select * into v_bill from bill_mappings
    where connection_id=p_connection_id and external_bill_id=p_external_bill_id for update;
  if not found then raise exception using errcode='P0001',message='resource_not_found'; end if;
  if v_bill.public_state->>'currency' <> p_currency then
    raise exception using errcode='P0001',message='amount_mismatch';
  end if;
  select coalesce(sum(amount_minor),0) into v_prior from financial_corrections
    where connection_id=p_connection_id and external_bill_id=p_external_bill_id
      and type='refund' and status='completed';
  if p_type='refund' and (p_status<>'completed' or v_prior+p_amount_minor>coalesce((v_bill.public_state->>'amount_paid')::bigint,0)) then
    v_status := 'review_required';
  end if;
  insert into financial_corrections(
    correction_id,logical_identity,type,status,connection_id,external_bill_id,
    original_payment_id,amount_minor,currency,authority,source,occurred_at
  ) values(
    p_correction_id,p_logical_identity,p_type,v_status,p_connection_id,p_external_bill_id,
    p_original_payment_id,p_amount_minor,p_currency,'provider','provider_event',p_occurred_at
  );
  v_refunded := v_prior + case when p_type='refund' and v_status='completed' then p_amount_minor else 0 end;
  v_state := v_bill.public_state;
  if p_type='refund' and v_status='completed' then
    v_state := v_state || jsonb_build_object(
      'amount_refunded',v_refunded,
      'amount_due',greatest(0,(v_bill.public_state->>'grand_total')::bigint-(v_bill.public_state->>'amount_paid')::bigint),
      'payment_status',case when v_refunded >= (v_bill.public_state->>'amount_paid')::bigint then 'refunded' else 'partially_refunded' end,
      'updated_at',p_occurred_at
    );
    update bill_mappings set public_state=v_state,payment_status=v_state->>'payment_status',updated_at=now()
      where id=v_bill.id;
  end if;
  return jsonb_build_object('duplicate',false,'bill',v_state);
end $$;

revoke all on function public.record_provider_correction(text,text,text,text,text,text,text,bigint,text,timestamptz) from public;
grant execute on function public.record_provider_correction(text,text,text,text,text,text,text,bigint,text,timestamptz) to service_role;

commit;

-- Rollback: stop correction ingestion first. Preserve this ledger and audit evidence; do not
-- delete corrections or restore a mutable payment/refund representation.
