# Production Readiness Checklist

| Item                                      | Status                  | Evidence/blocker                              |
| ----------------------------------------- | ----------------------- | --------------------------------------------- |
| Supabase adapter and repository interface | Complete                | `packages/database/src`                       |
| Vercel compiler/function fix              | Complete                | `apps/api/package.json`, `api/index.ts`       |
| Additive migration                        | Complete                | Phase 2 migration                             |
| Local migration execution/types           | Requires infrastructure | Docker unavailable until started              |
| Database integration/concurrency matrix   | Partially complete      | Gated tests exist; full matrix remains        |
| Public persistent endpoints               | Complete in adapter     | Requires E2E certification                    |
| Atomic private inbox/outbox               | Complete in RPC         | Requires database test run                    |
| Dispatcher persistence                    | Complete in code        | Requires failure/concurrency run              |
| Sandbox scenarios                         | Partially complete      | Durable path exists; all scenarios unexecuted |
| Shared production limiter                 | Not complete            | Provider decision required                    |
| Portal authentication/mutations           | Not complete            | Identity-provider decision required           |
| Reconciliation compare/report             | Complete                | Batch recovery partial                        |
| Real sandbox round trip                   | Requires infrastructure | Approved credentials required                 |
| Monitoring and on-call                    | Not complete            | Operational decision required                 |
| Real vendor connectors                    | Not complete            | Documentation/certification required          |

Restec is not production-ready.
