# Phase 7 reconciliation and recovery certification

## Verdict

`RESTEC_PHASE7_RECONCILIATION_PARTIAL`

## Implemented

- Durable `reconciliation_cases` and `reconciliation_actions` models with active-case deduplication, safe evidence snapshots, severity, status, recommended action, and idempotency identity.
- `compare_provider_state` is truthful; the misleading `refresh_private_bill` action is removed.
- Manual review is durable and audited.
- Verified payment-session terminal recovery reuses the Phase 1 reservation/inbox/outbox commit path.
- POS dead-letter replay retains the original event identity.
- Authority, operator, ambiguity, and offboarding runbooks are documented.

This pass does not yet implement the complete staged offboarding state machine,
bounded all-subject scanner, or the requested 1,000-case and concurrent-worker
certification harness.

## Safety decisions

Provider active/local expiry retains capacity. Late success capacity conflicts, amount/currency/identity mismatches, uncertain provider state, and Restec-ahead/provider-not-paid cases require manual review. Projection repair is derived-only. Corrections use the Phase 5 immutable correction path.

## Gates and limitations

PostgreSQL execution is `DATABASE_EXECUTION_GATED`; provider reconciliation sandbox is `PROVIDER_RECONCILIATION_SANDBOX_GATED`; real POS is `REAL_POS_RECONCILIATION_GATED`; production scheduler/offboarding operations are not certified. Run the local typecheck, unit/mock, migration, and prior-phase regression suites before release. No live credentials were changed.

## Phase 8 blockers

Real PostgreSQL concurrency evidence, provider sandbox read/terminal evidence, real POS delivery evidence, deployed scheduler observability, and an exercised staged offboarding operation remain required.
