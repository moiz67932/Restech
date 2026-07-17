# Phase 2 Implementation Report

| Area                | Current implementation                              | Exact files                                     | Missing work                               | Planned change                                            |
| ------------------- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Runtime repository  | `MemoryRepository` was instantiated unconditionally | `apps/api/src/index.ts`, `memory-repository.ts` | State lost on restart                      | Driver-selected bootstrap; Supabase required outside test |
| Repository contract | API-local, partial interface                        | `apps/api/src/types.ts`                         | Outbox, audit, payments, recovery          | Shared `packages/database/src/repository.ts` contract     |
| Authentication      | Full-key memory lookup                              | `auth.ts`                                       | Prefix/hash/encrypted signing secret/usage | Supabase authentication and usage persistence             |
| Replay/idempotency  | Process maps                                        | `memory-repository.ts`                          | Restart/concurrency durability             | Unique database reservations and retryable failed state   |
| Bills/payments      | Private call then memory state                      | `app.ts`                                        | Locks, versions, duplicate payments        | Additive atomic projection RPCs                           |
| Private events      | Memory event-ID set                                 | `app.ts`                                        | Connection resolution and durable wiring   | Resolve connection then atomic inbox/outbox RPC           |
| Dispatcher          | Protected 202 stub                                  | `app.ts`                                        | Claims through dead letters                | Registry delivery plus persisted attempts/retries         |
| Sandbox             | Returned event ID only                              | `memory-repository.ts`                          | Real pipeline                              | Use durable event acceptance pipeline                     |
| Portal              | Static UI                                           | `apps/portal/app`                               | Approved identity provider                 | Disabled-by-default admin service boundary                |
| Reconciliation      | Status field only                                   | `bill_mappings`                                 | Comparison/actions                         | Read-only comparison and audited actions                  |
| Deployment          | Workspace lacked `typescript`; no Vercel function   | `apps/api/package.json`, `vercel.json`          | `tsc` build failure                        | Workspace compiler and `api/index.ts` handler             |

`MemoryRepository` handled credentials, request IDs, idempotency, location lookup, bills, tables, event deduplication and sandbox events. It is now explicit-only; configuration rejects it for sandbox and production.

There is no distributed transaction with the private dependency. Restec durably reserves public idempotency, calls upstream with a deterministic private key, persists the projection, then completes the public record. Failures retain `failed` operation state; retries reuse the private key and permanent resource identifiers.

## Phase 2 status

Application wiring, additive schema, repository implementation, serverless entry, mock compatibility, dispatcher, gated database tests and operational documentation are implemented. Local database execution and generated types were not completed because Docker was unavailable. No real sandbox endpoint was contacted.
