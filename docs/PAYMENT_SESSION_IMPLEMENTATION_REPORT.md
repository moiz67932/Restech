# Restec Payment Session Implementation Report

## Executive summary and current gap

Restec now has a feature-flagged, Restec-branded hosted-payment session contract, encrypted redirect controller, additive persistence, authoritative state machine, private client contract, event-to-bill-to-POS transaction path, signed sandbox dummy POS receiver, reconciliation batch, public artifacts, and real certification runner.

The original gap was the complete absence of a payment-session projection and the deployed private create/status contract. The Restec side is implemented and mock-certified. Real sandbox certification is still blocked: this repository cannot prove that the deployed Paely sandbox private endpoints exist or that a real Safepay webhook will produce the required signed event. No deployment, production call, production database access, secret change, or card automation was performed.

## Public routes

- `POST /v1/locations/{locationId}/bills/{externalBillId}/payment-sessions`
- `GET /v1/locations/{locationId}/payment-sessions/{paymentSessionId}`
- `GET /s/{paymentSessionId}`
- `GET /s/{paymentSessionId}/return`
- `GET /s/{paymentSessionId}/cancel`

The API routes use existing bearer authentication, exact raw-body HMAC, timestamps, replay protection, rate limiting, location authorization, environment isolation, and idempotency. All five routes return 404 while `RESTEC_PAYMENT_SESSIONS_ENABLED=false`. The initial create response is always `requires_customer_action`.

## Private contract and consistency

`PaelyClient.createPaymentSession` calls:

`POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions`

`PaelyClient.getPaymentSession` calls:

`GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}`

Both reuse existing bearer/service/environment/timestamp/signature/request-ID/timeout/retry rules. The exact schemas and event extension are in `PAELY_PAYMENT_SESSION_PRIVATE_CONTRACT.md`.

Restec derives one opaque `rps_test_...`/`rps_live_...` identity from environment, partner, location, bill, and idempotency key; pre-creates it; calls the private service with one deterministic private idempotency key; then attaches the encrypted URL. A failed attachment or ambiguous private timeout is retried with the same identities. The database permits only one active session per connection/bill.

## Database and repositories

Migration `20260723000100_payment_sessions.sql` adds:

- `payment_sessions`, with scope FKs, checks, uniqueness, expiry/private-reference indexes, and RLS;
- `mock_pos_receipts`, with unique event IDs and RLS;
- central `transition_payment_session`;
- atomic `accept_payment_session_event`.

It is additive and has no destructive backfill. Customer email/mobile is forwarded for session creation but not stored. Provider checkout URLs are AES-256-GCM ciphertext using the existing Restec encryption key; only the exact host is stored separately. Memory and Supabase implementations expose the same create/attach/get/transition/event/evidence/reconciliation contract.

## State machine

The central TypeScript transition function and matching SQL transition RPC enforce:

- `creating` to customer action, processing, paid, failed, or expired;
- customer action/processing to paid, failed, expired, or cancelled;
- failed/expired/cancelled to paid, so a late authoritative payment wins;
- paid to partial/full refund;
- partial refund to partial/full refund;
- duplicate states as no-ops;
- paid never back to an unpaid/failed/cancelled state.

Browser return never changes payment state. Browser cancel changes only a customer-action session. A later genuine paid event overrides cancellation.

## Public examples

Create request:

```json
{
  "amount_minor": 10000,
  "currency": "PKR",
  "method": "card",
  "customer": {
    "email": "sandbox@example.com",
    "mobile": "03000000000"
  }
}
```

Create response:

```json
{
  "payment_session_id": "rps_test_example",
  "location_id": "loc_sandbox_demo",
  "external_bill_id": "SBX-BILL-1",
  "status": "requires_customer_action",
  "checkout_url": "https://restech-api-qkrx.vercel.app/s/rps_test_example",
  "amount_minor": 10000,
  "currency": "PKR",
  "method": "card",
  "expires_at": "2026-07-23T12:30:00Z",
  "created_at": "2026-07-23T12:15:00Z"
}
```

The POS webhook retains the existing versioned Restec event envelope and adds only a public `payment_session_id`:

```json
{
  "id": "evt_testexample",
  "type": "payment.completed",
  "schema_version": "2026-07-01",
  "created_at": "2026-07-23T12:22:00Z",
  "data": {
    "location_id": "loc_sandbox_demo",
    "external_bill_id": "SBX-BILL-1",
    "external_table_id": "EXT-01",
    "payment_session_id": "rps_test_example",
    "payment": {
      "restec_payment_id": "pay_testexample",
      "amount": 10000,
      "currency": "PKR",
      "method": "card",
      "status": "completed"
    },
    "bill": {
      "grand_total": 10000,
      "amount_paid": 10000,
      "amount_refunded": 0,
      "amount_due": 0,
      "payment_status": "paid",
      "version": 1
    }
  }
}
```

