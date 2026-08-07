# Restec Phase 2 real database certification

## Verdict

**RESTEC_PHASE2_DATABASE_PARTIAL**

This is an evidence-bound verdict. The implementation now has a fail-closed certification command, independent-connection 100-request PostgreSQL race tests, a guarded disposable reset, and a read-only consistency audit. This workstation did not have a running PostgreSQL/Supabase environment or credentials, so no real database result is represented as passed.

## Baseline

Branch `main`; commit `151e2994090b6e42847387b467874b4c6f365ea5`. The worktree was already dirty with Phase 1 changes, which were preserved. `npm test` passed 99/99 with 3 explicit skips; mock E2E passed 4/4; migration check and typecheck passed. Lint and `verify` have baseline failures documented in `PHASE2_DATABASE_CERTIFICATION_BASELINE.md`.

## Database and migration evidence

Database used: none in this run. Non-production proof: no target database was contacted. Supabase CLI package version 2.109.1 is available, but Docker is not running and no DB environment variables are configured. Migration-from-zero, upgrade, rollback, RPC execution, isolation, lock, crash, worker lease, projection and race sections are therefore **not executed**.

The required command is `npm run test:database:certify`. It rejects missing credentials, missing integration mode, production-like targets, migration mismatch, skipped tests, and audit inconsistencies.

## Implemented certification controls

- `scripts/certify-database.ts`: fail-closed certification runner.
- `packages/database/src/supabase-repository.certification.test.ts`: two independent Supabase clients and 100-request full/partial capacity races.
- `scripts/db-test-reset.ts`: local-only destructive reset guard.
- `scripts/audit-financial-database-consistency.ts`: read-only consistency audit.
- Internal architecture, migration, lock, isolation, rollback and reconciliation records.

## Results matrix

| Scenario | Result |
|---|---|
| two cash | Not executed |
| cash + terminal | Not executed |
| cash + digital | Not executed |
| terminal + digital | Not executed |
| digital completion + POS | Not executed |
| two digital sessions | Not executed |
| concurrent bill updates | Not executed |
| bill update + payment | Not executed |
| 100 full-balance | Harness implemented; DB execution gated |
| 100 partial | Harness implemented; DB execution gated |

No committed/protected totals were observed from PostgreSQL. Event exactly-once, different-event-ID handling, outbox workers, lease recovery, dead-letter/requeue, rollback atomicity, crash windows, restart, ambiguous payment persistence and projection consistency remain unproven here.

## Remaining blockers

Provide a disposable local/CI Supabase stack or explicitly identified non-production staging project, run all migrations from zero and the pre-Phase-1 upgrade rehearsal, supply synthetic fixture connection metadata, execute `npm run test:database:certify`, and record the output. Provider sandbox timeout-after-success certification remains a separate gated activity.
