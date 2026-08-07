# Phase 1 financial concurrency baseline

Recorded on 2026-08-07 before any Phase 1 runtime change.

## Source state

- Branch: `main`
- Commit: `151e2994090b6e42847387b467874b4c6f365ea5`
- Tracking: `main...origin/main`
- Tracked diff: empty
- `git diff --stat`: empty
- `git diff --check`: passed
- Pre-existing untracked work preserved:
  - `docs/internal/RESTEC_POS_COMPLETE_USE_CASE_AUDIT.md`
  - `docs/internal/RESTEC_POS_USE_CASE_MATRIX.csv`

No reset, checkout, deletion, or formatting rewrite was performed.

## Required baseline commands

| Command                        | Result | Evidence                                                                                                                      |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`               | FAIL   | Stopped at `format:check`: Prettier reported 97 pre-existing files. Later stages did not run through this aggregate command.  |
| `npm run docs:verify`          | FAIL   | Stopped at the same repository-wide Prettier gate.                                                                            |
| `npm test`                     | PASS   | 89 tests: 86 passed, 0 failed, 3 skipped.                                                                                     |
| `npm run test:e2e:mock`        | PASS   | 4 passed, 0 failed, 0 skipped.                                                                                                |
| `npm audit --audit-level=high` | FAIL   | 5 advisories: 4 high (`js-yaml`, `postcss`, `sharp`) and 1 moderate (`hono`). No automatic dependency mutation was performed. |

## Additional available verification

| Command                    | Result      | Evidence                                                                                        |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `npm run check:migrations` | PASS        | 9 migrations structurally checked.                                                              |
| `npm run test:database`    | GATED       | 2 tests discovered; both skipped because a database integration environment was not configured. |
| `npm run test:e2e:sandbox` | PARTIAL     | 2 mock E2E cases passed; the real sandbox case was explicitly skipped.                          |
| `supabase status`          | UNAVAILABLE | Supabase CLI is not installed on this machine.                                                  |

## Explicitly skipped or gated

- Real database atomic inbox/outbox integration: skipped by its environment gate.
- Real database payment-session transition integration: skipped by its environment gate.
- Live sandbox E2E: skipped by its explicit normal-run gate.
- Remote sandbox and provider certification commands were not represented as passing. They require external credentials/services and can create sandbox financial artifacts; they remain Phase 2/provider certification gates.
- Supabase reset/lint/runtime migration application was not run because the CLI/local stack is unavailable.

## Baseline conclusion

The functional unit and mock suites were green before Phase 1. Repository-wide formatting and dependency-audit gates were already red. Database and provider behavior was not certified by this baseline.