## Security and PCI boundary

The create route rejects suspicious cardholder/authentication keys recursively and never echoes values. Restec never accepts, stores, proxies, autofills, or logs PAN, CVV, expiry, track, PIN, or OTP data. It never calls Safepay directly. The browser route decrypts only after session/scope/state/expiry checks, requires HTTPS, forbids credentials/ports/IP literals/local/reserved names, enforces an exact host allowlist, rechecks the stored host, uses a 303, and sets no-store/no-referrer headers. It never logs the decrypted URL.

Private IDs, private URLs, raw dependency errors, service routes, database details, settlement data, and provider credentials are absent from public responses/events/docs. The public leakage scan covers OpenAPI, docs app, portal, Postman, samples, and certification docs.

## Dummy POS and certification

`POST /api/test/mock-pos-webhook` exists only in sandbox. It reads exact raw bytes, resolves the connection-specific encrypted secret through the repository path, verifies environment/timestamp/signature/event ID, deduplicates durably, stores only sanitized evidence, and returns 204. Invalid/stale signatures return 401. Protected inspection/evidence routes use the existing internal job token and are hidden outside sandbox.

`scripts/configure-sandbox-mock-pos.ts` changes only the encrypted canonical sandbox connector destination and verifies repository read-back without printing a secret.

`scripts/certify-real-payment-session.ts` checks sandbox health, creates a fresh deployed bill/session, prints only the Restec checkout URL, waits for manual hosted-card entry, polls signed Restec status, invokes the protected dispatcher, inspects inbox/outbox/bill/receipt evidence, and prints a sanitized pass/fail report. `--verify` supports a later non-interactive evidence run.

## Files changed

- Core: `apps/api/src/app.ts`, `payment-sessions.ts`, `config.ts`, `memory-repository.ts`, `reconciliation.ts`, and tests.
- Contracts/client/persistence: `packages/contracts/src`, `packages/paely-client/src`, `packages/database/src`, `packages/connectors/canonical-rest/src/index.ts`.
- Migration/config/scripts: `supabase/migrations/20260723000100_payment_sessions.sql`, `.env.example`, `package.json`, `scripts/certify-real-payment-session.ts`, `scripts/configure-sandbox-mock-pos.ts`.
- Public artifacts: public/internal OpenAPI, Postman, docs app, POS guide/checklist, database/Vercel docs, and eight language samples.
- Internal deliverables: current-state audit, private contract, environment matrix, operations/rollback, implementation report, and ready-to-paste Paely prompt.

## Verification results

Passed locally:

- `npm ci` (install succeeded; npm reported two moderate and two high dependency advisories; no automatic dependency mutation was performed);
- `npm run lint`;
- `npm run typecheck`;
- `npm test`: 40 tests, 37 passed, 3 environment-gated skips;
- focused payment-session tests: create/status/idempotency/concurrency/card-field rejection/redirect validation/production isolation/event ordering/dedup/dummy signature;
- `npm run test:e2e:mock`;
- `npm run build`;
- `npm run verify`;
- `npm run verify:openapi`;
- `npm run verify:public-leakage`;
- `npm run verify:vercel-runtime`;
- static migration checks.

The disposable database integration tests are implemented but were skipped because the local Docker/Supabase engine was unavailable. `npx supabase status` failed because the Docker Desktop Linux engine pipe did not exist. No remote database was substituted.

`npx vercel build` was not run because the linked workspace contains `.vercel/.env.production.local`; avoiding accidental use of production configuration takes precedence. The repository build and Vercel runtime verifier passed. Nothing was deployed.

## Manual deployment, certification, and rollback

Exact steps and commands are in `PAYMENT_SESSION_OPERATIONS.md`. Production remains disabled. Apply the additive migration to sandbox first, configure only approved sandbox variables/host, deploy the tested commit manually, verify sandbox health, configure the encrypted dummy destination, and run real certification. Roll back by disabling the flag and redeploying; preserve all session/inbox/outbox/receipt/audit evidence and never destructively drop the financial table.

## Remaining dependency

Real certification status: **blocked, not failed and not passed**. It requires the deployed Paely sandbox private create/status endpoints, a real Safepay hosted session, a manually completed sandbox card flow, a verified provider webhook into Paely, and the signed Paely event back into Restec. Use `PAELY_PAYMENT_SESSION_IMPLEMENTATION_PROMPT.md` to implement only that missing private side.
