# Phase 5 financial corrections certification

## 1. Baseline and authority decisions

Branch: `main`. Baseline commit: `151e2994090b6e42847387b467874b4c6f365ea5`.

Refund requests: no public POS/dashboard initiation in v1. Refund completion: authenticated payment provider evidence. Void and reversal: no certified current provider initiation or event contract. Chargeback/dispute: provider/card-network authority, but provider support is not present in the current Restec contract.

## 2. Supported and unsupported types

Supported application behavior is provider-originated full and partial refunds for hosted digital payments. Multiple partial refunds are supported, subject to the aggregate original-payment ceiling. The cash, card-terminal, wallet-terminal, voucher, and approved-other refund mechanisms are unsupported until a method-specific authority contract is approved.

Voids, reversals, chargebacks, disputes, POS-originated refunds, and automatic system money-moving corrections are explicitly unsupported/provider-gated. They are not faked as refunds.

## 3. Immutable model and formula

`financial_corrections` is additive and immutable. Each row stores actor/source authority, logical identity, Restec correction ID, original Restec payment ID, amount, currency, status, occurrence time, and bill scope. The original completed payment is never edited.

Example:

```text
PAYMENT_COMPLETED   +10,000
REFUND_COMPLETED     -2,000
----------------------------
NET SETTLED          +8,000
```

Refundable amount is:

```text
max(0, original_completed_payment_minor - sum(completed_refund_minor))
```

The order receivable and payment settlement are separate. `amount_due = max(0, grand_total - amount_paid)`; `amount_refunded` is a separate settlement correction projection. A voluntary post-settlement refund therefore does not automatically reopen `amount_due`.

## 4. Refund behavior

Full refund: one completed correction equal to the remaining refundable amount; bill remains closed and receives `refunded` payment status.

Partial refund: one immutable correction for the requested amount; bill keeps original `amount_paid`, increases derived `amount_refunded`, and uses `partially_refunded` unless fully refunded.

Multiple partial refunds: each logical correction is separate; aggregate completed corrections cannot exceed the original completed payment. Concurrent in-memory stress with 100 requests of 200 minor units produced 50 completed corrections (10,000 total) and 50 `review_required` rows.

Over-refund: local initiated money movement is not exposed in v1. Provider-reported over-refund-like truth is recorded as `review_required`; it does not silently increase the bill projection.

Duplicate delivery: private event ID is deduplicated and the correction logical identity is also unique. Different technical IDs for the same payment/type/amount/currency remain one economic correction. Outbox delivery retries reuse one logical public event ID.

Ambiguous result: no initiation API exists in v1. Any provider event requiring review retains the prior protected financial state and is reconcilable; it is not discarded.

## 5. Lifecycle interactions

Refund after bill close and after physical table reuse remains attached to the original connection/bill/payment. It does not reopen the table or create a physical table generation. Customer projections remain scoped to the historical visit and do not expose Guest A’s correction to Guest B.

POS receives safe correction data only; raw provider correction IDs and cardholder data are not exposed. Out-of-order correction delivery is correlated by the original Restec payment/bill identity and the durable event can be delivered after the original payment event.

## 6. Audit and reconciliation foundation

The memory and Supabase repositories record provider corrections, derive bill correction totals from immutable facts, audit completion/review outcomes, and expose a correction listing only to internal repository code. Migration `20260807000400_financial_corrections_ledger.sql` adds the PostgreSQL ledger and atomic provider-correction function.

Historical correction backfill is intentionally not performed automatically. Existing `amount_refunded` values require provider evidence and an approved migration plan before they can be imported as immutable facts.

## 7. Evidence

Passed after Phase 5 changes:

- `npm run typecheck`
- `npm test` — 119 passed, 5 explicitly gated/skipped
- `npm run test:e2e:mock` — 4 passed
- `npm run check:migrations` — 13 migrations checked
- `npm run validate:openapi`
- `npm run validate:public-artifacts`
- `npm run lint`
- `npm run docs:validate`

Correction-specific tests prove immutable payment amount, no receivable reopening, duplicate logical identity, concurrent aggregate ceiling, and review quarantine. Phase 1 financial concurrency, Phase 3 table/privacy, and Phase 4 lifecycle tests pass through the full suite.

## 8. Gated checks and known repository issues

The five existing skipped tests remain explicitly gated: two independent-connection concurrency tests and two database repository tests, plus the sandbox E2E gate. PostgreSQL correction race certification is `DATABASE_EXECUTION_GATED`; provider correction sandbox certification is `PROVIDER_CORRECTION_SANDBOX_GATED`; real POS correction integration is gated.

`npm run format:check` remains red on pre-existing repository-wide formatting/public-artifact issues across 84 files, including pre-existing Phase 1–4 files. `npm run test:leakage` is blocked by the pre-existing missing `docs/postman` path. These are recorded repository-wide issues, not Phase 5 correction regressions.

## 9. Final verdict

`RESTEC_PHASE5_FINANCIAL_CORRECTIONS_APPLICATION_COMPLETE_DB_PROVIDER_GATED`

Application/domain refund correction behavior is complete for the approved receive-only provider contract. PostgreSQL concurrency, provider refund/void sandbox, and real POS certification remain explicit blockers; void, reversal, chargeback, and dispute behavior is capability-gated rather than claimed.
