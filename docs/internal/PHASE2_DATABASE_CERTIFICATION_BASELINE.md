# Phase 2 database certification baseline

Captured 2026-08-07 from branch `main`, commit `151e2994090b6e42847387b467874b4c6f365ea5`.

The worktree already contained Phase 1 changes and audit artifacts; they were preserved. The migration set contains 10 SQL files, latest `20260807000100_financial_capacity_reservations.sql`.

| Check | Result |
|---|---|
| `npm test` | PASS: 99 passed, 3 explicitly skipped, 0 failed |
| `npm run test:e2e:mock` | PASS: 4 passed |
| `npm run check:migrations` | PASS: 10 migrations |
| `npm run typecheck` | PASS |
| `npm run lint` | BASELINE FAIL: existing unused `privateKey` in `apps/api/src/app.ts:239` |
| `npm run verify` | BASELINE FAIL: repository-wide Prettier failures; it stops before later checks |
| `npm audit --audit-level=high` | BASELINE FAIL: 4 high and 1 moderate advisories; no dependency mutation performed |
| Supabase CLI | Available through `npx supabase` 2.109.1 |
| Docker daemon | Unavailable on this workstation |
| DB credentials | None configured; names only were inspected |

No PostgreSQL/Supabase execution was claimed in this environment. The certification command therefore intentionally fails closed when its disposable database contract is absent.
