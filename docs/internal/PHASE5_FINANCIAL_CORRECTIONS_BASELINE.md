# Phase 5 financial-corrections baseline

Recorded 2026-08-07 on branch `main`, baseline commit `151e2994090b6e42847387b467874b4c6f365ea5`.

The worktree already contained Phase 1–4 implementation changes; they were preserved. Baseline checks passed:

- `npm run typecheck`
- `npm test` — 116 passed, 5 explicitly gated/skipped
- `npm run test:e2e:mock` — 4 passed
- `npm run check:migrations` — 12 migrations checked

`git diff --check` was clean. The baseline had a receive-only `payment.refunded` / `payment.partially_refunded` private-event path and payment/session states for `refunded` and `partially_refunded`, but no immutable correction ledger. Bill projections trusted incoming `amount_refunded` and used `grand_total - amount_paid + amount_refunded` for `amount_due`.

Phase 5 changes this additively. Original payment facts remain immutable; corrections are separate provider-authoritative facts. PostgreSQL, provider sandbox, and real POS correction certification remain gated.
