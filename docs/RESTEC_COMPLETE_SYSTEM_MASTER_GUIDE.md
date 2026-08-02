# Restec Complete System Master Guide

> **Internal master document.** This guide names private systems, routes, identifiers, and
> operational controls. It is not a POS-partner-facing artifact. It reconstructs the repository
> as inspected on 2026-07-24. Statements marked **implemented and locally tested** passed the
> repository's local test or verification suite. Statements marked **implemented, remote-gated**
> have code and tests but were not exercised against remote infrastructure during this audit.
> **Designed only**, **mocked**, and **blocked** mean exactly that.

## Contents

1. [Scope, evidence, and current verdict](#1-scope-evidence-and-current-verdict)
2. [Purpose and the public/private boundary](#2-purpose-and-the-publicprivate-boundary)
3. [System architecture and ownership of truth](#3-system-architecture-and-ownership-of-truth)
4. [Repository and runtime architecture](#4-repository-and-runtime-architecture)
5. [Complete route and operation inventory](#5-complete-route-and-operation-inventory)
6. [Authentication, signing, replay, and idempotency](#6-authentication-signing-replay-and-idempotency)
7. [Forward bill and external-payment flows](#7-forward-bill-and-external-payment-flows)
8. [Hosted payment-session flow](#8-hosted-payment-session-flow)
9. [Paely event, Restec projection, and POS update flow](#9-paely-event-restec-projection-and-pos-update-flow)
10. [Database model and relationships](#10-database-model-and-relationships)
11. [State machines](#11-state-machines)
12. [Public identifier isolation](#12-public-identifier-isolation)
13. [Checkout URL encryption and redirect protection](#13-checkout-url-encryption-and-redirect-protection)
14. [Inbox, outbox, delivery, retries, and dead letters](#14-inbox-outbox-delivery-retries-and-dead-letters)
15. [Dummy POS and sandbox certification](#15-dummy-pos-and-sandbox-certification)
16. [Environment separation, flags, and variables](#16-environment-separation-flags-and-variables)
17. [Partner, restaurant, location, and connection credentials](#17-partner-restaurant-location-and-connection-credentials)
18. [Implemented-status matrix](#18-implemented-status-matrix)
19. [Manual Supabase and Vercel deployment](#19-manual-supabase-and-vercel-deployment)
20. [End-to-end tests and SQL verification](#20-end-to-end-tests-and-sql-verification)
21. [Failure handling, recovery, and reconciliation](#21-failure-handling-recovery-and-reconciliation)
22. [Security and PCI boundary](#22-security-and-pci-boundary)
23. [Production-readiness and rollback](#23-production-readiness-and-rollback)
24. [Remaining Paely work](#24-remaining-paely-work)
25. [Contradictions and material implementation gaps](#25-contradictions-and-material-implementation-gaps)
26. [Successful payment lifecycle sequence](#26-successful-payment-lifecycle-sequence)

## 1. Scope, evidence, and current verdict

This guide was derived from the current working repository, including uncommitted and untracked
files present at inspection time. No previous chat was used. The evidence set includes:

- Runtime and API code: `apps/api/src/app.ts` (`createApp`), `auth.ts` (`publicAuth`),
  `config.ts` (`loadConfig`), `bootstrap.ts`, `payment-sessions.ts`, `reconciliation.ts`,
  `memory-repository.ts`, and `portal-admin-service.ts`.
- Canonical contracts and security: `packages/contracts/src/index.ts`,
  `packages/contracts/src/payment-session-state.ts`, and `packages/security/src/index.ts`.
- Persistence: `packages/database/src/repository.ts`,
  `packages/database/src/supabase-repository.ts`, all six files in `supabase/migrations/`, and
  `supabase/seed.sql`.
- Private Paely client: `packages/paely-client/src/index.ts` (`PaelyClient`).
- POS connectors and delivery: `packages/connector-sdk/src/index.ts`,
  `packages/connector-registry/src/index.ts`, `packages/connectors/canonical-rest/src/index.ts`,
  `packages/connectors/mock-pos/src/index.ts`, and `packages/webhook-delivery/src/index.ts`.
- Tests: all `*.test.ts` files under `apps/`, `packages/`, and `scripts/`.
- Operations and certification: `scripts/create-sandbox-credentials.ts`,
  `configure-sandbox-mock-pos.ts`, `sandbox-operation.ts`,
  `certify-real-payment-session.ts`, deployment/runtime validators, and existing documentation.
- Build and deployment shape: root and workspace `package.json` files,
  `apps/api/vercel.json`, `apps/api/api/index.mjs`, `supabase/config.toml`, and
  `.github/workflows/phase2.yml`.

The local command `npm run verify` passed on Node `v24.16.0` and npm `11.13.0`. It reported 40
tests: 37 passed and 3 skipped. The skipped tests were the remote sandbox E2E test and two
Supabase database integration tests. Mock E2E, lint, typecheck, OpenAPI drift validation, public
artifact validation, leakage scanning, migration static checks, all workspace builds, compiled
API startup, and Vercel runtime packaging checks passed. The test definitions and gates are in
`apps/api/src/sandbox.e2e.test.ts` and
`packages/database/src/supabase-repository.integration.test.ts`; the orchestration is in the
root `package.json`.

**Current verdict:** the Restec side is substantially implemented and mock-tested. It is not
production-ready and the real hosted-payment lifecycle is not remotely certified. The repository
does not contain Paely's server implementation, a provider webhook handler, deployed
infrastructure evidence, production monitoring, a working portal administration plane, or a
certified real POS connector. The authoritative status is therefore:

- Core bill/event/outbox code: **implemented and locally tested**.
- Supabase RPC path: **implemented, remote-gated**; local verification did not execute PostgreSQL.
- Hosted payment sessions: **implemented and mock-tested on Restec**, **blocked for real
  certification by Paely/provider infrastructure**.
- Production: **disabled/not certified**.

## 2. Purpose and the public/private boundary

Restec is a vendor-neutral restaurant POS integration and payment-status facade. A POS integrates
with one Restec contract rather than Paely's private data model or provider integrations. The
repository describes that purpose in `README.md`; the actual boundary is enforced by
`apps/api/src/app.ts`, `packages/paely-client/src/index.ts`, and
`scripts/check-public-content.ts`.

From a POS vendor's perspective:

```text
POS -> Restec public JSON API
Restec -> POS response
Restec -> POS signed payment webhook
```

Internally:

```text
POS -> Restec -> signed private Paely API -> Restec projection -> POS response

Safepay/PayFast or another regulated provider
  -> Paely provider webhook and canonical payment commit
  -> signed Paely event
  -> Restec inbox + projection + outbox
  -> signed Restec webhook
  -> POS
```

Only the Restec portions of the second diagram exist in this repository. Safepay is named in
`docs/PAELY_PAYMENT_SESSION_IMPLEMENTATION_PROMPT.md` as the real sandbox dependency. There is no
PayFast-specific code, contract, migration, test, or certification evidence in this repository.
Consequently, “Safepay/PayFast -> Paely” is an architectural provider slot, not proof that both
providers are implemented.

Restec hides Paely in four concrete ways:

1. `PaelyClient.sanitizeBill` in `packages/paely-client/src/index.ts` constructs a public bill
   state and drops `integration_bill_id`, `paely_order_id`, private table data, upstream debug
   data, and any unselected field.
2. `createApp` hashes private bill, payment, and event references into Restec IDs instead of
   forwarding private IDs (`apps/api/src/app.ts`, bill routes and Paely event route).
3. Hosted-payment create responses contain a Restec session ID and Restec checkout URL. The
   provider URL and private session ID never appear in that response
   (`paymentSessionResponse` in `apps/api/src/payment-sessions.ts`).
4. `scripts/check-public-content.ts` rejects Paely, Safepay, Supabase, private reference names,
   settlement terms, and private service headers from the explicitly enumerated public
   documentation/site/sample roots. This is a build-time leakage check, not a universal scan of
   every repository document.

The stable public contract is therefore Restec-owned. Paely identifiers and service routes remain
server-side, and provider details are outside the POS trust boundary.

## 3. System architecture and ownership of truth

### 3.1 Main components

| Component               | Responsibility                                                                                                           | Implementation evidence                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| POS                     | Sends bills and completed external payment facts; receives payment events                                                | Public routes in `createApp`; public schemas in `packages/contracts/src/index.ts` |
| Restec API              | Authenticates, validates, authorizes, maps, forwards, projects, and exposes status                                       | `apps/api/src/app.ts`, `auth.ts`, `bootstrap.ts`                                  |
| Restec Supabase         | Tenant data, public/private mappings, replay/idempotency, financial projections, inbox/outbox, attempts, audit, sessions | `supabase/migrations/*.sql`; `SupabaseRepository`                                 |
| Paely private client    | Calls private bill, external-payment, table-mapping, and session operations                                              | `PaelyClient` in `packages/paely-client/src/index.ts`                             |
| Paely                   | Owns private canonical order/payment behavior and regulated provider integration                                         | Contract only in this repository; server not present                              |
| Provider                | Hosts card entry and sends provider payment webhook to Paely                                                             | Not implemented in this repository                                                |
| Dispatcher              | Claims Restec outbox rows and invokes a connector                                                                        | `/api/internal/jobs/dispatch-pos-events` in `createApp`                           |
| Canonical POS connector | Serializes and signs Restec events, classifies POS responses                                                             | `canonicalRestConnector`                                                          |
| Mock POS connector      | Simulates success, retry, and permanent failure without network delivery                                                 | `mockPosConnector`                                                                |
| Dummy POS receiver      | Verifies a signed Restec event in sandbox and stores receipt evidence                                                    | `POST /api/test/mock-pos-webhook`                                                 |
| Reconciliation          | Compares Restec bills with Paely and inspects active sessions                                                            | `ReconciliationService`                                                           |
| Portal                  | Static, disabled UI foundation                                                                                           | `apps/portal/app/page.tsx`; `DisabledPortalAdminService`                          |

### 3.2 Ownership of truth

| Fact                                                     | Authoritative owner                          | Restec behavior                                                         |
| -------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| POS bill items, table ID, external order ID, and version | POS, subject to canonical validation         | Validates, maps, and forwards                                           |
| Private order/bill identity                              | Paely                                        | Stores private reference server-side and returns a Restec ID            |
| Provider payment completion                              | Paely after provider verification            | Accepts only signed Paely event or private status during reconciliation |
| Browser return/cancel                                    | Customer navigation only                     | Never marks paid; cancel may set a local session to `cancelled`         |
| Public bill/payment projection                           | Restec database after private response/event | Returned to POS and compared in reconciliation                          |
| POS delivery state                                       | Restec outbox and attempts                   | Independent retry/dead-letter lifecycle                                 |

There is no distributed transaction between Restec and Paely. For forward mutations, the recovery
boundary is public idempotency plus a deterministic private idempotency key. For reverse payment
events, the database RPC is intended to atomically insert the inbox row, update projections, and
insert the POS outbox row.

## 4. Repository and runtime architecture

The repository is an npm-workspace TypeScript monorepo (`package.json`):

- `apps/api`: Hono API and Vercel function.
- `apps/docs`: static Next.js public docs site.
- `apps/portal`: static Next.js disabled portal foundation.
- `packages/contracts`: strict Zod public/private payload fragments and state types.
- `packages/security`: HMAC, timestamps, API-key hashing, and AES-GCM.
- `packages/database`: repository contract and Supabase implementation.
- `packages/paely-client`: private outbound HTTP client.
- `packages/connector-sdk`, `connector-registry`, and `connectors/*`: POS adapter boundary.
- `packages/webhook-delivery`: destination checks and retry schedule.
- `packages/rate-limiting`: memory and HTTP shared limiter implementations.
- `supabase`: ordered schema migrations and non-production seed.
- `scripts`: validation, setup, smoke, and certification tooling.

`apps/api/src/bootstrap.ts` calls `loadConfig`, creates either `MemoryRepository` or
`SupabaseRepository`, constructs `PaelyClient`, optionally constructs
`HttpSharedRateLimiter`, and passes all dependencies to `createApp`. `loadConfig` rejects the
memory driver in sandbox and production, so `MemoryRepository` is a test double only.

The Vercel entry is `apps/api/api/index.mjs`, which imports compiled
`apps/api/dist/bootstrap.js` and exports a Fetch API handler. `apps/api/vercel.json` disables
framework detection, rewrites all paths to the one function, includes only compiled API and
workspace package output, sets a 30-second maximum duration, and uses `public` as its inert output
directory. `scripts/verify-vercel-runtime.mjs` verifies this packaging graph.

## 5. Complete route and operation inventory

### 5.1 Restec public POS API

All `/v1/*` routes pass through `publicAuth` before route logic. All require a JSON content type,
including signed GETs with an empty body.

| Method and route                                                         | Purpose                                              | Extra behavior                                                                                                                 | Source                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /health`                                                            | Safe runtime health                                  | No authentication; returns status, configured environment, hard-coded API version `1.0.0`                                      | `createApp`, `apps/api/src/app.ts`                                        |
| `PUT /v1/locations/:locationId/bills/:externalBillId`                    | Create/update canonical bill                         | Idempotency required; table mapping and bill version checked; private Paely PUT; returns sanitized bill                        | `createApp`; `billSchema`; `PaelyClient.upsertBillDetailed`               |
| `GET /v1/locations/:locationId/bills/:externalBillId`                    | Read stored Restec bill projection                   | No `Idempotency-Key`; does not call Paely                                                                                      | `createApp`; repository `getBill`                                         |
| `POST /v1/locations/:locationId/bills/:externalBillId/external-payments` | Record completed POS-side cash/terminal/voucher fact | Idempotency required; checks duplicate, currency, amount due, and payment-in-progress; private Paely POST                      | `createApp`; `externalPaymentSchema`; `PaelyClient.recordExternalPayment` |
| `POST /v1/locations/:locationId/bills/:externalBillId/payment-sessions`  | Create Restec hosted-payment session facade          | Feature flag and environment header required; idempotency; bill-payability/reconciliation checks; private Paely session create | `createApp`; `paymentSessionRequestSchema`                                |
| `GET /v1/locations/:locationId/payment-sessions/:paymentSessionId`       | Read Restec session state                            | Feature flag and environment header required; scoped by partner/connection/location/environment                                | `createApp`; `paymentSessionResponse`                                     |
| `GET /v1/locations/:locationId/tables`                                   | List mapped Restec/external tables                   | Returns active and inactive mappings; bill upsert separately rejects inactive mapping                                          | `createApp`; repository `listTables`                                      |
| `POST /v1/test/scenarios`                                                | Generate sandbox event/failure scenarios             | Idempotency required; unavailable after valid auth in production; uses normal projection/outbox path                           | `createApp`; repository `createSandboxEvent`                              |

The public OpenAPI file is `openapi/restec-pos-partner-v1.yaml`. Route drift is checked by
`scripts/validate-openapi.ts`, but that script deliberately scans only `/health` and `/v1/*`;
checkout and internal routes are outside its public route comparison.

### 5.2 Browser checkout routes

These routes are intentionally unauthenticated because the opaque Restec session ID is the browser
capability. They are available only when the feature flag is on.

| Method and route                  | Behavior                                                                                                        | Source                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /s/:paymentSessionId`        | Validates session/scope/state/expiry, decrypts and revalidates provider URL, audits redirect, returns HTTP 303  | `browserPaymentSession` and route in `createApp` |
| `GET /s/:paymentSessionId/return` | Displays `paid` or `confirmation_pending`; refreshes itself at configured interval; never mutates payment truth | `createApp`                                      |
| `GET /s/:paymentSessionId/cancel` | If still `requires_customer_action`, transitions to `cancelled`; later signed `paid` may override               | `createApp`                                      |

These routes are not described as OpenAPI operations in the repository.

### 5.3 Restec private inbound and internal routes

| Method and route                                                     | Authentication                                                                                                     | Purpose                                                                     | Source                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /api/internal/events/paely/v1`                                 | Paely event HMAC/timestamp/event ID/attempt; service/environment headers only mandatory for payment-session events | Accept Paely payment event, map identifiers, atomically project and enqueue | `createApp`                                                   |
| `POST /api/internal/jobs/dispatch-pos-events`                        | Bearer internal job token or configured cron secret                                                                | Release expired leases, claim outbox, deliver, retry, or dead-letter        | `createApp`                                                   |
| `POST /api/internal/jobs/reconcile`                                  | Same job authentication                                                                                            | Compare bill, mark manual review, or requeue dead-lettered public event     | `createApp`; `ReconciliationService`                          |
| `POST /api/internal/jobs/reconcile-payment-sessions`                 | Same job authentication                                                                                            | Expire or compare up to 100 active sessions; no work when flag is off       | `createApp`; `ReconciliationService.reconcilePaymentSessions` |
| `GET /api/internal/test/mock-pos-webhook/last`                       | Job authentication and sandbox environment                                                                         | Return sanitized last dummy receipt summary                                 | `createApp`                                                   |
| `GET /api/internal/test/payment-sessions/:paymentSessionId/evidence` | Job authentication and sandbox environment                                                                         | Return sanitized session/inbox/outbox/bill/receipt evidence                 | `createApp`; repository evidence method                       |
| `POST /api/test/mock-pos-webhook`                                    | Restec outbound event signature using connection secret; sandbox only                                              | Dummy POS receiver and durable dedupe evidence                              | `createApp`                                                   |

Unauthorized job/evidence routes return 404 to hide their existence. The Paely event route returns
normal authentication errors. Internal route documentation is
`docs/openapi/restec-internal-api.yaml`; it is skeletal and does not define full headers or bodies.

### 5.4 Private Paely operations called by Restec

These are client methods, not server routes implemented in this repository:

| Restec method                                   | Private Paely route                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PaelyClient.upsertBillDetailed` / `upsertBill` | `PUT /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}`                    |
| `PaelyClient.getBill`                           | `GET /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}`                    |
| `PaelyClient.recordExternalPayment`             | `POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/external-payments` |
| `PaelyClient.upsertTableMapping`                | `PUT /api/internal/integrations/restec/v1/connections/{privateConnectionId}/table-mappings/{externalTableId}`      |
| `PaelyClient.createPaymentSession`              | `POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions`  |
| `PaelyClient.getPaymentSession`                 | `GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}`                              |

`upsertTableMapping` is implemented in the client but is not invoked by any current Restec API or
admin route. Table onboarding therefore remains an operator/database/private integration task.

## 6. Authentication, signing, replay, and idempotency

### 6.1 POS-to-Restec authentication

`publicAuth` in `apps/api/src/auth.ts` performs the following sequence:

1. Validate `X-Request-Id` against
   `^req_[A-Za-z0-9._:-]{4,123}$`.
2. Extract a bearer key from `Authorization: Bearer ...`.
3. Determine target environment: only `RESTEC_ENV=production` maps to production; sandbox and
   test runtime map public credentials to sandbox.
4. Authenticate the key with `Repository.authenticateApiKey`.
5. If a limiter exists, enforce failed-auth source limits and authenticated partner/path limits.
6. Require `rst_live_` in production and `rst_test_` otherwise.
7. Clone and read exact request bytes; require `Content-Type: application/json`; reject payloads
   over 1 MiB.
8. Verify Unix-seconds timestamp and request signature.
9. Insert a replay record for the request ID.
10. Record API key usage and attach the credential/raw body/request ID to the Hono context.

Supabase authentication extracts the 12-lowercase-hex key prefix using `apiKeyParts`, selects one
active/overlap row in the target environment, rejects expiry, calculates an scrypt hash with
`RESTEC_API_KEY_HASH_SECRET`, compares in constant time, and decrypts that key's request-signing
secret with `RESTEC_SECRET_ENCRYPTION_KEY`
(`SupabaseRepository.authenticateApiKey`).

### 6.2 Request signature

`signRequest` in `packages/security/src/index.ts` computes:

```text
v1=hex_lowercase(
  HMAC-SHA256(
    signing_secret,
    unix_timestamp + "." +
    UPPERCASE_METHOD + "." +
    exact_path_without_query + "." +
    exact_raw_body_bytes
  )
)
```

The verifier reconstructs the same input and uses `timingSafeEqual` after equal-length checking.
The request path comes from `new URL(request.url).pathname`, so query parameters are not signed.
GET requests are signed with an empty body but still require JSON content type in the current
middleware.

`verifyTimestamp` allows an absolute clock difference up to
`RESTEC_TIMESTAMP_TOLERANCE_SECONDS`, default 300 and constrained to 30–900 seconds.

### 6.3 Replay protection

Every authenticated `/v1` request, including GET, reserves its `X-Request-Id`.
`replay_records.request_id` is the primary key. The row also stores partner, request hash,
environment, signed timestamp, receipt time, and an `expires_at` default of ten minutes
(`20260717000100_restec_foundation.sql` and
`20260717000200_restec_phase_2.sql`; `SupabaseRepository.reserveReplay`).

Important operational fact: the repository has no replay-record cleanup job. `expires_at` is not
consulted during insert. Until an operator deletes expired rows, a request ID remains unusable
indefinitely. A route failure after replay reservation also consumes that request ID. Retries must
always use a fresh request ID.

### 6.4 Public mutation idempotency

`idempotent` in `createApp` requires `Idempotency-Key` for every mutation route. The durable key is
scoped by partner, and the stored fingerprint covers method, path, and exact body:

- New key: insert `processing`.
- Same key and fingerprint while processing: `409 idempotency_conflict` with
  `details.retryable=true`.
- Same key and different fingerprint/method/path: `409 idempotency_conflict`.
- Completed same request: replay the stored status and body.
- Failed previous attempt: atomically change it back to `processing` and retry.
- Work failure: mark the record `failed`.
- Success: store response status/body as `completed`.

Rows default to seven-day `expires_at`, but no cleanup job is implemented. The database unique
constraint remains effective until rows are removed.

The private idempotency key is deterministic:

```text
restec:{partnerId}:{public Idempotency-Key}:{operation}
```

from `derivePrivateIdempotencyKey` in `packages/paely-client/src/index.ts`. Retrying a public
operation therefore calls Paely with the same logical private key but a fresh request ID,
timestamp, and signature.

The code only requires a non-empty public idempotency key. The payment-session route additionally
rejects length over 200. Other mutation routes do not implement the OpenAPI document's 8–255
length rule.

### 6.5 Restec-to-Paely authentication

`PaelyClient.rawRequest` sends:

- `Authorization: Bearer {PAELY_PRIVATE_BEARER_TOKEN}`
- `X-Restec-Service-Id: {PAELY_SERVICE_ID}`
- `X-Restec-Environment: sandbox|production`
- `X-Restec-Timestamp`
- `X-Restec-Signature` using the request algorithm above and
  `PAELY_PRIVATE_SIGNING_SECRET`
- fresh `X-Request-Id`
- `Content-Type: application/json`
- stable `Idempotency-Key` when supplied

It attempts a request at most three times. Network failures and HTTP
408/425/429/500/502/503/504 are retryable. There is no delay or jitter between the three internal
attempts. Each attempt has `RESTEC_PRIVATE_REQUEST_TIMEOUT_MS`.

Raw Paely errors are replaced by `PrivateDependencyError`; `createApp` returns a generic public
dependency error. A malformed payment-session create success is explicitly rejected by
`privatePaymentSessionResponseSchema`. Bill responses are selected/sanitized but are not runtime
validated against a strict response schema.

### 6.6 Paely-to-Restec event authentication

`POST /api/internal/events/paely/v1` requires:

- `Content-Type: application/json`
- actual and declared payload size no greater than 1 MiB
- `X-Paely-Event-Id`, equal to body `id`
- `X-Paely-Timestamp`, within the configured tolerance
- `X-Paely-Signature`
- `X-Paely-Delivery-Attempt`, a safe integer at least 1

`signEvent`/`verifyEventSignature` use:

```text
v1=hex_lowercase(HMAC-SHA256(PAELY_EVENT_SIGNING_SECRET,
                            unix_timestamp + "." + exact_raw_body_bytes))
```

For an event containing `data.payment_session`, the receiver also requires:

- `X-Paely-Service-Id == PAELY_EVENT_SERVICE_ID`
- `X-Paely-Environment == current deployment environment`

Legacy/non-session payment events do not enforce those two identity headers; they still require
the shared event signature.

### 6.7 Restec-to-POS webhook authentication

`canonicalRestConnector.deliverEvent` sends:

- `Content-Type: application/json`
- `X-Restec-Event-Id`
- `X-Restec-Timestamp`
- `X-Restec-Signature` over `timestamp + "." + exact body`
- `X-Restec-Environment`
- `X-Restec-Delivery-Attempt`

The connection's decrypted `configuration.webhook_secret` is the signing secret.
`configuration.webhook_url` is the destination. The connector uses `redirect: manual` and the
configured POS timeout.

### 6.8 Internal jobs

Internal jobs accept either:

```text
Authorization: Bearer {RESTEC_INTERNAL_JOB_TOKEN}
```

or, when configured:

```text
Authorization: Bearer {CRON_SECRET}
```

No HMAC, timestamp, replay ID, or idempotency key is required on job routes. The reconcile routes
parse JSON directly and do not use the public 1 MiB middleware.

## 7. Forward bill and external-payment flows

### 7.1 Bill create/update

1. The POS signs and sends
   `PUT /v1/locations/{locationId}/bills/{externalBillId}` with a fresh request ID and stable
   idempotency key.
2. `publicAuth` authenticates exact bytes, timestamp, environment-scoped key, rate limit, and
   replay ID.
3. `idempotent` reserves the partner/idempotency record.
4. `connection` authorizes the public location to the authenticated partner and runtime
   environment.
5. `billSchema` validates a strict body:
   - `external_table_id` 1–128 characters.
   - optional external order ID 1–128.
   - positive integer version.
   - three-uppercase-letter currency.
   - bill status and order status enums.
   - 1–250 strict items.
   - integer minor amounts up to 2,147,483,647.
   - item `unit_amount * quantity == total_amount`.
   - subtotal equals item sum.
   - grand total equals subtotal + tax + service charge + tip − discount.
   - ISO datetime and at most 8 KiB of metadata.
6. `getTableMapping` must find an active mapping for this connection/external table.
7. `validateBillMutation` enforces:
   - a new bill must start at version 1;
   - an older version fails;
   - same version and different request hash fails;
   - same version and same hash replays local state;
   - a greater version proceeds.
8. Restec calls Paely's private bill PUT with private location ID and derived private
   idempotency key.
9. `PaelyClient.sanitizeBill` removes private fields. Restec adds:
   `restec_bill_id = "bil_" + first 24 hex characters of
SHA-256(connectionId + ":" + externalBillId)`.
10. `persist_restec_bill_state` locks the mapping and rechecks version/hash. It rejects a new
    total below already-paid minus refunded money. It persists the private bill reference and
    public projection.
11. Restec completes public idempotency and returns the sanitized state.

The final corrected SQL is in
`supabase/migrations/20260722000200_fix_persist_restec_bill_state.sql`. The preceding Phase 2
definition had an incorrect insert projection; deployments must apply all migrations in order.

### 7.2 Bill GET

The GET route authenticates and authorizes exactly like other `/v1` routes, then returns
`bill_mappings.public_state` with the current request ID overwritten in the response object. It
does not call Paely. This makes it the Restec-side recovery/read model after webhook downtime.

### 7.3 External POS payment

1. The POS sends a strict completed payment with external payment ID, allowed method, positive
   minor-unit amount, currency, occurred time, optional processor reference, and metadata.
2. `validateExternalPayment` requires an existing bill, then checks the external payment ID
   uniquely within the connection.
3. Same payment ID, bill, and hash replays. Reuse for a different bill/body conflicts.
4. Currency must match. `payment_in_progress` is rejected. Zero due or an amount greater than due
   is rejected.
5. Restec calls Paely's private external-payment route with the deterministic private key.
6. Paely returns a bill state; Restec sanitizes and persists it through
   `persist_restec_external_payment`.
7. The mapping stores a public payment ID:
   `pay_` plus 24 hex characters of `SHA-256(connectionId + ":" + externalPaymentId)`.

External-payment methods are `cash`, `card_terminal`, `wallet_terminal`, `voucher`, and `other`.
The strict schema rejects unknown top-level fields, so obvious raw card fields are rejected. No
card details are required or permitted.

## 8. Hosted payment-session flow

### 8.1 Feature and prerequisites

Payment sessions exist only when `RESTEC_PAYMENT_SESSIONS_ENABLED=true`. Startup then also requires
an HTTPS `RESTEC_CHECKOUT_PUBLIC_BASE_URL` and at least one comma-separated exact hostname in
`RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS`; entries containing `/` or `:` are rejected by
`loadConfig`.

The public create route additionally requires an exact `X-Restec-Environment` matching the
deployment. The input schema currently supports only:

```json
{
  "amount_minor": 10000,
  "currency": "PKR",
  "method": "card",
  "customer": {
    "email": "optional@example.invalid",
    "mobile": "03000000000"
  },
  "return_context": {
    "pos_reference": "optional-safe-reference"
  }
}
```

`google_pay` exists in the shared type/database check but is not accepted by the public request
schema. It is latent, not publicly implemented.

### 8.2 Create sequence

1. After public authentication, feature/environment checks, and public idempotency reservation,
   `containsCardholderData` recursively rejects keys named card number/PAN/CVV/CVC/expiry/
   expiration/PIN/OTP/track data/provider secrets.
2. The body is strictly parsed. Only PKR and `card` are accepted.
3. Restec authorizes the location and loads the existing bill.
4. A bill is payable only if:
   - order status is not `completed` or `cancelled`;
   - payment status is `unpaid`, `partially_paid`, or `failed`;
   - amount due is positive;
   - reconciliation status is exactly `matched`;
   - requested amount does not exceed due;
   - currency matches.
5. Restec derives:

   ```text
   rps_{test|live}_{first 26 hex of SHA-256(
     environment:partnerId:locationId:externalBillId:idempotencyKey
   )}
   ```

6. `reservePaymentSession` inserts a `creating` row before the private call. The production
   database's partial unique index allows only one active (`creating`,
   `requires_customer_action`, or `processing`) session per connection/bill.
7. Restec calls Paely's private session create route with:
   - private connection and location references;
   - amount, currency, method, optional customer contact;
   - Restec success/cancel URLs;
   - the public Restec session reference;
   - deterministic private idempotency key.
8. Restec accepts the private result only if status is exactly
   `requires_customer_action`, amount/currency match, and expiry is in the future. Although the
   private response schema also allows `processing`, `createApp` rejects it.
9. The provider URL is validated, encrypted, and attached with the private session reference and
   exact provider hostname.
10. Restec writes a sanitized audit entry and returns HTTP 201 containing only the Restec session
    ID, public location/bill, status, Restec checkout URL, amount, currency, method, expiry, and
    creation time.

Customer email/mobile and `return_context` are not stored in `payment_sessions`. `return_context`
is validated but is not forwarded or persisted by the current implementation.

### 8.3 Crash and duplicate behavior

The create-before-call/attach-after-call pattern is intentional:

- If Paely times out after committing, public idempotency becomes failed. A retry uses the same
  Restec session ID and same private idempotency key, so Paely must return the original session.
- If attachment succeeds but completing public idempotency fails, a retry finds the attached
  session and returns it without a second private create.
- A concurrent identical public request sees the idempotency record as processing and gets a
  retryable 409.
- A different idempotency key for the same active bill is blocked by the production partial
  unique index and mapped to `payment_in_progress`.
- A session stuck in `creating` without a private reference is audited for manual review by
  payment-session reconciliation; it becomes expired only when its expiry is processed.

The same-active-bill behavior is implemented in PostgreSQL but not mirrored by the memory
repository. It therefore lacks a completed local concurrency test against the real database.

### 8.4 Browser redirect and return

The public `checkout_url` always points to Restec:

```text
{RESTEC_CHECKOUT_PUBLIC_BASE_URL}/s/{rps_id}
```

The browser route:

1. Finds the opaque session in the current environment.
2. Re-authorizes its recorded partner/location/connection relationship.
3. If expired, transitions an active session to `expired` and returns 410.
4. Allows only `requires_customer_action` or `processing`.
5. Decrypts the provider URL.
6. Revalidates scheme, credentials, port, host, DNS, and stored-host equality.
7. Audits a customer redirect.
8. Returns a 303 redirect with no-store/no-referrer headers.

The return page reports `paid` only if the stored session is already paid; otherwise it says
confirmation is pending and refreshes. The cancel page can set only
`requires_customer_action -> cancelled`. Neither page accepts provider parameters as truth.

The authenticated session status GET does not itself expire an overdue session. Expiry occurs
when the browser redirect is opened or when the reconciliation job processes the row.

## 9. Paely event, Restec projection, and POS update flow

### 9.1 Event validation and mapping

After event authentication, `privateEvent` in `apps/api/src/app.ts` strictly parses:

- private event ID and one of completed/failed/expired/refunded/partially-refunded;
- schema version and created time;
- private connection and location UUIDs;
- external bill/table IDs;
- private payment ID, amount, currency, method, and status;
- optional private/public payment-session association;
- complete bill projection.

The receiver requires schema version `2026-07-01`, resolves the private connection reference to an
active Restec connection, checks environment, and requires the private location reference to
match.

It then constructs a public `CanonicalRestecEvent`:

- public event: `evt_` + 24 hex characters of `SHA-256(privateEventId)`;
- public payment: `pay_` + 20 hex characters of `SHA-256(privatePaymentId)`;
- public location from the Restec connection;
- external bill/table IDs retained because they belong to the POS contract;
- optional Restec payment-session ID copied from
  `restec_payment_session_reference`;
- private payment method mapped to the public allowed set or `other`;
- public payment status derived from event type;
- bill projection validated by `eventSchema`.

No private event ID, private payment ID, private location/connection UUID, private session ID, or
provider URL is placed in the POS payload.

### 9.2 Non-session event transaction

`SupabaseRepository.acceptPrivateEvent` calls `accept_private_event`, whose current definition is
in `20260718000100_restec_final_integration.sql`. In one database transaction it:

1. Inserts `private_event_inbox` keyed by private event ID and request hash.
2. For an exact duplicate, returns the existing public outbox event.
3. For the same private event ID with a different hash, raises `replay_detected`.
4. Updates exactly one matching bill projection and marks reconciliation `matched`.
5. Inserts exactly one `pos_outbox_events` row with the private event ID as deduplication key.

Restec returns 202 for a new event and 200 for an exact duplicate. It does not wait for the POS.

### 9.3 Payment-session event transaction

`SupabaseRepository.acceptPaymentSessionEvent` calls `accept_payment_session_event` from
`20260723000100_payment_sessions.sql`. It:

1. Inserts/deduplicates the private inbox event and checks hash reuse.
2. Looks up the public session by Restec reference and connection.
3. If unmatched, changes the inbox status to `review_required`, writes an audit row, and creates no
   POS outbox event.
4. If matched, applies the session transition derived from event type.
5. Updates exactly one matching bill projection.
6. Inserts one POS outbox event.

The transaction uses the public Restec session reference and connection. It currently does **not**
cross-check the event's `private_payment_session_id` against the stored private reference, does not
check session amount/currency against event payment amount/currency, and ignores the nested
`payment_session.status` in favor of the event type. Those are material hardening items.

### 9.4 POS dispatch

The separate dispatcher releases expired leases, claims up to
`RESTEC_DISPATCH_BATCH_SIZE` rows for 60 seconds, resolves the connector/version, serializes the
canonical event, validates the destination, sends it, and records an atomic outcome. Paely has
already received 202/200 before this delivery begins.

## 10. Database model and relationships

The effective schema is the ordered result of all migrations:

1. `20260717000100_restec_foundation.sql`
2. `20260717000200_restec_phase_2.sql`
3. `20260718000100_restec_final_integration.sql`
4. `20260722000100_atomic_sandbox_credentials.sql`
5. `20260722000200_fix_persist_restec_bill_state.sql`
6. `20260723000100_payment_sessions.sql`

All integration tables have RLS enabled. The foundation revokes table access from `anon` and
`authenticated`; only `partner_users` has a narrow authenticated self-select policy. Server
operations use the Supabase service role and security-definer RPCs. Browser code must never receive
the service-role key.

### 10.1 Tenant and credential tables

| Table           | Important fields and relationships                                                                 | Purpose                                           |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `partners`      | `id ptr_*`, name, status                                                                           | POS company/integration tenant                    |
| `partner_users` | auth user FK -> partner; role owner/admin/developer/viewer                                         | Future portal membership; current portal disabled |
| `restaurants`   | partner FK                                                                                         | Restaurant grouping under POS company             |
| `locations`     | restaurant FK, environment, private Paely location UUID                                            | Public location and private mapping               |
| `api_keys`      | partner FK, environment, unique prefix, scrypt hash, encrypted signing secret, status/expiry/usage | Partner-scoped POS request credential             |

### 10.2 Connection and table mapping

| Table               | Important fields and relationships                                                                                       | Purpose                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `pos_connections`   | partner/location FKs, environment, connector type/version/status, encrypted configuration, private Paely connection UUID | One connector instance; unique per location/environment/connector type |
| `pos_tables`        | location FK, `tbl_*`, name                                                                                               | Restec public table                                                    |
| `table_mappings`    | connection FK, external table ID, Restec table FK, private Paely table UUID, active                                      | Three-way POS/Restec/Paely table mapping                               |
| `webhook_endpoints` | connection FK, URL, encrypted signing secret, active/disabled                                                            | Enrollment/audit-style storage; not read by current dispatcher         |

The dispatcher's runtime source of destination and secret is decrypted
`pos_connections.encrypted_configuration`, not `webhook_endpoints`. The sandbox credential script
writes both, but only the connection configuration is used by `authorizeLocation` and connector
delivery.

### 10.3 Financial mappings

| Table               | Important fields and relationships                                                                                                                                | Purpose                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `bill_mappings`     | connection FK + external bill unique; public Restec bill unique; private Paely bill reference; version/hash/status/public JSON state                              | Durable Restec bill projection and mapping      |
| `external_payments` | connection and bill FKs; external payment unique by connection; public Restec payment; request hash, amount/currency/status/public state                          | POS-originated completed payment dedupe/mapping |
| `payment_sessions`  | partner/connection/location FKs; public/private references; encrypted provider URL; host; method/amount/currency/status/expiry/timestamps/idempotency/fingerprint | Hosted-payment projection                       |

`payment_sessions` has:

- unique public ID;
- unique partner/location/bill/idempotency key;
- a partial unique index allowing one active session per connection/bill;
- index by connection/bill, private reference, and status/expiry;
- no customer contact or cardholder columns.

### 10.4 Reliability and evidence

| Table                       | Important fields and relationships                                                                      | Purpose                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `idempotency_records`       | unique partner/key, method/path/hash, processing/completed/failed, stored response, seven-day expiry    | Public mutation replay                        |
| `replay_records`            | request ID PK, partner, hash, environment, signed timestamp, ten-minute expiry                          | Signed request replay prevention              |
| `private_event_inbox`       | private event unique, connection FK, hash, private payload, status/times                                | Durable Paely acceptance/dedupe               |
| `pos_outbox_events`         | public event unique, connection FK, payload, dedupe key, status, attempts, next time, lease, last error | POS delivery queue                            |
| `webhook_delivery_attempts` | outbox FK + attempt unique, response status, outcome, safe error code, duration                         | Delivery evidence; no response body           |
| `mock_pos_receipts`         | public event unique, connection FK, body hash/type/time                                                 | Sandbox dummy-receiver evidence               |
| `sandbox_scenarios`         | connection FK, scenario, bill, amount, event, status                                                    | Non-production scenario record                |
| `audit_logs`                | optional partner/connection/request relations, actor/action/result/target, sanitized metadata           | Controlled operator/service/customer evidence |

The foreign keys use `ON DELETE RESTRICT` for financial and reliability history. Rollback notes in
every migration instruct operators to preserve evidence.

### 10.5 Service-role RPCs

| Function                            | Purpose                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| `accept_private_event`              | Inbox dedupe + bill projection + POS outbox                     |
| `claim_pos_outbox`                  | `FOR UPDATE SKIP LOCKED` claim with expiring lease              |
| `persist_restec_bill_state`         | Locked bill version/hash/amount projection                      |
| `persist_restec_external_payment`   | Locked payment dedupe/amount projection                         |
| `complete_pos_outbox_delivery`      | Attempt insert + delivered state                                |
| `fail_pos_outbox_delivery`          | Attempt insert + retry/dead-letter state                        |
| `release_expired_pos_outbox_leases` | Return expired processing rows to pending                       |
| `replay_pos_outbox_event`           | Dead-letter public event ID -> pending                          |
| `store_sandbox_credentials`         | Atomic sandbox API/signing/connector/webhook credential storage |
| `transition_payment_session`        | Central SQL session transition                                  |
| `accept_payment_session_event`      | Session event inbox + session/bill projection + outbox          |

All are revoked from public; the application-relevant functions are granted to `service_role`.

## 11. State machines

### 11.1 Payment-session state machine

The canonical TypeScript state machine is `transitionPaymentSessionStatus` in
`packages/contracts/src/payment-session-state.ts`; SQL mirrors it in
`transition_payment_session`.

| From                       | Allowed next states                                                   |
| -------------------------- | --------------------------------------------------------------------- |
| `creating`                 | `requires_customer_action`, `processing`, `paid`, `failed`, `expired` |
| `requires_customer_action` | `processing`, `paid`, `failed`, `expired`, `cancelled`                |
| `processing`               | `paid`, `failed`, `expired`, `cancelled`                              |
| `paid`                     | `partially_refunded`, `refunded`                                      |
| `failed`                   | `paid`                                                                |
| `expired`                  | `paid`                                                                |
| `cancelled`                | `paid`                                                                |
| `partially_refunded`       | `partially_refunded`, `refunded`                                      |
| `refunded`                 | none                                                                  |

A transition to the current state is a no-op. The critical rule is that a late authoritative
`paid` event wins over local failed/expired/cancelled state, while `paid` can never go backward to
failed or cancelled. Tests are in
`packages/contracts/src/payment-session-state.test.ts` and
`apps/api/src/payment-sessions.test.ts`.

### 11.2 Bill/order/payment state

There is no single central bill state-machine function. The effective rules are distributed:

- POS input `status`: `open`, `completed`, `cancelled`.
- POS input `order_status`: `open`, `accepted`, `preparing`, `ready`, `served`, `completed`,
  `cancelled`.
- Public payment status schema: `unpaid`, `payment_in_progress`, `partially_paid`, `paid`,
  `partially_refunded`, `refunded`, `failed`.
- Bill creates at version 1; updates require a strictly greater version unless exact replay.
- Bill total cannot be reduced below net committed paid amount.
- External payment cannot exceed due, use another currency, apply at zero due, or apply while
  payment is in progress.
- Session create rejects completed/cancelled orders and non-payable payment states.
- Signed private events replace the committed bill amount/payment fields after schema consistency
  checks.
- A paid projection must have amount due zero, and amount due must equal
  `max(0, grand_total - amount_paid + amount_refunded)`.

These checks are in `billSchema`, `eventSchema`, `createApp`, repository preflights, and SQL RPCs.
The system does not validate a complete allowed order-status transition graph. It accepts the
sanitized Paely state after forward calls and the signed event projection after reverse calls.

## 12. Public identifier isolation

Public formats are declared in `packages/contracts/src/index.ts`:
`ptr_`, `rst_`, `loc_`, `tbl_`, `con_`, `bil_`, `pay_`, `evt_`, `req_`, and
`rps_test_`/`rps_live_`.

Mappings are:

| Private/source value                                    | Public representation            | Algorithm/storage               |
| ------------------------------------------------------- | -------------------------------- | ------------------------------- |
| POS external bill ID + Restec connection                | `bil_...`                        | First 24 SHA-256 hex characters |
| POS external payment ID + Restec connection             | `pay_...`                        | First 24 SHA-256 hex characters |
| Paely private payment ID                                | `pay_...`                        | First 20 SHA-256 hex characters |
| Paely private event ID                                  | `evt_...`                        | First 24 SHA-256 hex characters |
| Hosted session scope + public idempotency key           | `rps_test_...` or `rps_live_...` | First 26 SHA-256 hex characters |
| Paely location/connection/table/bill/session references | No public echo                   | Restricted mapping columns      |

These are truncated deterministic hashes, not reversible encryption and not globally collision
proof. Database uniqueness constraints detect a collision in their stored scope. Public Restec IDs
are safe routing/mapping identifiers, not secrets.

## 13. Checkout URL encryption and redirect protection

`encryptSecret`/`decryptSecret` in `packages/security/src/index.ts` use AES-256-GCM:

- 32-byte base64 key;
- random 12-byte IV;
- authentication tag;
- base64url `iv.tag.ciphertext` storage.

For provider checkout URLs:

1. Creation requires a parseable URL.
2. Scheme must be HTTPS.
3. Username, password, explicit port, IP-literal host, localhost, `.local`, `.internal`, and
   unlisted hosts are rejected.
4. The hostname must exactly equal one configured allowlist entry; suffix/wildcard matches are
   not used.
5. DNS must return at least one address, and every returned address must be non-private according
   to `privateAddress`.
6. Only ciphertext and exact lowercase host are stored.
7. Redirect time repeats URL and DNS checks after decryption and requires equality with the stored
   host.
8. The provider URL is never logged or returned to the POS API. Only the browser receives it in a
   303 `Location` header.

Implementation and tests:
`assertCheckoutDestination`, `assertResolvedCheckoutDestination`, and
`apps/api/src/payment-sessions.test.ts`.

## 14. Inbox, outbox, delivery, retries, and dead letters

### 14.1 Claiming and leasing

`claim_pos_outbox` atomically changes eligible pending or expired-processing rows to `processing`,
sets `locked_at` and a 60-second `lock_expires_at`, orders by creation, uses
`FOR UPDATE SKIP LOCKED`, and caps requests at 100. Before each batch, the dispatcher calls
`release_expired_pos_outbox_leases`.

### 14.2 Destination and connector

The registry supports exactly:

- `canonical_rest` version `1.0.0`;
- `mock_pos` version `1.0.0`.

Unknown, disabled, or version-mismatched connectors fail the attempt. `canonical_rest` parses the
canonical event, serializes one JSON body, signs those exact bytes, and performs a manual-redirect
POST. `mock_pos` simulates outcomes and does not call the destination.

`assertSafeWebhookUrl` blocks credential-bearing URLs, named localhost/metadata hosts, resolved
loopback/private/link-local IPv4, and selected unsafe IPv6 ranges. Production requires HTTPS.
Sandbox/test may use HTTP. Unlike checkout validation, the webhook validator currently allows an
explicit port and a public IP-literal destination, and does not cover every reserved/multicast
range.

### 14.3 Outcome classes

- Delivered: HTTP 200, 201, 202, or 204.
- Retry: network/timeout, 408, 425, 429, 500, 502, 503, or 504.
- Permanent: every other HTTP response.
- Internal connector/serialization/destination/delivery exception: retry with a safe phase error.

No POS response body is persisted.

### 14.4 Retry schedule

`retryDelaySeconds` returns:

| Failed attempt | Next delay |
| -------------- | ---------- |
| 1              | 30 seconds |
| 2              | 2 minutes  |
| 3              | 10 minutes |
| 4              | 30 minutes |
| 5              | 2 hours    |
| 6              | 6 hours    |
| 7 and later    | 12 hours   |

At `RESTEC_MAX_DELIVERY_ATTEMPTS` (default 10), a retryable failure becomes permanent and the row
is `dead_letter`. A permanent response dead-letters immediately. The attempt row and outbox state
are written in one RPC.

### 14.5 Replay

`ReconciliationService.requeueEvent` calls `replay_pos_outbox_event` using the public `evt_` ID.
Only a dead-letter row can be requeued. It retains its event ID, payload, attempt history, and
attempt count; the function resets scheduling/lease/error fields but does not reset
`attempt_count`. The action is audited by service code.

## 15. Dummy POS and sandbox certification

### 15.1 Seed

`supabase/seed.sql` is explicitly non-production and creates:

- partner `ptr_sandbox_demo`;
- one restaurant and one location;
- canonical and mock connections;
- five public tables and external mappings `EXT-01` through `EXT-05`;
- one active and one disabled webhook endpoint;
- placeholder encrypted values requiring the credential script.

### 15.2 Credential creation

`scripts/create-sandbox-credentials.ts` refuses non-sandbox operation, verifies the hosted
Supabase project/service role/schema/seed, creates:

- one `rst_test_` API key;
- one partner request-signing secret;
- one POS webhook secret;

and atomically stores the API hash, encrypted request secret, encrypted connector configuration,
and encrypted endpoint secret via `store_sandbox_credentials`. It reads all values back and prints
the three plaintext credentials once only after verification. It is a credential rotation/create
operation, not merely a destination edit.

### 15.3 Configure the deployed dummy receiver

`scripts/configure-sandbox-mock-pos.ts` requires both
`RUN_REMOTE_SANDBOX_TESTS=true` and `RESTEC_ENV=sandbox`. It decrypts the canonical sandbox
connection, preserves its webhook secret, replaces only `webhook_url`, re-encrypts it, and verifies
read-back through `SupabaseRepository.authorizeLocation`.

### 15.4 Dummy receiver

`POST /api/test/mock-pos-webhook`:

- exists only in sandbox;
- requires exact JSON bytes no larger than 1 MiB;
- looks up the event's connection and signing secret from the outbox/connection configuration;
- requires `X-Restec-Environment: sandbox`;
- verifies timestamp and event signature;
- parses the strict public event and checks header/body event ID equality;
- inserts one `mock_pos_receipts` row;
- treats an identical duplicate as success and conflicting reuse as replay;
- returns 204.

It does not require or validate `X-Restec-Delivery-Attempt`, although the canonical connector sends
that header.

### 15.5 Real certification runner

`scripts/certify-real-payment-session.ts` is sandbox-only and explicitly gated by
`RUN_REAL_PAYMENT_SESSION_CERTIFICATION=true`. It:

1. Checks deployed sandbox health.
2. Creates a fresh bill.
3. Creates a real session and requires `requires_customer_action`.
4. Prints only the Restec-origin checkout URL.
5. Pauses for a human to enter provider sandbox card data.
6. Polls the signed Restec status endpoint for `paid`.
7. Invokes the dispatcher.
8. Polls protected evidence until outbox delivery and dummy receipt.
9. Prints a sanitized PASS/FAIL record.

`--verify` can inspect preserved evidence without recreating the session. The repository contains
no passing remote output, so real certification remains blocked/unverified.

## 16. Environment separation, flags, and variables

### 16.1 Runtime API variables

The authoritative schema is `apps/api/src/config.ts`. “Secret” means it must be stored only in a
server-side secret manager/Vercel environment and never in source, browser, POS payload, or logs.

| Variable                                     | Required/default                                   | Secret?                          | Owner and matching rule                                            | Actual use                                                             |
| -------------------------------------------- | -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `NODE_ENV`                                   | default `development`; development/test/production | No                               | API runtime                                                        | Suppresses config log in test; local server behavior                   |
| `RESTEC_ENV`                                 | Required: sandbox/production/test                  | No                               | Restec deployment                                                  | Selects credential/data environment; test maps public auth to sandbox  |
| `RESTEC_REPOSITORY_DRIVER`                   | Required; memory/supabase                          | No                               | Restec                                                             | Must be `supabase` in sandbox/production                               |
| `RESTEC_PUBLIC_BASE_URL`                     | Required URL; HTTPS in production                  | No                               | Restec                                                             | Sanitized config/operations; certification base                        |
| `RESTEC_PAYMENT_SESSIONS_ENABLED`            | default false                                      | No                               | Restec                                                             | Hides create/status/browser routes and disables session reconciliation |
| `RESTEC_PAYMENT_SESSION_TTL_SECONDS`         | default 900; 300–3600                              | No                               | Restec                                                             | Pre-create local expiry                                                |
| `RESTEC_CHECKOUT_PUBLIC_BASE_URL`            | Required HTTPS only when sessions enabled          | No                               | Restec                                                             | Builds Restec checkout and Paely return/cancel URLs                    |
| `RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS`      | Required exact hosts only when sessions enabled    | Sensitive config, not credential | Must match actual approved Paely/provider-hosted response hostname | Provider redirect allowlist                                            |
| `RESTEC_PAYMENT_SESSION_RETURN_POLL_SECONDS` | default 2; 1–30                                    | No                               | Restec                                                             | HTML return-page refresh                                               |
| `RESTEC_DATABASE_URL`                        | Optional                                           | Secret if populated              | Restec/Supabase                                                    | Parsed but unused by current runtime                                   |
| `SUPABASE_URL`                               | Required with Supabase driver                      | Sensitive config                 | Must be the intended environment project                           | Server repository                                                      |
| `SUPABASE_SERVICE_ROLE_KEY`                  | Required with Supabase driver, min 16              | **Yes**                          | Must match `SUPABASE_URL` project/environment                      | Server-only RLS-bypassing client                                       |
| `PAELY_PRIVATE_BASE_URL`                     | Required URL                                       | Sensitive internal               | Must be Paely private origin for same environment                  | Private client base                                                    |
| `PAELY_SERVICE_ID`                           | Required non-empty                                 | Internal identity                | Must equal Paely's allowed Restec service identity                 | Private outbound header                                                |
| `PAELY_PRIVATE_BEARER_TOKEN`                 | Required, min 16                                   | **Yes**                          | Must match Paely environment                                       | Private outbound bearer                                                |
| `PAELY_PRIVATE_SIGNING_SECRET`               | Required, min 16                                   | **Yes**                          | Exact shared value configured in Paely                             | Private request HMAC                                                   |
| `PAELY_EVENT_SIGNING_SECRET`                 | Required, min 16                                   | **Yes**                          | Exact shared Paely event-signing value                             | Private inbound event HMAC                                             |
| `PAELY_EVENT_SERVICE_ID`                     | default `paely`                                    | Internal identity                | Must exactly match Paely event sender header for session events    | Additional session-event identity                                      |
| `RESTEC_API_KEY_HASH_SECRET`                 | Required, min 32                                   | **Yes**                          | Restec environment-specific pepper                                 | scrypt API-key hashing                                                 |
| `RESTEC_SECRET_ENCRYPTION_KEY`               | Required base64 32 bytes                           | **Yes**                          | Restec environment-specific; preserve for decryptability           | AES-GCM request/connector/checkout secrets                             |
| `RESTEC_WEBHOOK_MASTER_KEY`                  | Required only by production config                 | **Yes**                          | Restec                                                             | Currently unused after startup validation                              |
| `RESTEC_TIMESTAMP_TOLERANCE_SECONDS`         | default 300; 30–900                                | No                               | Restec/partners/Paely clocks                                       | Public, private event, and dummy timestamp window                      |
| `RESTEC_PRIVATE_REQUEST_TIMEOUT_MS`          | default 5000; 500–30000                            | No                               | Restec                                                             | Per Paely attempt                                                      |
| `RESTEC_POS_DELIVERY_TIMEOUT_MS`             | default 5000; 500–30000                            | No                               | Restec                                                             | Per POS attempt                                                        |
| `RESTEC_MAX_DELIVERY_ATTEMPTS`               | default 10; 1–50                                   | No                               | Restec                                                             | Dead-letter threshold                                                  |
| `RESTEC_DISPATCH_BATCH_SIZE`                 | default 25; 1–100                                  | No                               | Restec                                                             | Outbox claim size                                                      |
| `RESTEC_INTERNAL_JOB_TOKEN`                  | Required, min 16                                   | **Yes**                          | Restec scheduler/operator                                          | Job and evidence bearer                                                |
| `RESTEC_STRICT_RATE_LIMITING`                | default false                                      | No                               | Restec                                                             | Fails public requests closed when enabled without limiter              |
| `RESTEC_SHARED_RATE_LIMITER_URL`             | Optional URL                                       | Sensitive config                 | Shared limiter service                                             | Enables `HttpSharedRateLimiter`                                        |
| `RESTEC_SHARED_RATE_LIMITER_TOKEN`           | Optional, min 16                                   | **Yes**                          | Must match limiter service                                         | Limiter bearer                                                         |
| `CRON_SECRET`                                | Optional except required in production             | **Yes**                          | Vercel/external scheduler                                          | Alternate internal-job bearer                                          |
| `PORT`                                       | default 3000 in local entry                        | No                               | Local runtime                                                      | `apps/api/src/index.ts` only                                           |

Production startup additionally requires `RESTEC_WEBHOOK_MASTER_KEY` and `CRON_SECRET`. If strict
rate limiting is enabled in production, both shared limiter variables are mandatory.

### 16.2 Setup/test/certification variables

| Variable                                  | Scope                     | Secret?          | Use                                                |
| ----------------------------------------- | ------------------------- | ---------------- | -------------------------------------------------- |
| `RUN_REMOTE_SANDBOX_TESTS`                | Scripts/tests             | No               | Explicitly permits remote sandbox writes/tests     |
| `RUN_DATABASE_INTEGRATION`                | DB integration test       | No               | Alternate explicit database test gate              |
| `RUN_REAL_PAELY_SANDBOX_CERTIFICATION`    | Paely prerequisite script | No               | Permits real Paely sandbox prerequisite check      |
| `RUN_REAL_PAYMENT_SESSION_CERTIFICATION`  | Real session runner       | No               | Permits real remote payment test                   |
| `RESTEC_SANDBOX_TEST_API_KEY`             | Sandbox scripts           | **Yes**          | Issued `rst_test_` key                             |
| `RESTEC_SANDBOX_REQUEST_SIGNING_SECRET`   | Sandbox scripts           | **Yes**          | Matching API-key request HMAC secret               |
| `RESTEC_SANDBOX_LOCATION_ID`              | Sandbox scripts           | No               | Public seeded/onboarded location                   |
| `RESTEC_SANDBOX_PARTNER_ID`               | Reconcile script          | No               | Public partner                                     |
| `RESTEC_SANDBOX_EXTERNAL_TABLE_ID`        | Sandbox scripts           | No               | Defaults `EXT-01`                                  |
| `RESTEC_SANDBOX_EXTERNAL_BILL_ID`         | Sandbox scripts           | No               | Optional target bill                               |
| `RESTEC_SANDBOX_MOCK_POS_URL`             | Config script             | Sensitive config | Approved HTTPS dummy receiver; exact path required |
| `RESTEC_CERTIFICATION_TIMEOUT_SECONDS`    | Certification             | No               | Defaults 900                                       |
| `RESTEC_CERTIFICATION_EXTERNAL_BILL_ID`   | Verify mode               | No               | Preserved evidence                                 |
| `RESTEC_CERTIFICATION_PAYMENT_SESSION_ID` | Verify mode               | No               | Preserved public session                           |
| `RESTEC_CERTIFICATION_INITIAL_STATUS`     | Verify mode               | No               | Must be `requires_customer_action`                 |

`.env.example` also contains `PORTAL_AUTH_REDIRECT_URL` and `DOCS_PUBLIC_BASE_URL`; no current
application code reads them. Public language samples use example-only
`RESTEC_API_KEY`, `RESTEC_REQUEST_SIGNING_SECRET`, and `RESTEC_WEBHOOK_SIGNING_SECRET`; these are
not API runtime variables.

### 16.3 Environment isolation

- Use separate Supabase projects, Paely tenants/origins, API keys, HMAC secrets, encryption keys,
  job secrets, limiter credentials, and Vercel projects for sandbox and production.
- A production API accepts only `rst_live_`; sandbox/test accepts only `rst_test_`.
- Location and connection rows carry an environment and are authorized against deployment.
- Paely client sends its environment on every private request.
- Payment-session Paely events carry and verify an environment header.
- Sandbox scenario, dummy receiver, and evidence routes are unavailable outside sandbox.
- Seed and credential creation explicitly forbid production.
- Production payment sessions must remain disabled until real certification and review.

## 17. Partner, restaurant, location, and connection credentials

The hierarchy is:

```text
partner (POS company)
├── partner_users (future portal roles)
├── api_keys (partner-wide, environment-scoped)
└── restaurants
    └── locations (environment + private Paely location mapping)
        ├── pos_connections (connector instances)
        │   ├── table_mappings
        │   ├── bill/payment/session mappings
        │   ├── webhook/outbox/delivery data
        │   └── private Paely connection mapping
        └── pos_tables
```

One partner may own many restaurants and locations. API credentials are partner-wide, not
location-specific; every request then performs location authorization. API keys may overlap during
rotation through `active` and `overlap` states, but the repository has no enabled portal/admin API
to create, rotate, or revoke them. Operators must use controlled provisioning.

Phase 2 changed connection uniqueness from one connection per location/environment to one per
location/environment/connector type. `SupabaseRepository.authorizeLocation` orders active
connections by `connector_type` and takes the first. Public callers cannot choose a connection ID.
With multiple active connector types, this alphabetical selection is deterministic but not an
explicit business routing policy. The sandbox seed relies on `canonical_rest` sorting before
`mock_pos`.

The canonical connection configuration currently carries both `webhook_url` and
`webhook_secret`, encrypted as one JSON object. `webhook_endpoints` separately stores URL and
encrypted secret but is not consulted during dispatch. Both copies must be kept operationally
consistent until the model is consolidated.

## 18. Implemented-status matrix

| Capability                                     | Status                                                     | Evidence or blocker                                                      |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Strict canonical bill/external payment schemas | **Implemented and locally tested**                         | `contracts.test.ts`, mock E2E                                            |
| Public bearer/HMAC/timestamp/replay auth       | **Implemented and locally tested**                         | `auth.ts`, `security.test.ts`, mock E2E                                  |
| Supabase API-key auth and durable records      | **Implemented, remote-gated**                              | `SupabaseRepository`; DB tests skipped locally                           |
| Bill forward flow and private sanitization     | **Implemented and mock-tested**                            | `mock.e2e.test.ts`, Paely client tests                                   |
| Real Paely bill/external-payment calls         | **Not remotely certified here**                            | Private server absent; certification flag not run                        |
| External payment duplicate/amount guards       | **Implemented; DB concurrency not fully certified**        | repository code/RPC; no full remote matrix                               |
| Private event receive and public mapping       | **Implemented and locally tested**                         | `app.test.ts`, `mock.e2e.test.ts`                                        |
| Atomic PostgreSQL inbox/projection/outbox      | **Implemented, remote-gated**                              | RPC and skipped DB integration test                                      |
| POS canonical signed webhook                   | **Implemented and mock-tested**                            | canonical connector server test                                          |
| Retry/dead-letter/lease RPCs                   | **Implemented; deployed scheduler/alerts unverified**      | migration, dispatcher, retry unit test                                   |
| Manual replay                                  | **Implemented service path; no admin UI**                  | reconcile job and RPC                                                    |
| Payment-session public create/status           | **Implemented and mock-tested**                            | payment session tests                                                    |
| Encrypted/allowlisted browser redirect         | **Implemented and mock-tested**                            | payment session tests                                                    |
| Authoritative session event overrides cancel   | **Implemented and mock-tested**                            | payment session/state tests                                              |
| Real provider-hosted payment lifecycle         | **Blocked/not certified**                                  | Paely create/status/provider webhook not proven                          |
| Session reconciliation                         | **Partially implemented**                                  | Updates session only; does not repair bill/outbox                        |
| Sandbox scenarios                              | **Partially tested**                                       | partial/duplicate/429 local tests; full scenario matrix not run remotely |
| Dummy POS receiver/evidence                    | **Implemented and mock-tested**                            | payment session test; remote run absent                                  |
| Rate limiting                                  | **Optional implementation; production provider undecided** | partner/path + failed-auth source limiter                                |
| Portal/admin plane                             | **Designed only/disabled**                                 | static UI; `DisabledPortalAdminService`                                  |
| Real POS vendor connectors                     | **Not implemented/certified**                              | only canonical and mock connectors                                       |
| Monitoring/on-call/cleanup jobs                | **Not implemented in repository**                          | external operational blocker                                             |
| Vercel build/runtime                           | **Implemented and locally verified**                       | runtime verifier and successful build                                    |
| Production enablement                          | **Blocked**                                                | checklist, secrets, remote DB/provider/POS certification, monitoring     |

## 19. Manual Supabase and Vercel deployment

This sequence is intentionally manual. It does not authorize an automatic production deployment.

### 19.1 Pre-deployment

From PowerShell at repository root:

```powershell
node --version
npm ci
npm run verify
git status --short
```

Require Node 24.x because root and API package engines specify `24.x`. Note that
`.github/workflows/phase2.yml` currently configures Node 22 and should be corrected before treating
CI as equivalent to production build settings.

Record the reviewed commit SHA:

```powershell
git rev-parse HEAD
```

Do not continue if the intended deployment commit or environment assignments are ambiguous.

### 19.2 Supabase sandbox

1. Back up the sandbox database using the team's approved Supabase backup procedure.
2. Put the sandbox project reference in the current shell without printing it:

   ```powershell
   $env:RESTEC_SANDBOX_PROJECT_REF = '<sandbox-project-ref>'
   ```

3. Authenticate and link:

   ```powershell
   npx supabase login
   npx supabase link --project-ref $env:RESTEC_SANDBOX_PROJECT_REF
   ```

4. Review migration order:

   ```powershell
   Get-ChildItem supabase/migrations -Filter '*.sql' |
     Sort-Object Name |
     Select-Object -ExpandProperty Name
   npx supabase db push --dry-run
   ```

5. Apply all migrations and sandbox seed:

   ```powershell
   npx supabase db push --include-seed
   ```

6. Set a local, ignored `.env` with sandbox `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `RESTEC_API_KEY_HASH_SECRET`, and
   `RESTEC_SECRET_ENCRYPTION_KEY`. Never echo them.
7. Create sandbox credentials once:

   ```powershell
   $env:RESTEC_ENV = 'sandbox'
   npm run create:sandbox-credentials
   ```

8. Capture the displayed API/request/webhook credentials directly into the approved secret
   manager. The command intentionally cannot display them again.
9. Run the SQL verification in section 20 before API traffic.

For production, link a separate production project, run only the reviewed migration push **without
seed**, and do not run the sandbox credential script:

```powershell
npx supabase link --project-ref '<production-project-ref>'
npx supabase db push --dry-run
npx supabase db push
```

Never use `supabase db reset --linked` against production.

### 19.3 Vercel API projects

Create or use two separate projects with these repository-verified settings
(`docs/VERCEL_DEPLOYMENT.md`, `apps/api/vercel.json`):

| Setting                   | Sandbox                 | Production               |
| ------------------------- | ----------------------- | ------------------------ |
| Project                   | dedicated sandbox API   | dedicated production API |
| Root Directory            | `apps/api`              | `apps/api`               |
| Framework Preset          | Other                   | Other                    |
| Build Command             | `npm run build`         | `npm run build`          |
| Output Directory          | `public`                | `public`                 |
| Node                      | 24.x                    | 24.x                     |
| Outside-root source files | Enabled                 | Enabled                  |
| Domain                    | `sandbox-api.restec.io` | `api.restec.io`          |

Assign every runtime variable from section 16 to only the intended Vercel environment. Production
must use production Supabase/Paely/secrets and
`RESTEC_PAYMENT_SESSIONS_ENABLED=false`.

Before redeploying, locally verify the compiled runtime:

```powershell
npm run build:api
npm run verify:vercel-runtime
```

Deploy the reviewed commit through the existing Vercel project/repository integration. The
repository does not define a safe scripted production-deploy command. After sandbox deployment:

```powershell
$sandboxBase = 'https://sandbox-api.restec.io'
$health = Invoke-RestMethod -Method Get -Uri "$sandboxBase/health"
$health | ConvertTo-Json -Compress
```

Require `status=ok`, `environment=sandbox`, and `version=1.0.0`.

Configure the sandbox dummy destination only after the deployed URL is known:

```powershell
$env:RUN_REMOTE_SANDBOX_TESTS = 'true'
$env:RESTEC_ENV = 'sandbox'
$env:RESTEC_SANDBOX_MOCK_POS_URL =
  'https://sandbox-api.restec.io/api/test/mock-pos-webhook'
npm run configure:sandbox-mock-pos
```

Configure an external scheduler to POST the dispatcher with a protected bearer token. The
repository's `vercel.json` contains no cron schedule. Schedule session reconciliation separately
if the feature is enabled.

Promote the same reviewed build to production only after all readiness gates in section 23.

## 20. End-to-end tests and SQL verification

### 20.1 Local non-remote verification

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e:mock
npm run validate:openapi
npm run validate:public-artifacts
npm run test:leakage
npm run check:migrations
npm run build
```

Or:

```powershell
npm run verify
```

Read skipped tests as skipped, never as passed.

### 20.2 Local Supabase path

Requires Docker Desktop:

```powershell
npm run db:start
npm run db:reset
npm run db:lint
npm run db:types
npx supabase status -o env
```

Set the returned local API URL and service-role key in the current shell, then:

```powershell
$env:RUN_DATABASE_INTEGRATION = 'true'
npm run test:database
```

`db:types` writes `packages/database/src/database.types.ts`, which is not currently committed or
imported. Review any generated file before committing.

### 20.3 Remote sandbox database tests

After confirming the variables point to sandbox:

```powershell
$env:RESTEC_ENV = 'sandbox'
$env:RUN_REMOTE_SANDBOX_TESTS = 'true'
npm run test:remote-sandbox
```

These tests create disposable bill/session evidence. They are intentionally skipped without both
the gate and credentials.

### 20.4 Signed sandbox bill

Set secret variables without printing them:

```powershell
$env:RUN_REMOTE_SANDBOX_TESTS = 'true'
$env:RESTEC_ENV = 'sandbox'
$env:RESTEC_PUBLIC_BASE_URL = 'https://sandbox-api.restec.io'
$env:RESTEC_SANDBOX_LOCATION_ID = 'loc_sandbox_demo'
$env:RESTEC_SANDBOX_EXTERNAL_TABLE_ID = 'EXT-01'
$env:RESTEC_SANDBOX_EXTERNAL_BILL_ID = 'INV-DEMO-1001'
npm run create:demo-bill
```

The API key and request-signing secret must already be in
`RESTEC_SANDBOX_TEST_API_KEY` and `RESTEC_SANDBOX_REQUEST_SIGNING_SECRET`.

### 20.5 Sandbox scenario and dispatch

The repository provides a bill-create/dispatch script but no generic scenario command. Use an
exact-byte PowerShell HMAC request:

```powershell
$base = $env:RESTEC_PUBLIC_BASE_URL
$path = '/v1/test/scenarios'
$bodyObject = @{
  location_id = $env:RESTEC_SANDBOX_LOCATION_ID
  external_bill_id = $env:RESTEC_SANDBOX_EXTERNAL_BILL_ID
  scenario = 'payment.completed'
}
$body = $bodyObject | ConvertTo-Json -Compress
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$requestId = 'req_' + [Guid]::NewGuid().ToString('N')
$idempotencyKey = 'scenario:' + $env:RESTEC_SANDBOX_EXTERNAL_BILL_ID + ':completed:1'
$signingInput = "$timestamp.POST.$path.$body"
$hmac = [System.Security.Cryptography.HMACSHA256]::new(
  [Text.Encoding]::UTF8.GetBytes($env:RESTEC_SANDBOX_REQUEST_SIGNING_SECRET)
)
try {
  $digest = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($signingInput))
  $signature = 'v1=' + ([Convert]::ToHexString($digest).ToLowerInvariant())
} finally {
  $hmac.Dispose()
}
$headers = @{
  Authorization = "Bearer $($env:RESTEC_SANDBOX_TEST_API_KEY)"
  'Content-Type' = 'application/json'
  'X-Restec-Timestamp' = "$timestamp"
  'X-Restec-Signature' = $signature
  'X-Request-Id' = $requestId
  'Idempotency-Key' = $idempotencyKey
}
Invoke-RestMethod -Method Post -Uri "$base$path" -Headers $headers -Body $body

npm run dispatch:pos-events
```

For retry testing, use `webhook_429`, `webhook_500`, or `webhook_timeout` with a new logical
idempotency key. For dedupe use `duplicate_event`. Use a fresh bill for financial scenarios that
would otherwise conflict with an already-paid state.

### 20.6 Real hosted-payment certification

After Paely confirms deployed private routes and an approved checkout hostname:

```powershell
$env:RESTEC_ENV = 'sandbox'
$env:RUN_REAL_PAYMENT_SESSION_CERTIFICATION = 'true'
npm run certify:real-payment-session
```

Open the printed Restec URL and manually enter only the provider's sandbox test card on the hosted
page. Do not automate or enter card data into Restec tooling.

Later evidence-only verification:

```powershell
$env:RESTEC_CERTIFICATION_PAYMENT_SESSION_ID = '<rps_test_id>'
$env:RESTEC_CERTIFICATION_INITIAL_STATUS = 'requires_customer_action'
npm run certify:real-payment-session -- --verify
```

### 20.7 SQL verification queries

Run through the Supabase SQL editor or an approved `psql` connection. Replace placeholders; never
paste secrets into query text or results.

Migration presence:

```sql
select version
from supabase_migrations.schema_migrations
order by version;
```

Expected application migrations end at `20260723000100`.

RLS:

```sql
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'partners','partner_users','restaurants','locations','api_keys',
    'pos_connections','pos_tables','table_mappings','bill_mappings',
    'external_payments','webhook_endpoints','idempotency_records',
    'replay_records','private_event_inbox','pos_outbox_events',
    'webhook_delivery_attempts','audit_logs','sandbox_scenarios',
    'payment_sessions','mock_pos_receipts'
  )
order by c.relname;
```

RPCs:

```sql
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'accept_private_event','claim_pos_outbox','persist_restec_bill_state',
    'persist_restec_external_payment','complete_pos_outbox_delivery',
    'fail_pos_outbox_delivery','release_expired_pos_outbox_leases',
    'replay_pos_outbox_event','store_sandbox_credentials',
    'transition_payment_session','accept_payment_session_event'
  )
order by p.proname;
```

Sandbox seed without exposing encrypted values:

```sql
select p.id as partner_id, r.id as restaurant_id, l.id as location_id,
       pc.id as connection_id, pc.connector_type, pc.status,
       (pc.encrypted_configuration <> 'local_setup_required') as configured
from partners p
join restaurants r on r.partner_id = p.id
join locations l on l.restaurant_id = r.id
join pos_connections pc on pc.location_id = l.id
where p.id = 'ptr_sandbox_demo'
order by pc.id;
```

Bill projection:

```sql
select connection_id, external_bill_id, public_restec_bill_id,
       current_version, payment_status, reconciliation_status,
       public_state->>'amount_due' as amount_due,
       updated_at
from bill_mappings
where connection_id = 'con_sandbox_canonical'
  and external_bill_id = '<external-bill-id>';
```

Payment session without ciphertext/private values:

```sql
select public_payment_session_id, environment, partner_id, connection_id,
       location_id, external_bill_id, method, amount_minor, currency,
       status, provider_checkout_host,
       (private_payment_session_reference is not null) as private_attached,
       (encrypted_provider_checkout_url is not null) as checkout_encrypted,
       expires_at, paid_at, failed_at, cancelled_at, created_at, updated_at
from payment_sessions
where public_payment_session_id = '<rps-id>';
```

Inbox/outbox/delivery chain:

```sql
select i.private_event_id, i.event_type, i.status as inbox_status,
       o.public_event_id, o.status as outbox_status, o.attempt_count,
       o.next_attempt_at, o.delivered_at, o.last_error_code
from private_event_inbox i
left join pos_outbox_events o
  on o.connection_id = i.connection_id
 and o.deduplication_key = i.private_event_id
where i.connection_id = 'con_sandbox_canonical'
order by i.received_at desc
limit 20;
```

```sql
select o.public_event_id, a.attempt_number, a.response_status,
       a.outcome, a.error_code, a.duration_ms, a.created_at
from pos_outbox_events o
join webhook_delivery_attempts a on a.outbox_event_id = o.id
where o.public_event_id = '<evt-id>'
order by a.attempt_number;
```

Dummy receipt:

```sql
select event_id, connection_id, event_type, received_at
from mock_pos_receipts
where event_id = '<evt-id>';
```

Stuck/recovery queues:

```sql
select public_payment_session_id, connection_id, external_bill_id,
       status, expires_at, updated_at
from payment_sessions
where status in ('creating','requires_customer_action','processing')
order by updated_at;
```

```sql
select public_event_id, connection_id, status, attempt_count,
       next_attempt_at, lock_expires_at, last_error_code
from pos_outbox_events
where status in ('pending','processing','dead_letter')
order by created_at;
```

Expired retention rows, which require a separately approved cleanup procedure:

```sql
select
  (select count(*) from replay_records where expires_at < now()) as expired_replays,
  (select count(*) from idempotency_records where expires_at < now()) as expired_idempotency;
```

Do not delete financial, inbox, outbox, delivery, session, receipt, or audit evidence as an ad hoc
test cleanup.

## 21. Failure handling, recovery, and reconciliation

### 21.1 Forward dependency failure

Paely transient failures are attempted up to three times with the same private idempotency key.
Public idempotency is marked failed on final failure so the POS can retry with the same public key
and a new request ID. Public responses contain only a generic dependency error and a retryable
boolean.

Because there is no distributed transaction, Paely must honor deterministic idempotency after an
ambiguous timeout. This is a required Paely contract property, not something Restec can enforce.

### 21.2 Database persistence failure after Paely commit

Bill/external-payment private commit followed by local persistence failure is recovered by the
same public/private idempotency keys. For bills, the private response must be reproducible.
Payment sessions additionally pre-reserve the stable public ID and can reattach.

### 21.3 Paely event duplicate or conflict

- Same private event ID and same exact body hash: 200, no second outbox action.
- Same ID and different body hash: repository `replay_detected`.
- Unknown connection/location: reject before inbox acceptance.
- Unknown payment session: retain inbox row as `review_required`, audit, no POS event.

### 21.4 POS outage

Paely acknowledgement is independent of POS availability. The outbox retains the event and retries
with the same public event ID. Worker crashes are recovered by lease expiry. Permanent/exhausted
delivery becomes dead-letter. Operators can requeue a public event through the protected
reconcile route:

```json
{
  "partner_id": "ptr_example",
  "location_id": "loc_example",
  "external_bill_id": "INV-1",
  "action": "requeue_pos_event",
  "event_id": "evt_example"
}
```

### 21.5 Bill reconciliation

`ReconciliationService.compare` loads local bill state, calls Paely GET, and compares version,
grand total, currency, paid, refunded, due, and payment status. Results:

- `matched`: no differences.
- `mismatch`: field differences.
- `pending`: private GET failed.
- `review_required`: local bill absent.

It reports and audits; it does not rewrite financial truth. `refresh_private_bill` currently
performs the same comparison as `compare` and only changes the audit action name. `mark_manual_review`
only writes an audit log; it does not update a bill status column.

### 21.6 Payment-session reconciliation

The session job examines `creating`, `requires_customer_action`, and `processing`:

- Local expiry -> transition to `expired`.
- No private reference -> audit `creating_unattached` as review required.
- Private amount/currency/public reference mismatch -> audit review required.
- Different private status -> transition local session.
- Private error -> audit pending.

Material limitation: if private GET reports `paid`, this job updates only `payment_sessions`. It
does not update the bill, create an inbox/outbox event, or notify the POS. The signed Paely event
remains the only complete payment-to-POS transaction. Therefore this job is not a full recovery
substitute for a missing Paely event.

### 21.7 Cleanup and operational gaps

The repository contains no scheduler/configuration for:

- replay-record expiry deletion;
- idempotency-record expiry deletion;
- alerting on dead letters, unmatched inbox events, or stuck sessions;
- audit/financial retention;
- automatic reconciliation cadence.

These must be designed, approved, and operated externally before production.

## 22. Security and PCI boundary

### 22.1 Security boundaries

- POS trust ends at Restec public bearer/HMAC/location authorization.
- Paely trust uses a separate private bearer/service/environment/HMAC credential set.
- Browser checkout is an opaque Restec capability and never receives private APIs or database
  credentials.
- Supabase service role exists only in the API/operator environment.
- POS webhook secrets are per connection configuration.
- Internal jobs use a separate bearer/cron secret.
- Sandbox and production use separate projects and credentials.

### 22.2 Cardholder data restrictions

Restec must never receive, store, proxy, autofill, log, or persist PAN, card number, CVV/CVC,
expiry, PIN, OTP, track data, provider merchant secrets, or raw wallet credentials.

Controls:

- Hosted-session request is strict and recursively checks suspicious key names.
- External-payment schema is strict and carries only a completed POS fact.
- `payment_sessions` has no card/contact columns; contact is forwarded but not stored.
- Card entry occurs only on the provider-hosted page behind the encrypted redirect.
- Browser returns are not payment proof.
- Public error handling does not echo request values.

This architecture reduces Restec's exposure but is not itself a formal PCI scope determination.
Obtain a qualified compliance review before production.

### 22.3 Public leakage protections

- Explicit response construction and private-client sanitization.
- Deterministic Restec IDs instead of private references.
- Generic dependency and database errors.
- No POS response body storage.
- Encrypted secrets and provider URL at rest.
- Health endpoint exposes only status/environment/version.
- Public artifact scanner and mock test assertions for forbidden fields.

Limitations:

- The leakage script scans an explicit list, not every future public file.
- Application `console.info` emits only `sanitizedConfig`, but there is no centralized structured
  logging/redaction subsystem.
- Bill/private GET responses lack a strict runtime success schema.

### 22.4 Webhook and redirect network controls

Checkout validation is exact-host HTTPS with port/IP/private-DNS rejection. POS webhook validation
is less strict: it protects key private/link-local/metadata cases and production HTTPS, but permits
public IP literals and ports and does not block every special-purpose range. This should be
hardened or formally accepted before production webhook enrollment.

## 23. Production-readiness and rollback

### 23.1 Readiness checklist

Do not enable production until all items are evidenced:

- [ ] All six migrations rehearsed on a current-schema clone and applied to sandbox.
- [ ] Remote Supabase integration tests pass, including atomic session event and active-session
      concurrency.
- [ ] Real Paely private bill/external-payment operations certified.
- [ ] Paely private payment-session create and GET deployed and strict-contract tested.
- [ ] Approved provider checkout hostname observed and security-reviewed.
- [ ] Real provider sandbox webhook verifies and commits in Paely.
- [ ] Signed Paely event produces paid Restec session/bill, one outbox row, and signed dummy POS
      receipt.
- [ ] Duplicate, timeout, 429, 5xx, permanent failure, lease recovery, dead-letter, and replay
      exercised on deployed infrastructure.
- [ ] Session event cross-checks for private session reference, amount, currency, and nested status
      are implemented or risk-accepted.
- [ ] Missing-event/session reconciliation has a bill/outbox recovery design.
- [ ] Replay/idempotency retention cleanup is implemented and monitored.
- [ ] Shared production rate limiter selected, load-tested, and enabled.
- [ ] Webhook URL validation gaps resolved or accepted.
- [ ] Real POS vendor connector/version and webhook behavior certified.
- [ ] Portal remains disabled or receives approved identity, role, CSRF/session, step-up, audit,
      and rate-limit implementation.
- [ ] Metrics, alerts, dashboards, on-call, runbooks, and escalation contacts approved.
- [ ] Secrets stored separately by environment; rotation and restoration rehearsed.
- [ ] Production Supabase has no sandbox seed.
- [ ] `RESTEC_PAYMENT_SESSIONS_ENABLED=false` until final approval.
- [ ] Controlled restaurant smoke test and rollback decision points approved.
- [ ] CI Node version aligned to Node 24 and local `npm run verify` passes on reviewed commit.

### 23.2 Application rollback

1. Stop new payment-session traffic by setting
   `RESTEC_PAYMENT_SESSIONS_ENABLED=false`.
2. Redeploy the last reviewed compatible application build.
3. Stop only payment-session reconciliation while disabled; keep the POS outbox dispatcher
   running unless delivery itself is unsafe.
4. Verify `/health`, existing bill GET, and outbox delivery.
5. Confirm payment-session create/status/browser routes return 404 after valid public auth where
   applicable.
6. Use `git revert <commit-sha>` for source rollback; never use destructive history or filesystem
   resets.
7. Preserve sessions, inboxes, outboxes, attempts, receipts, bills, and audit evidence.

### 23.3 Database rollback

Migrations are additive, but a destructive automatic rollback is not safe:

- Do not drop financial/evidence tables.
- Do not remove enum values in place.
- Do not rewrite accepted inbox/outbox/session history.
- Revoke newly unused RPC grants only after all in-flight work is reconciled and retention owners
  approve.
- If an application rollback requires an earlier function definition, apply it as a new reviewed
  forward migration rather than editing migration history.
- Restore `RESTEC_SECRET_ENCRYPTION_KEY` from the secret manager if a deployment used the wrong
  key; rotating it requires an explicit re-encryption migration.

The rollback comments in each migration are authoritative preservation notes.

## 24. Remaining Paely work

The Restec repository requires Paely to implement and certify:

1. Private create:
   `POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions`.
2. Private status:
   `GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}`.
3. Existing private bearer/service/environment/timestamp/exact-body HMAC/request-ID verification.
4. Durable idempotency: same key/input returns one session; different input conflicts; timeout
   after commit never creates a second charge.
5. Location/connection/bill/environment/amount/currency validation.
6. Real provider sandbox hosted-checkout creation without accepting card data.
7. Provider webhook signature verification and durable canonical payment/order update.
8. Durable Paely outbox for completed, failed, expired, refunded, and partially refunded events.
9. Event inclusion of private session ID, Restec public reference, authoritative status, and
   complete bill/payment projection.
10. Stable event IDs and exact semantic dedupe across retries.
11. Private status response that strictly matches Restec's expected casing and fields.
12. Exact approved sandbox checkout hostname supplied without URL tokens or secrets.

The full requested private contract is in
`docs/PAELY_PAYMENT_SESSION_PRIVATE_CONTRACT.md`; the ready implementation brief is
`docs/PAELY_PAYMENT_SESSION_IMPLEMENTATION_PROMPT.md`.

Paely must not:

- send card data to Restec;
- use a public Restec endpoint as a private shortcut;
- trust browser return/cancel as payment proof;
- expose provider credentials, settlement, merchant, bank, or commission data;
- emit `payment.completed` before provider verification and durable canonical commit.

## 25. Contradictions and material implementation gaps

The following are verified discrepancies between code and existing documentation or between
repository layers:

1. **Missing private reference bundle.**
   `docs/PAELY_PRIVATE_COMPATIBILITY.md` cites
   `reference/paely/paely-restec-private-api.yaml`, but the repository contains only
   `reference/paely/README.md`. Private compatibility cannot be reverified from the claimed YAML.
2. **Private operation count is stale.**
   `docs/FINAL_INTEGRATION_AUDIT.md` says the private client has four contract methods. Current
   `PaelyClient` exposes six logical operations, including payment-session create/GET.
3. **Internal flow route matrix is stale.**
   `docs/internal/RESTEC_PAELY_COMPLETE_FLOW.md` omits payment-session public/browser routes,
   session reconciliation, dummy receiver, and evidence routes.
4. **OpenAPI idempotency length differs from code.**
   The public OpenAPI says 8–255 characters. Code accepts any non-empty key generally and at most
   200 only for session creation.
5. **OpenAPI external bill length is not enforced on path parameters.**
   The document limits it to 128, but `createApp` does not validate the bill path parameter before
   using/forwarding it.
6. **Rate-limit documentation overstates keying.**
   `docs/RATE_LIMITS.md` describes credential/location/endpoint-class policies. Code limits
   authenticated traffic by partner + URL path and failed auth by source-IP hash. No location key
   or special route budgets are implemented.
7. **Replay/idempotency expiry is not operational.**
   Tables have expiry columns, but no cleanup job exists. Unique constraints continue to block
   reuse after nominal expiry.
8. **`RESTEC_WEBHOOK_MASTER_KEY` is required in production but unused.**
   It is validated by `loadConfig` and never referenced by delivery, repository, or connector
   code.
9. **`RESTEC_DATABASE_URL` and public-site variables are unused.**
   They appear in environment examples/deployment docs, but runtime uses Supabase URL/service role;
   `PORTAL_AUTH_REDIRECT_URL` and `DOCS_PUBLIC_BASE_URL` are not read.
10. **Webhook endpoint table is not authoritative.**
    Existing schema docs present `webhook_endpoints` as connector state, but dispatch reads
    `pos_connections.encrypted_configuration`. The two can drift.
11. **Webhook destination protections are narrower than security prose.**
    Checkout validation is strict; POS webhook validation permits public IP literals/ports and
    omits some reserved ranges.
12. **Payment-session reconciliation is not end-to-end recovery.**
    It may mark a session paid from Paely GET without updating the bill or generating a POS event.
13. **Session event association is incomplete.**
    The receiver parses private session ID and nested status but the atomic RPC binds only public
    session reference + connection and derives status from event type. Amount/currency/private-ID
    consistency is not checked.
14. **Memory and Supabase semantics differ.**
    Memory storage is non-transactional, removes delivered/dead-letter rows rather than retaining
    statuses, and does not enforce one active session per bill. Passing local tests do not prove
    PostgreSQL concurrency/durability.
15. **CI Node version conflicts with deployment engines.**
    `.github/workflows/phase2.yml` uses Node 22, while root/API engines and Vercel guidance require
    Node 24.x.
16. **Portal and rotation wording exceeds implementation.**
    Docs describe credential/webhook rotation behavior, but the current portal buttons are
    disabled and `DisabledPortalAdminService` rejects every operation.
17. **`google_pay` is only partially modeled.**
    Shared types/database allow it, but the public request schema accepts only `card`; no real
    Google Pay flow exists.
18. **Dummy receiver does not verify delivery attempt.**
    Outbound connector sends `X-Restec-Delivery-Attempt`, but the sandbox receiver ignores it.
19. **Bill success responses are not strictly parsed.**
    Payment-session create has a strict private response schema. Bill and private session GET
    responses rely on selection/minimal checks, so malformed upstream successes can escape the
    intended contract until persistence/transition fails.
20. **Production-readiness docs are partly stale.**
    `docs/PRODUCTION_READINESS_CHECKLIST.md` refers to “Phase 2 migration” and predates several
    session-specific risks. Its bottom-line conclusion—Restec is not production-ready—remains
    consistent with code and evidence.
21. **The remote sandbox E2E file is only a health check.**
    `apps/api/src/sandbox.e2e.test.ts` performs one unauthenticated `/health` request. The script
    name and `test:remote-sandbox` label should not be treated as evidence that signed public
    routes, Paely, outbox dispatch, or payment sessions passed remotely.
22. **The Paely certification script validates prerequisites, not Paely operations.**
    `scripts/certify-paely-sandbox.ts` checks flags and the presence of four environment variables,
    then prints instructions. It makes no network request. This conflicts with
    `docs/PAELY_SANDBOX_CERTIFICATION.md`, which describes certification of private operations,
    callbacks, duplicates, and POS-unavailable behavior.

## 26. Successful payment lifecycle sequence

```mermaid
sequenceDiagram
    autonumber
    participant POS
    participant R as Restec API
    participant DB as Restec Supabase
    participant P as Paely private API
    participant PSP as Safepay/PayFast provider
    participant W as Restec dispatcher

    POS->>R: PUT /v1/.../bills/{externalBillId}<br/>Bearer + exact-body HMAC + request ID + idempotency
    R->>DB: Reserve replay and public idempotency
    R->>DB: Authorize partner/location; validate table/version
    R->>P: Signed private bill PUT<br/>stable private idempotency key
    P-->>R: Private committed bill state
    R->>DB: Persist private mapping + sanitized Restec projection
    R-->>POS: Restec bill ID and canonical unpaid state

    POS->>R: POST /v1/.../payment-sessions<br/>amount=due, PKR, card
    R->>DB: Reserve deterministic rps_* row as creating
    R->>P: Signed private session create<br/>Restec return/cancel URLs + rps reference
    P->>PSP: Create provider hosted checkout
    PSP-->>P: Opaque HTTPS provider URL
    P-->>R: Private session ID + URL + amount/currency/expiry
    R->>R: Exact-host HTTPS + DNS validation
    R->>DB: AES-256-GCM URL + exact host; status requires_customer_action
    R-->>POS: Restec rps_* ID + Restec-origin /s/... URL

    POS->>R: Customer browser opens /s/{rps}
    R->>DB: Validate session scope/state/expiry
    R->>R: Decrypt and revalidate provider URL
    R-->>PSP: 303 redirect; provider URL only in browser Location header
    PSP->>PSP: Customer enters card data on provider-hosted page
    PSP->>P: Signed provider payment webhook
    P->>P: Verify provider; durably commit canonical payment/bill
    P->>R: Signed payment.completed event<br/>stable private event ID + rps reference
    R->>R: Verify raw HMAC/timestamp/attempt/schema/connection/location
    R->>DB: Atomic inbox dedupe + session paid + bill paid + POS outbox
    DB-->>R: Commit
    R-->>P: 202 accepted (200 for exact duplicate)

    W->>DB: Claim pending outbox with lease
    W->>W: Resolve connector; validate destination; sign exact public event
    W->>POS: POST payment.completed<br/>evt_* + timestamp + HMAC + attempt
    POS->>POS: Verify, uniquely dedupe evt_*, update invoice durably
    POS-->>W: 2xx
    W->>DB: Atomic delivery attempt + delivered status
    POS->>R: Optional signed GET bill/session
    R-->>POS: Canonical paid state; amount_due=0
```

The provider portion is required architecture but is not implemented or certified in this
repository. A browser redirect or return page never substitutes for the signed Paely event and
durable Restec transaction.
