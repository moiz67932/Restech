# Payment Session Current-State Audit

Date: 2026-07-23. Scope: the Restec monorepo only. No production data or Paely repository was accessed.

## Existing behavior

The repository is an npm-workspace TypeScript monorepo. `apps/api/src/app.ts` is a Hono API deployed through `apps/api/api/index.mjs` and `apps/api/vercel.json`. `apps/api/src/bootstrap.ts` selects a memory repository only for tests and the Supabase repository for sandbox/production.

The existing public contract already provided:

- API-key lookup, prefix/environment isolation, encrypted signing-secret retrieval, constant-time hash/signature checks, exact raw-body HMAC, timestamp tolerance, request-ID replay records, a 1 MiB body limit, optional shared rate limiting, and idempotency records in `apps/api/src/auth.ts`, `apps/api/src/app.ts`, `packages/security/src/index.ts`, and both repositories.
- Bill upsert, bill status, table mapping, external-payment, sandbox-scenario, private event, POS dispatch, and reconciliation routes in `apps/api/src/app.ts`.
- Deterministic private idempotency keys, per-attempt request IDs, signed exact serialized bodies, bounded timeouts, safe retry classification, and sanitized dependency errors in `packages/paely-client/src/index.ts`.
- Additive Supabase schema, RLS, private event inbox, POS outbox, delivery attempts, audit log, bill projections, and transaction RPCs in `supabase/migrations`.
- Encrypted connector configuration via AES-256-GCM using `RESTEC_SECRET_ENCRYPTION_KEY`; `SupabaseRepository.authorizeLocation` decrypts it. The dispatcher reads this repository result, so `pos_connections.encrypted_configuration` is authoritative.
- Exact-byte signed POS webhooks, accepted success statuses, retryable temporary statuses, dead-letter handling, leases, and manual replay in `packages/connectors/canonical-rest`, `packages/webhook-delivery`, and the repository.
- Public OpenAPI, Postman, seven language samples, developer docs, certification docs, leakage checks, migration checks, mock E2E, and Vercel runtime checks.

Sandbox seed data contains `con_sandbox_canonical` and `con_sandbox_mock`. The canonical connector initially points to `https://example.invalid/restec-webhook`. `scripts/create-sandbox-credentials.ts` creates new non-production credentials and encrypts connector configuration, but intentionally prints newly generated secrets once; it is not appropriate for updating an existing destination without rotation.

## Reusable components

The implementation reuses `publicAuth`, `reserveReplay`, `reserveIdempotency`, `derivePrivateIdempotencyKey`, `encryptSecret`/`decryptSecret`, `private_event_inbox`, `pos_outbox_events`, `audit_logs`, the connector registry, delivery retry policy, and the existing repository split. No second authentication, encryption, inbox, outbox, or delivery subsystem was introduced.

## Missing behavior before this change

There was no payment-session feature flag, public create/status route, Restec redirect route, payment-session state machine, payment-session persistence, private client methods, hosted URL encryption, provider-host allowlist, payment-session event association, dummy signed POS receiver, real payment-session certification script, or payment-session public documentation.

The existing private event schema accepted only completed, failed, and refunded events and did not bind events to a public payment-session reference. The existing public event did not carry `payment_session_id`. The inbound event receiver verified signature/timestamp/event ID but had no payment-session-specific service-identity and environment checks.

## Files involved

- API/auth/config/runtime: `apps/api/src/app.ts`, `auth.ts`, `bootstrap.ts`, `config.ts`, `memory-repository.ts`, `reconciliation.ts`.
- Contracts/security: `packages/contracts/src`, `packages/security/src`.
- Persistence: `packages/database/src/repository.ts`, `supabase-repository.ts`, `supabase/migrations`, `supabase/seed.sql`.
- Private boundary: `packages/paely-client/src/index.ts`.
- POS delivery: `packages/connectors/canonical-rest/src/index.ts`, `packages/webhook-delivery/src/index.ts`.
- Public artifacts: `openapi/restec-pos-partner-v1.yaml`, `postman`, `examples`, `docs/pos-partner`, `docs/RESTEC_POS_INTEGRATION_GUIDE.md`, `apps/docs/app/page.tsx`.
- Operations: `.env.example`, `scripts`, `apps/api/vercel.json`, `.github/workflows/phase2.yml`.

## Database impact

Migration `20260723000100_payment_sessions.sql` adds `payment_sessions`, `mock_pos_receipts`, indexes, RLS, and two service-role RPCs. It does not drop, rename, rewrite, or backfill existing financial rows. Customer email/mobile and raw checkout URLs are not stored. The provider URL is AES-256-GCM ciphertext; private references remain server-side.

The selected crash-consistency model pre-creates a deterministic Restec session, then calls the private service with a deterministic idempotency key, then attaches the encrypted private result. A retry after a timeout or failed attachment reuses both identities. The partial unique index prevents simultaneous active sessions for one connection/bill.

## Leakage and production risks

Primary leakage risks are returning/logging the private checkout URL, forwarding private identifiers/errors, open redirects, public documentation naming hidden services, and POS events carrying private IDs. Controls are explicit response construction, encrypted URL storage, no raw dependency logging, exact-host HTTPS validation, opaque Restec IDs, sanitized errors, protected internal evidence, and the public-artifact leakage scan.

Production risks are accidental enablement, a sandbox allowlist copied to production, migration/application ordering, unknown private event shape, or an active session left in `creating`. The flag defaults false; all new public/browser routes return 404 while false; the sandbox test receiver and evidence endpoints return 404 outside sandbox; migrations are additive; reconciliation documentation covers `creating`; and production must keep `RESTEC_PAYMENT_SESSIONS_ENABLED=false`.

## Exact Paely dependency

Restec now depends on the two private routes and event extension defined in `PAELY_PAYMENT_SESSION_PRIVATE_CONTRACT.md`. Repository inspection cannot prove that the deployed Paely sandbox implements them. Real certification is blocked until the deployed private create/status routes exist, return a real sandbox hosted-checkout URL, emit a signed authoritative payment event, and complete the POS round trip.
