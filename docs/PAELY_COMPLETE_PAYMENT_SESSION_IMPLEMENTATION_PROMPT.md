# Ready-to-Paste Prompt for Paely Codex: Complete Restec Payment-Session Implementation

Copy everything below this line into a fresh Codex session opened at the root of the current Paely
repository. This is an implementation task in Paely, not a Restec task.

---

You are working in the current Paely repository. Inspect the entire repository before changing
anything. Do not rely on any previous Codex conversation, memory, or an assumed Paely architecture.
The live Paely code, migrations, tests, scripts, environment schemas, and current documentation are
the authority for Paely internals. The Restec wire contract quoted in this prompt is locked and is
the authority at the integration boundary.

## 1. Mission

Audit and implement the complete missing Paely side of this real, provider-hosted payment flow:

```text
POS
  -> Restec public bill API
  -> Restec private bill API call to Paely
  -> Paely canonical integration bill/order

POS
  -> Restec public payment-session API
  -> Restec private payment-session POST to Paely
  -> Paely creates a real Safepay hosted checkout
  -> Paely privately returns the provider checkout URL to Restec
  -> Restec returns a Restec-branded checkout URL to the POS
  -> Restec redirects the customer's browser to Safepay
  -> the customer enters a Safepay sandbox card only on Safepay's hosted page

Safepay webhook
  -> Paely verifies the provider webhook
  -> Paely atomically commits canonical payment/order/bill state
  -> Paely atomically creates a durable signed Restec outbox event
  -> Paely dispatches the event to Restec
  -> Restec updates its payment session and bill projection
  -> Restec creates and dispatches a signed POS webhook
  -> the POS marks the invoice paid
```

Paely must remain completely hidden from POS vendors. Restec must never call Safepay directly.
Restec and its POS-facing routes must never receive PAN, CVV/CVC, card expiry, PIN, OTP, track data,
cryptograms, or any other sensitive authentication/cardholder data. The browser success, cancel,
and return routes are user-experience routes only and are never payment authority.

Implement this by extending Paely's existing financial core and Safepay integration. Do not create
a second payment ledger, a parallel order state machine, or an alternate webhook implementation.

## 2. Non-negotiable operating limits

- Work only in the Paely repository.
- Do not modify Restec.
- Do not call Restec public POS APIs from Paely.
- Do not deploy automatically.
- Do not access, query, copy, or mutate production data.
- Do not change production environment variables.
- Do not rotate credentials, HMAC secrets, provider credentials, or encryption keys.
- Do not change Paely's existing production encryption key.
- Do not copy sandbox Safepay credentials into production.
- Do not print or commit secret values.
- Do not print provider checkout URLs containing tokens.
- Do not accept or persist card data.
- Do not mark a payment paid during checkout creation.
- Do not mark a payment paid because the browser returned to a success URL.
- Do not weaken existing Safepay webhook verification.
- Do not replace existing Paely payment/order/refund/reconciliation logic.
- Make all schema and application changes additive, forward-only, and disabled by default.
- Keep production payment sessions disabled.
- Do not claim end-to-end certification until one real Safepay sandbox webhook has caused the
  complete Paely -> Restec -> dummy POS delivery to pass.

If a requested Paely table, function, route, or concept below has a different real name in the
repository, use the established implementation rather than inventing a duplicate. Record the name
mapping in the final report. If the repository does not contain the claimed capability, say so and
implement the minimum additive version only when it is within this task.

## 3. Required repository audit before edits

First inspect, with repository-wide searches, at least:

- every route definition under the API/application directories;
- all payment, order, integration-bill, venue, table, connection, and restaurant models;
- every Safepay and PayFast service, route, webhook, test, and script;
- provider account selection and `merchant_payment_accounts` or its real equivalent;
- payment-credential encryption and decryption;
- all webhook raw-body middleware and signature verification;
- payment and order reconciliation;
- partial payment, split payment, refund, partial-refund, cancellation, and expiry behavior;
- existing Restec bill create/get and external-payment routes;
- integration authentication, replay, request-ID, and idempotency storage;
- durable inbox/outbox tables, claim functions, workers, cron routes, retries, dead letters, and
  manual replay;
- all migrations and generated database types;
- all environment schemas and feature flags;
- package manager, scripts, lint/typecheck/test/build commands, Vercel configuration, Supabase
  configuration, and deployment documentation.

Before implementation, produce an internal audit table with these columns:

| Concern | Actual Paely file/function/table | Existing behavior | Reuse or additive change | Evidence |
| ------- | -------------------------------- | ----------------- | ------------------------ | -------- |

Do not stop after the audit unless a true safety blocker prevents implementation. Make reasonable,
evidence-based choices within the constraints and record every unresolved fact as unverified.

## 4. Locked Restec contract and provenance

The following contract was reconstructed from the current Restec repository. Do not rename fields,
change casing, substitute snake case for camel case, add a wrapper, or return extra fields.

The controlling Restec sources are:

- `packages/paely-client/src/index.ts`
  - `CreatePrivatePaymentSessionInput`
  - `PrivatePaymentSessionResult`
  - `PrivatePaymentSessionState`
  - `PaelyClient.createPaymentSession`
  - `PaelyClient.getPaymentSession`
  - `PaelyClient.rawRequest`
  - `derivePrivateIdempotencyKey`
- `packages/contracts/src/index.ts`
  - `paymentSessionRequestSchema`
  - `privatePaymentSessionResponseSchema`
  - `paymentSessionStatusSchema`
  - `eventSchema`
- `packages/contracts/src/payment-session-state.ts`
  - `paymentSessionTransitions`
  - `assertPaymentSessionTransition`
- `packages/security/src/index.ts`
  - `signRequest`
  - `signEvent`
  - `verifyRequestSignature`
  - `verifyEventSignature`
  - `secureEqual`
  - `verifyTimestamp`
- `apps/api/src/app.ts`
  - the public session create handler
  - `privateEvent`
  - `POST /api/internal/events/paely/v1`
- `apps/api/src/payment-sessions.ts`
  - `paymentSessionResponse`
  - `paymentStatusFromEvent`
- `apps/api/src/reconciliation.ts`
  - `ReconciliationService.reconcilePaymentSessions`
- `supabase/migrations/20260723000100_payment_sessions.sql`
  - `payment_sessions`
  - `transition_payment_session`
  - `accept_payment_session_event`
- `apps/api/src/payment-sessions.test.ts`
- `packages/paely-client/src/client.test.ts`
- `packages/contracts/src/payment-session-state.test.ts`
- `packages/database/src/supabase-repository.integration.test.ts`
- `scripts/certify-real-payment-session.ts`
- `openapi/restec-pos-partner-v1.yaml`
- `docs/openapi/restec-internal-api.yaml`
- `docs/RESTEC_COMPLETE_SYSTEM_MASTER_GUIDE.md`

Important code-over-document rules:

1. Restec's public request currently accepts only `method: "card"`. Although a shared Restec type
   and database check also mention `google_pay`, the live public request schema and OpenAPI do not
   accept it. Implement Restec payment sessions for `card` only.
2. Restec's private create response schema accepts `requires_customer_action` or `processing`, but
   the live create handler explicitly rejects `processing`. A successful create response must
   therefore contain exactly `status: "requires_customer_action"`.
3. Restec's private GET client does not send `Idempotency-Key`. Do not require that header on GET.
4. Restec's private GET client performs only minimal runtime checks today. Paely must nevertheless
   return the strict state response specified below.
5. Restec currently has incomplete event-to-session association checks. Paely must emit all stable
   identifiers and internally verify them even though Restec does not yet cross-check every one.

## 5. Direction and exact routes

Restec calls Paely on exactly these payment-session routes:

```text
POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions

GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}
```

Paely calls Restec for authoritative financial events on exactly:

```text
POST /api/internal/events/paely/v1
```

Do not have Paely call any of these Restec public routes:

```text
/v1/locations/...
/v1/test/...
/s/...
```

The private create path contains the Paely-private location reference and the POS-originated
external bill ID. The body contains the Paely-private connection reference and Restec's opaque
public payment-session reference. The private GET path contains Paely's private payment-session
identifier. These private identifiers never cross Restec's public POS response.

## 6. Exact private session-creation request

Implement:

```text
POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions
```

The exact JSON body sent by `PaelyClient.createPaymentSession` is camel case:

```json
{
  "connectionId": "PRIVATE_PAELY_CONNECTION_REFERENCE",
  "amountMinor": 10000,
  "currency": "PKR",
  "method": "card",
  "customer": {
    "email": "optional@example.com",
    "mobile": "+923001234567"
  },
  "returnUrls": {
    "success": "https://RESTEC_CHECKOUT_ORIGIN/s/rps_test_OPAQUE/return",
    "cancel": "https://RESTEC_CHECKOUT_ORIGIN/s/rps_test_OPAQUE/cancel"
  },
  "restecPaymentSessionReference": "rps_test_OPAQUE"
}
```

The schema is:

| Field                           | Requirement                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `connectionId`                  | Required string; the private Paely connection reference already mapped by Restec     |
| `amountMinor`                   | Required positive safe integer in minor units; Restec public maximum is `2147483647` |
| `currency`                      | Required literal `PKR`                                                               |
| `method`                        | Required literal `card` for the currently implemented Restec public API              |
| `customer`                      | Optional strict object                                                               |
| `customer.email`                | Optional valid email, maximum 254 characters at the Restec public boundary           |
| `customer.mobile`               | Optional telephone string already validated by Restec's current public regex         |
| `returnUrls`                    | Required strict object                                                               |
| `returnUrls.success`            | Required Restec-owned absolute HTTPS URL                                             |
| `returnUrls.cancel`             | Required Restec-owned absolute HTTPS URL                                             |
| `restecPaymentSessionReference` | Required Restec public ID matching `^rps_(test                                       | live)_[A-Za-z0-9]+$` |

Restec's public-only `return_context` is not forwarded to Paely. Do not expect it.

Use a strict request schema. Reject unknown fields. Explicitly reject keys or nested values that
look like PAN, card number, CVV/CVC, expiry, PIN, OTP, magnetic-stripe/track data, or provider
credentials. Never log rejected sensitive values.

Validate that:

- path parameters decode once and conform to Paely's actual identifier/bill rules;
- the path location and body connection exist in the same environment;
- the connection owns or is authorized for that location;
- the Restec public session prefix matches the environment (`rps_test_` in sandbox and
  `rps_live_` in production);
- the success and cancel URLs use HTTPS and an explicitly configured Restec host for the same
  environment;
- neither return URL contains credentials, an unexpected port, an IP literal, localhost, a private
  hostname, or a non-Restec host;
- `amountMinor`, `currency`, `method`, bill, connection, and location are included in the
  idempotency fingerprint.

Do not trust `connectionId`, location, bill, amount, or return URLs merely because the request is
signed. Authorization and business validation are still required.

## 7. Exact private session-creation response

On successful provider-hosted session creation, return exactly this unwrapped JSON object:

```json
{
  "privatePaymentSessionId": "OPAQUE_PAELY_PRIVATE_SESSION_ID",
  "status": "requires_customer_action",
  "providerCheckoutUrl": "https://approved-safepay-host.example/OPAQUE_PROVIDER_PATH",
  "amountMinor": 10000,
  "currency": "PKR",
  "expiresAt": "2026-07-24T12:34:56.000Z"
}
```

The hostname above is an intentionally non-routable example. Return the real provider URL generated
by Paely's existing Safepay client, not that example.

The exact response requirements are:

| Field                     | Requirement                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `privatePaymentSessionId` | Required opaque string, 1–256 characters, stable across retries                                                                                 |
| `status`                  | Required literal `requires_customer_action`                                                                                                     |
| `providerCheckoutUrl`     | Required absolute URL, maximum 4096 characters; it must be HTTPS, live for this session, and on a pre-approved Safepay hosted-checkout hostname |
| `amountMinor`             | Required positive integer exactly equal to the request                                                                                          |
| `currency`                | Required literal `PKR`                                                                                                                          |
| `expiresAt`               | Required ISO 8601 datetime strictly in the future                                                                                               |

No response envelope and no additional properties are allowed. Restec validates this through
`privatePaymentSessionResponseSchema` and then performs additional checks in the live handler in
`apps/api/src/app.ts`. `PaelyClient.rawRequest` treats any HTTP 2xx response as success; reuse
Paely's established create/replay status-code convention and document it rather than inventing a
second convention for this route.

Never include any of the following:

- provider API keys, bearer tokens, signing keys, webhook secrets, or encryption metadata;
- a merchant payment-account ID or submerchant/merchant identifier;
- raw Safepay request or response objects;
- raw webhook bodies;
- PAN, CVV/CVC, expiry, OTP, cardholder authentication data, or card fingerprints;
- bank, beneficiary, account, IBAN, payout, or settlement information;
- commission, MDR, fees, revenue share, or reconciliation internals;
- Supabase URL, project reference, table name, service-role key, row ID, or storage information;
- Paely order, venue, table, restaurant, or internal payment details not explicitly required above.

Treat the URL as a secret-bearing capability even though Restec receives it privately. Store it
only where operationally necessary, redact it from logs, and never expose it through Paely public
APIs.

## 8. Exact private status GET

Implement:

```text
GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}
```

The signed GET body is exactly empty: zero bytes, not `{}`, `null`, or a newline.

Return HTTP 200 with only the current Paely-authoritative projection:

```json
{
  "privatePaymentSessionId": "OPAQUE_PAELY_PRIVATE_SESSION_ID",
  "restecPaymentSessionReference": "rps_test_OPAQUE",
  "status": "paid",
  "amountMinor": 10000,
  "currency": "PKR",
  "expiresAt": "2026-07-24T12:34:56.000Z",
  "paidAt": "2026-07-24T12:30:00.000Z"
}
```

Requirements:

- `privatePaymentSessionId`: required, must exactly equal the decoded path value.
- `restecPaymentSessionReference`: always return it for Restec hardening and reconciliation; it
  must equal the immutable reference supplied on create.
- `status`: required exact lower-snake-case value from:
  - `creating`
  - `requires_customer_action`
  - `processing`
  - `paid`
  - `failed`
  - `expired`
  - `cancelled`
  - `refunded`
  - `partially_refunded`
- `amountMinor`: required positive integer and immutable for the session.
- `currency`: required literal `PKR`.
- `expiresAt`: required ISO 8601 datetime and immutable unless the existing provider flow has a
  documented, safely reconciled extension mechanism.
- `paidAt`: required for `paid`, `partially_refunded`, and `refunded`; omit it or return `null`
  before a provider-authoritative payment commit.

Use a strict response serializer. Do not return `providerCheckoutUrl`, provider tracker/reference,
provider payloads, provider or webhook secrets, provider credentials, cardholder/customer details,
bank details, merchant settlement data, fees, commissions, Supabase details, or unrelated Paely
records.

An unknown session, a cross-connection session, a wrong-environment session, or a disabled route
must return 404 without revealing which condition occurred.

## 9. Private error behavior

Restec does not parse a Paely error body; `PaelyClient.rawRequest` converts every non-2xx response
into a sanitized `PrivateDependencyError`. Therefore there is no Restec-mandated error-body field
name. Reuse Paely's existing internal error envelope if it is safe. Do not invent a second global
error format merely for this integration.

Use these HTTP semantics:

| Status              | Meaning                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`               | malformed JSON, missing header, malformed identifier, invalid return URL, forbidden/unknown field                                                              |
| `401`               | invalid bearer, HMAC, timestamp, request ID, service identity, or environment credential                                                                       |
| `403`               | authenticated service is not authorized for the referenced connection/location; use 404 instead if Paely's established private-resource policy hides existence |
| `404`               | feature disabled, route/resource absent, unknown session/bill, or deliberately hidden cross-environment resource                                               |
| `409`               | same idempotency key with a different fingerprint, incompatible concurrent session, bill no longer payable, or state conflict                                  |
| `422`               | validly shaped request that fails amount, currency, method, bill-version, or provider-account business validation                                              |
| `429`               | explicit capacity/rate limit; include a safe `Retry-After` if Paely already supports it                                                                        |
| `500`               | unexpected Paely failure with no leaked details                                                                                                                |
| `502`, `503`, `504` | provider dependency/availability failure, preserving idempotent recovery                                                                                       |

Use Paely's established correlation/error codes in a sanitized body. Never include raw provider
errors, checkout URLs, tokens, credentials, SQL, stack traces, private identifiers not already in
the request, or infrastructure names.

Restec automatically retries network/timeout failures and only these response statuses:

```text
408, 425, 429, 500, 502, 503, 504
```

`PaelyClient.rawRequest` makes at most three immediate attempts, each with its own timeout. Each
attempt has a fresh `X-Request-Id`, timestamp, and signature, but the same method, path, serialized
body, and private `Idempotency-Key`. Paely must make every ambiguous result safely recoverable.

## 10. Exact Restec-to-Paely authentication

Restec sends these headers on private requests:

```text
Authorization: Bearer <environment-specific shared bearer token>
X-Restec-Service-Id: <configured Restec service identity>
X-Restec-Environment: sandbox|production
X-Restec-Timestamp: <Unix epoch seconds>
X-Restec-Signature: v1=<64 lowercase hexadecimal characters>
X-Request-Id: req_<UUID without hyphens>
Idempotency-Key: <stable deterministic key>   # POST only
Content-Type: application/json
```

HTTP header names are case-insensitive, but use and document these canonical spellings.

The exact signature generated by `signRequest` in
`packages/security/src/index.ts` is:

```text
canonical_prefix =
  decimal_timestamp
  + "."
  + HTTP_METHOD_UPPERCASE
  + "."
  + exact_URL_pathname
  + "."

signature =
  "v1="
  + lowercase_hex(
      HMAC_SHA256(
        PAELY_PRIVATE_SIGNING_SECRET,
        UTF8(canonical_prefix) || exact_raw_request_body_bytes
      )
    )
```

Equivalent examples:

```text
POST canonical bytes:
<timestamp>.POST./api/internal/integrations/restec/v1/locations/<encoded-location>/bills/<encoded-bill>/payment-sessions.<exact JSON bytes>

GET canonical bytes:
<timestamp>.GET./api/internal/integrations/restec/v1/payment-sessions/<encoded-private-session>.
```

The pathname includes the leading slash and percent-encoding sent on the request. It excludes
scheme, host, query, and fragment. The GET body contributes zero bytes after the final period.

Implement verification in this order, without leaking which credential failed:

1. Apply the feature and environment gate before any side effect.
2. Enforce `Content-Type: application/json` for POST.
3. Bound `Content-Length` and actual raw bytes before JSON parsing.
4. Capture the exact raw request bytes before a body parser, middleware, normalizer, or logger can
   decode, reserialize, trim, or alter them.
5. Validate the environment-specific bearer token using constant-time comparison.
6. Validate the exact approved `X-Restec-Service-Id`.
7. Validate `X-Restec-Environment` against the deployed Paely environment.
8. Parse `X-Restec-Timestamp` as a safe integer and enforce an explicitly configured tolerance
   that matches Restec. Restec's current default is 300 seconds.
9. Recompute HMAC from the exact pathname and raw body.
10. Compare the complete `v1=` signature in constant time.
11. Validate `X-Request-Id` as `^req_[0-9a-f]{32}$` and enforce uniqueness within a durable replay
    window.
12. Require `Idempotency-Key` on POST and reject it if empty or outside the documented safe length.
13. Only then parse and validate JSON and begin business processing.

Authentication and replay requirements:

- Do not persist bearer or HMAC secrets in application tables. Load them only from the environment
  or secret manager already used by Paely. If Paely stores a non-secret credential lookup/fingerprint,
  hash it using the existing credential policy.
- Never log authorization, HMAC, raw bodies that might contain customer information, or provider
  URLs.
- A duplicate request ID must be rejected even if the request signature is valid.
- A retry with a fresh request ID but the same idempotency key/body must return the original
  session.
- Request-ID replay storage must be namespaced by service identity and environment.
- Idempotency storage must be namespaced by environment, service identity, route/operation, and
  connection as appropriate.
- Sandbox bearer/HMAC credentials must be rejected in production.
- Production bearer/HMAC credentials must be rejected in sandbox.
- Do not use `NODE_ENV` alone to determine integration environment.
- Document the replay retention period and ensure it exceeds the timestamp tolerance plus clock
  skew/processing margin.

Restec derives private idempotency keys as:

```text
restec:{partnerId}:{publicRestecIdempotencyKey}:payment_session
```

Treat the value as opaque. Do not parse the Restec partner ID out of it for authorization.

## 11. Required Paely payment behavior

For a valid private create request, use existing Paely domain services to perform all of the
following:

1. Resolve the integration bill using the path `privateLocationId` and `externalBillId`.
2. Resolve the canonical order, venue/restaurant/location, and table through existing mappings.
3. Resolve the integration connection from `connectionId`.
4. Verify the connection belongs to the same environment, restaurant/venue, location, and
   integration bill.
5. Verify the connection is active and authorized for Restec.
6. Verify the bill/order is open and payable under Paely's authoritative rules.
7. Verify the bill version/financial projection has not changed incompatibly since Restec's bill
   synchronization.
8. Verify `amountMinor` is positive and no greater than the authoritative amount due.
9. Verify currency is exactly PKR across request, bill, payment account, and provider request.
10. Verify method is exactly `card`.
11. Apply Paely's existing partial-payment, split-payment, or active-payment rules. Do not bypass
    them for Restec.
12. Resolve the venue-specific active Safepay merchant payment account using Paely's existing
    routing rules.
13. Reject a missing, disabled, wrong-environment, wrong-provider, wrong-venue, or incompletely
    configured account.
14. Decrypt provider credentials through Paely's existing payment credential encryption service.
15. Never expose decrypted values to logs, errors, responses, tests, snapshots, or outbox payloads.
16. Create or reserve exactly one canonical Paely payment using the existing payment ledger, in
    the established processing/customer-action state.
17. Create exactly one Safepay hosted checkout tracker/session using the existing Safepay adapter.
18. Supply Restec's success and cancel URLs only in the provider fields intended for browser
    navigation.
19. Use any supported provider idempotency/correlation key to make an ambiguous provider timeout
    recoverable without a second charge/session.
20. Store the minimum provider tracker/reference needed for webhook correlation, encrypted or
    otherwise protected according to existing Paely policy.
21. Persist the immutable Restec public payment-session reference and Paely private session ID.
22. Return only the strict response in section 7.

Checkout creation means only that customer action is required. It must never:

- increase `amount_paid`;
- close or complete the bill/order;
- mark the payment successful;
- create `payment.completed`;
- create a provider charge a second time on retry;
- trust a browser return/cancel request as financial evidence.

If Paely's existing Safepay integration cannot create a hosted card checkout, stop and report that
specific blocker. Do not substitute a fake URL, a Paely card form, PayFast, Google Pay, or a mock
while claiming real support.

## 12. Payment-session state machine

Use Paely's existing canonical states and map them at the private boundary to the exact Restec
states. Preserve the following Restec-compatible transitions:

| Current                    | Allowed next Restec states                                            |
| -------------------------- | --------------------------------------------------------------------- |
| `creating`                 | `requires_customer_action`, `processing`, `paid`, `failed`, `expired` |
| `requires_customer_action` | `processing`, `paid`, `failed`, `expired`, `cancelled`                |
| `processing`               | `paid`, `failed`, `expired`, `cancelled`                              |
| `paid`                     | `partially_refunded`, `refunded`                                      |
| `failed`                   | `paid` for a late verified provider success                           |
| `expired`                  | `paid` for a late verified provider success                           |
| `cancelled`                | `paid` for a late verified provider success                           |
| `partially_refunded`       | `partially_refunded`, `refunded`                                      |
| `refunded`                 | terminal                                                              |

An identical requested state is a no-op. A verified Safepay paid webhook is authoritative even if a
local timer or browser action previously marked the session failed, expired, or cancelled. That
late success must still undergo amount, currency, account, payment, order, and bill validation
before it wins.

Do not force Paely's internal enum to use these names if an established canonical model exists.
Add one explicit, exhaustively tested boundary mapper. Never silently map an unknown state.

## 13. Safepay webhook is the payment authority

Reuse the existing Safepay webhook route and financial commit path. Do not add a competing webhook
route merely for Restec unless the existing architecture cannot safely route the event; explain any
new route before adding it.

The required authoritative sequence is:

```text
exact raw Safepay webhook bytes
  -> identify the candidate Safepay account without trusting unverified financial fields
  -> load the venue-specific account and environment
  -> verify the exact provider signature using the correct account secret and raw bytes
  -> validate provider event type and provider environment
  -> durably deduplicate the provider event
  -> correlate provider tracker/reference to one Paely payment and one Restec session
  -> validate payment/order/bill/connection/location ownership
  -> validate amount and PKR currency
  -> lock affected financial rows
  -> commit canonical payment state exactly once
  -> reconcile canonical order/bill totals/status exactly once
  -> insert one durable Restec outbox event in the same transaction
  -> commit
  -> acknowledge Safepay
```

Use the exact current Safepay signature algorithm, header names, event fields, and account-selection
logic found in Paely's implementation and/or current official provider documentation. Do not
invent or weaken them based on this prompt.

The provider event deduplication key must be environment/account scoped and protected by a unique
constraint. The same Safepay event must not:

- create another payment;
- increase paid amount twice;
- complete the order twice;
- create another logical Restec event;
- create another provider charge;
- create duplicate refund effects.

Webhook failure must not partially update financial state. Use one database transaction or an
existing transactional database function/RPC to make provider-inbox acceptance, canonical payment
commit, order/bill reconciliation, and Restec outbox insertion atomic.

Return a successful provider acknowledgement only after the canonical financial commit and Restec
outbox insert are durable. Restec or POS availability must not be part of Safepay acknowledgement.
If Restec is down, the outbox remains pending and Safepay still receives the correct acknowledgement
for an already committed event.

Browser behavior:

- success return: show/poll state only;
- cancel return: may record customer intent only;
- browser closed: no financial state change;
- forged success URL: no financial state change;
- success URL before webhook: remains unpaid/processing;
- webhook after cancel or local expiry: verified paid state wins.

## 14. Exact Paely-to-Restec event body

For every authoritative hosted-session payment fact, create a body matching this exact shape:

```json
{
  "id": "STABLE_PRIVATE_PAELY_EVENT_ID",
  "type": "payment.completed",
  "schema_version": "2026-07-01",
  "created_at": "2026-07-24T12:30:00.000Z",
  "data": {
    "connection_id": "00000000-0000-4000-8000-000000000001",
    "location_id": "00000000-0000-4000-8000-000000000002",
    "external_bill_id": "POS-BILL-123",
    "external_table_id": "POS-TABLE-7",
    "payment": {
      "payment_id": "OPAQUE_PRIVATE_PAELY_PAYMENT_ID",
      "amount": 10000,
      "currency": "PKR",
      "method": "card",
      "status": "completed"
    },
    "payment_session": {
      "private_payment_session_id": "OPAQUE_PAELY_PRIVATE_SESSION_ID",
      "restec_payment_session_reference": "rps_test_OPAQUE",
      "status": "paid"
    },
    "bill": {
      "grand_total": 10000,
      "amount_paid": 10000,
      "amount_refunded": 0,
      "amount_due": 0,
      "payment_status": "paid",
      "version": 2
    }
  }
}
```

Exact field rules:

- `id`: required non-empty Paely-private event ID, immutable across retries.
- `type`: exactly one of:
  - `payment.completed`
  - `payment.failed`
  - `payment.expired`
  - `payment.refunded`
  - `payment.partially_refunded`
- `schema_version`: literal `2026-07-01`.
- `created_at`: immutable ISO 8601 time when the authoritative fact was committed, not dispatch time.
- `data.connection_id`: required UUID matching Restec's stored private Paely connection reference.
- `data.location_id`: required UUID matching Restec's stored private Paely location reference.
- `data.external_bill_id`: required exact external bill ID from the integration bill.
- `data.external_table_id`: required exact external table ID from the authoritative bill mapping.
- `data.payment.payment_id`: required stable private Paely payment reference.
- `data.payment.amount`: required nonnegative integer in minor units.
- `data.payment.currency`: required `PKR` for this flow.
- `data.payment.method`: use `card`. Restec also recognizes `wallet`, `cash`, `card_terminal`,
  `wallet_terminal`, `voucher`, and `other`; unknown methods are publicly mapped to `other`.
- `data.payment.status`: Restec's private parser accepts a string, but Paely must send an explicit
  canonical value consistent with the event. Do not invent a new enum solely for Restec.
- `data.payment_session`: mandatory for hosted payment-session events.
- `data.payment_session.private_payment_session_id`: exact immutable Paely private session ID.
- `data.payment_session.restec_payment_session_reference`: exact immutable Restec public session
  reference from create; it must match `^rps_(test|live)_[A-Za-z0-9]+$`.
- `data.payment_session.status`: exact Restec state consistent with `type`.
- `data.bill`: complete post-commit authoritative bill projection, not a delta.

Event-to-session status must be:

| Event type                   | `data.payment_session.status` |
| ---------------------------- | ----------------------------- |
| `payment.completed`          | `paid`                        |
| `payment.failed`             | `failed`                      |
| `payment.expired`            | `expired`                     |
| `payment.refunded`           | `refunded`                    |
| `payment.partially_refunded` | `partially_refunded`          |

`data.bill.payment_status` must be one of:

```text
unpaid
payment_in_progress
partially_paid
paid
partially_refunded
refunded
failed
```

The bill projection must satisfy:

```text
amount_due = max(0, grand_total - amount_paid + amount_refunded)
```

All four amounts must be integers from 0 through `2147483647`. `version` must be a positive,
monotonically correct authoritative bill version. If `payment_status` is `paid`, `amount_due` must
be zero.

For a completed payment-session event, Paely must verify before outbox insertion:

- private payment-session ID equals the session linked to the canonical payment;
- Restec public session reference equals the immutable create reference;
- event payment amount equals the session amount;
- event payment currency equals the session currency and is PKR;
- event connection equals the session/integration-bill connection;
- event location equals the session/bill location;
- event external bill equals the session's bill;
- event external table equals the current authoritative integration bill/table mapping;
- nested session status agrees with event type;
- full bill projection is internally and financially consistent;
- the payment ID identifies the one canonical committed Paely payment.

Apply equivalent amount/refund consistency for refund and partial-refund events. Explicitly
document whether `payment.amount` represents the original payment amount or the event delta in
Paely's existing event model, then add compatibility tests against Restec's expectations before
shipping. Do not guess silently.

Restec currently associates a session event in its database primarily by
`restec_payment_session_reference` plus connection. It does not yet fully cross-check the private
session ID, event amount/currency, or nested session status. This is a Restec hardening gap, not
permission for ambiguous data. Paely must provide stable, explicit identifiers and enforce all
associations before sending.

## 15. Exact Paely-to-Restec event authentication

Send:

```text
POST /api/internal/events/paely/v1
Content-Type: application/json
X-Paely-Event-Id: <exact body id>
X-Paely-Timestamp: <Unix epoch seconds for this delivery attempt>
X-Paely-Signature: v1=<64 lowercase hexadecimal characters>
X-Paely-Delivery-Attempt: <safe integer starting at 1>
X-Paely-Service-Id: <environment-specific approved Paely service identity>
X-Paely-Environment: sandbox|production
```

The exact event signature generated/verified by Restec's `signEvent` and
`verifyEventSignature` is:

```text
signature =
  "v1="
  + lowercase_hex(
      HMAC_SHA256(
        PAELY_EVENT_SIGNING_SECRET,
        UTF8(decimal_timestamp + ".") || exact_raw_event_body_bytes
      )
    )
```

Requirements:

- Serialize the event body once when the outbox row is created.
- Persist either those exact UTF-8 bytes or a canonical immutable serialized representation that
  is guaranteed byte-identical on every retry.
- Use the exact stored body bytes for HMAC and HTTP delivery.
- Never reserialize with different whitespace, property order, timestamp, null handling, or number
  formatting under the same event ID.
- Keep `id`, `type`, `schema_version`, `created_at`, and all `data` semantics unchanged across
  retries.
- Set `X-Paely-Event-Id` to exactly the body `id`.
- Use a fresh delivery timestamp and signature on each attempt.
- Increment `X-Paely-Delivery-Attempt` monotonically.
- Use constant-time comparisons in tests/mocks and never disclose expected signatures.
- Keep sandbox and production event HMAC keys and service identities separate.
- Keep the JSON body below Restec's current 1 MiB declared and actual body limit.

Restec computes a SHA-256 hash of the exact received raw bytes. A repeated event ID with an
identical body is accepted as a duplicate. A repeated event ID with different raw bytes is treated
as a replay conflict. Byte stability, not merely semantic similarity, is therefore required.

Restec durable acceptance is:

- HTTP 202 for first acceptance; or
- HTTP 200 for an exact duplicate already durably accepted.

Treat both as success. Record the response status, response event ID if safely available, attempt,
timestamps, and latency as sanitized delivery evidence.

## 16. Durable Paely outbox and dispatcher

Reuse Paely's existing Restec/integration outbox architecture. If it is incomplete, extend it
minimally. The outbox must provide:

- payment/order/bill commit and outbox insert in the same transaction;
- stable private event ID;
- stable deduplication key tied to the canonical financial transition;
- exact immutable serialized body;
- environment and destination identity;
- pending, processing/leased, delivered, retryable, and dead-letter states or established
  equivalents;
- atomic claim using `FOR UPDATE SKIP LOCKED`, an existing RPC, or an equivalent concurrency-safe
  mechanism;
- lease ownership and expiry recovery;
- attempt count and last-attempt timestamps;
- next-attempt time;
- sanitized response status/error category/latency evidence;
- explicit retry schedule with jitter and a maximum attempt/age policy;
- `Retry-After` handling where safe;
- dead-letter reason without raw secrets or provider bodies;
- audited manual replay that preserves the same event ID/body and never deletes evidence.

At minimum:

- retry timeouts, connection failures, 408, 425, 429, 500, 502, 503, and 504;
- treat Restec 200 and 202 as delivered;
- classify a permanent 400/401/403/404/409/413 contract/auth failure for operator review rather
  than endlessly retrying;
- never create a new logical event to retry an old one;
- never synchronously depend on POS availability;
- never delete financial evidence when delivered or dead-lettered.

Audit Paely's existing retry policy first. Preserve the established policy if it satisfies these
requirements. Otherwise add a bounded exponential-backoff schedule with jitter, document exact
delays/caps/maximum age, and test it with a deterministic clock.

The dispatcher target must be the environment-specific private Restec origin plus exactly
`/api/internal/events/paely/v1`. Enforce HTTPS outside local tests and prevent credential-bearing,
localhost, link-local, private-network, metadata-service, IP-literal, or cross-environment
destinations.

Disabling new Restec payment-session creation must not delete or strand already committed
financial outbox events. Continue safe delivery/reconciliation of existing evidence according to
Paely's operational policy.

## 17. Database audit and minimum additive migration

Audit the real Paely schema before designing a migration. Locate the real equivalents of:

- `payments`;
- `orders`;
- `integration_bills`;
- integration connections and location/table mappings;
- `merchant_payment_accounts`;
- `payment_webhook_events`;
- `integration_outbox_events`;
- existing request replay and idempotency records;
- existing provider tracker/session records;
- existing payment/order reconciliation functions.

Reuse them. Do not assume these names exist. Do not create a competing payment ledger.

Add only the minimum durable data required if it does not already exist:

- opaque private Paely payment-session ID;
- immutable Restec public payment-session reference;
- private Restec connection/location/bill/table associations;
- canonical Paely payment association;
- Restec-compatible session status projection;
- amount, currency, method, and expiry;
- provider tracker/reference needed for correlation;
- protected provider checkout URL only if the current Safepay flow requires persistence;
- scoped idempotency key;
- deterministic request fingerprint;
- raw request hash/audit evidence without sensitive data;
- provider webhook event deduplication;
- exact immutable Restec outbox body and its hash;
- delivery attempts, lease, retry/dead-letter state, and sanitized evidence.

Database-level constraints/indexes must protect:

- unique private session ID;
- unique Restec public session reference per environment;
- unique scoped idempotency key;
- same idempotency key plus immutable request fingerprint;
- unique provider tracker/reference per environment/account where the provider guarantees it;
- unique provider webhook event identity per environment/account;
- unique Restec logical event/deduplication key;
- connection + bill lookup;
- location + external bill lookup;
- active-session concurrency for a connection + bill where consistent with Paely's legitimate
  partial/split-payment behavior;
- dispatcher claim indexes on state and `next_attempt_at`;
- expiry/reconciliation scans.

Do not:

- drop or rename existing tables, columns, functions, or enums;
- rewrite production rows;
- backfill or modify historical financial facts without an explicit reviewed need;
- cascade-delete payments, orders, provider events, sessions, or outbox evidence;
- store PAN, CVV/CVC, expiry, PIN, OTP, track data, or raw card payloads;
- store Safepay credentials in plaintext;
- weaken row-level security or grants;
- expose private integration tables to public/anonymous roles.

Migration requirements:

- forward-only and additive;
- safe when the feature flag is false;
- transactionally applied where supported;
- explicit constraints and comments;
- regenerated database types if Paely tracks them;
- local migration test;
- sandbox-only review/apply instructions;
- rollback by feature disable and application rollback, preserving financial evidence;
- no destructive down migration.

Provider API calls cannot safely be rolled back by a database transaction. Model session creation
as an idempotent durable workflow: reserve the scoped request/session under database concurrency
control, perform one provider create using provider idempotency/correlation, and atomically attach
the result. A retry must resume/recover the reservation rather than create another provider
session.

## 18. Idempotency and concurrency guarantees

Implement these exact semantics:

```text
same Restec private Idempotency-Key + same exact request fingerprint
  -> return the original private payment session and original checkout result

same Restec private Idempotency-Key + different request fingerprint
  -> HTTP 409; no provider call and no new payment/session

ambiguous timeout after provider/session creation
  -> a Restec retry returns/reconstructs the original session; no second provider session/charge

concurrent same-key requests
  -> one winner creates; all others wait/read the same completed result or return a safe
     retryable in-progress response; never two provider sessions

concurrent different-key requests for the same bill
  -> apply Paely's authoritative partial/split/active-payment rule under row locking; never permit
     overpayment or incompatible simultaneous sessions
```

The request fingerprint must be deterministic and include at least environment, service identity,
HTTP method, exact pathname, private connection, private location, external bill ID, amount,
currency, method, customer fields, return URLs, and Restec public session reference. Prefer a
SHA-256 hash of a documented canonical representation or the exact signed raw body plus method/path.
Persist the algorithm/version.

Use a unique constraint and transaction/row lock, not an in-memory mutex. Tests must exercise
multiple concurrent processes or database transactions, not only promises sharing one process.

Explicitly implement and test recovery for:

- private request timeout before Paely commits;
- private response lost after Paely commits;
- provider timeout with no known provider object;
- provider object created but provider response lost;
- provider object created but Paely attachment transaction fails;
- duplicate private POST after success;
- conflicting private POST;
- duplicate Safepay webhook;
- duplicate Restec event dispatch;
- late paid webhook after local expiry;
- failed checkout followed by verified paid webhook;
- cancellation followed by verified paid webhook;
- full refund;
- partial refund;
- Restec temporarily unavailable;
- dispatcher crash after Restec accepted but before Paely marked delivered.

## 19. Feature flags and environment isolation

All work must be additive and disabled by default. Add or verify explicit Paely flags with these
semantics:

```text
RESTEC_INTEGRATION_ENABLED
RESTEC_PAYMENT_SESSIONS_ENABLED
RESTEC_SANDBOX_MODE
```

Required sandbox configuration:

```text
RESTEC_INTEGRATION_ENABLED=true
RESTEC_PAYMENT_SESSIONS_ENABLED=true
RESTEC_SANDBOX_MODE=true
```

Required initial production configuration:

```text
RESTEC_PAYMENT_SESSIONS_ENABLED=false
```

Do not use `NODE_ENV` alone. If Paely already has a stronger explicit deployment-environment
variable, keep it and validate it consistently with `RESTEC_SANDBOX_MODE`; fail closed on a
contradiction.

When `RESTEC_PAYMENT_SESSIONS_ENABLED=false`:

- private session POST returns 404;
- private session GET returns 404;
- no Safepay session is created;
- no new Paely payment session is created;
- no new canonical payment is created by these routes;
- existing QR ordering remains unchanged;
- existing card payment remains unchanged;
- existing Google Pay remains unchanged;
- existing PayFast remains unchanged;
- existing Safepay webhook routes remain unchanged;
- existing Restec bill create/get/external-payment routes remain unchanged;
- existing non-Restec orders remain unchanged;
- existing durable financial/outbox evidence is preserved.

Use physically and logically separate Paely sandbox and production:

| Resource                       | Sandbox               | Production                        |
| ------------------------------ | --------------------- | --------------------------------- |
| Vercel project                 | Paely sandbox project | separate Paely production project |
| Supabase project               | sandbox database only | separate production database      |
| Safepay account/credentials    | sandbox/UAT only      | production/live only              |
| Restec private bearer          | sandbox secret        | different production secret       |
| Restec request HMAC            | sandbox secret        | different production secret       |
| Paely event HMAC               | sandbox secret        | different production secret       |
| payment-account encryption key | sandbox key           | existing unchanged production key |
| Restec base URL                | Restec sandbox        | Restec production                 |
| provider webhook URL           | sandbox Paely URL     | production Paely URL              |
| provider environment           | Safepay sandbox       | Safepay live                      |
| public/session prefixes        | `rps_test_`           | `rps_live_`                       |

Validate this separation at startup and per request/account. Sandbox must reject production
credentials and provider accounts. Production must reject sandbox credentials and provider
accounts. Never infer provider environment from a customer-controlled request field.

## 20. Paely environment schema

After auditing Paely's actual environment schema, add only the missing variables and document each
with owner, secrecy, validation, and environment matching. At minimum Paely needs semantic
equivalents for:

| Variable/semantic setting             |           Secret | Required relationship                                                     |
| ------------------------------------- | ---------------: | ------------------------------------------------------------------------- |
| `RESTEC_INTEGRATION_ENABLED`          |               No | existing general Restec integration gate                                  |
| `RESTEC_PAYMENT_SESSIONS_ENABLED`     |               No | default false; private session POST/GET gate                              |
| `RESTEC_SANDBOX_MODE`                 |               No | explicit sandbox/production separation; not `NODE_ENV` alone              |
| approved Restec caller service ID     | Sensitive config | must equal Restec `PAELY_SERVICE_ID`                                      |
| Restec private bearer token           |              Yes | must equal Restec `PAELY_PRIVATE_BEARER_TOKEN` for the same environment   |
| Restec request-signing secret         |              Yes | must equal Restec `PAELY_PRIVATE_SIGNING_SECRET` for the same environment |
| Paely event service ID                | Sensitive config | must equal Restec `PAELY_EVENT_SERVICE_ID`                                |
| Paely event-signing secret            |              Yes | must equal Restec `PAELY_EVENT_SIGNING_SECRET` for the same environment   |
| Restec private event base URL         | Sensitive config | correct Restec sandbox/production private origin                          |
| approved Restec return URL hosts      | Sensitive config | exact Restec checkout host(s) for the same environment                    |
| request timestamp tolerance           |               No | coordinate with Restec; current Restec default is 300 seconds             |
| request replay retention              |               No | greater than timestamp tolerance plus margin                              |
| private request max body bytes        |               No | bounded before parsing                                                    |
| Restec delivery timeout               |               No | explicit bounded timeout                                                  |
| Restec outbox retry/lease settings    |               No | documented and deterministic in tests                                     |
| Safepay environment/account selection | Sensitive config | venue-specific sandbox account in sandbox                                 |
| payment credential encryption key     |              Yes | existing Paely system; never replace production key                       |

Do not put real values in `.env.example`, documentation, test fixtures, screenshots, logs, or the
final report. Use placeholders and secret-manager instructions.

## 21. Restec event acceptance and public identifier privacy

Restec transforms Paely identifiers before the POS sees them:

- private event ID -> deterministic public `evt_...`;
- private payment ID -> deterministic public `pay_...`;
- private location -> Restec public `loc_...`;
- private payment-session ID remains server-side;
- Restec public session ID remains `rps_test_...` or `rps_live_...`;
- provider checkout URL is encrypted at rest by Restec and exposed only through a Restec redirect.

Paely must not expose private Paely/Safepay information through:

- a public Paely payment page;
- browser query parameters;
- Restec return/cancel URLs;
- referer-generating intermediate pages;
- errors;
- logs;
- POS webhook payloads;
- status GET;
- dashboard APIs intended for POS vendors.

The only provider URL returned by the new private API is
`providerCheckoutUrl` to authenticated Restec. Restec validates HTTPS, exact configured hostname,
DNS resolution, and unsafe/private targets before encrypting it with AES-256-GCM. Coordinate the
actual Safepay hosted-checkout hostname with the Restec operator so
`RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS` can contain the exact hostname. Do not ask Restec to use a
wildcard, pathname prefix, IP address, redirector, or relaxed SSRF policy.

## 22. Required regression protection

Add focused tests and run the complete existing Paely suite. Prove no disruption to:

- normal Paely QR bill/order flow;
- normal non-Restec orders;
- existing customer payment page;
- existing Safepay card payments;
- existing Safepay hosted Google Pay;
- existing PayFast UAT flow;
- existing Safepay webhook raw-body/signature verification;
- provider account selection;
- merchant payment-account encryption/decryption;
- order reconciliation;
- partial payments;
- split payments where supported;
- refunds and partial refunds;
- dashboard order/payment state;
- existing Restec bill create/get;
- existing Restec external payments;
- disabled Restec integration mode;
- sandbox/production isolation.

Do not change existing public behavior merely to make a new test pass. Use narrow adapters and
feature-gated routes.

## 23. Mandatory test matrix

Implement automated tests for every row below. Use real database integration tests for atomicity,
unique constraints, row locking, and concurrent creation. Mocks alone are insufficient for those
properties.

### 23.1 Private authentication

- valid bearer + service ID + environment + timestamp + raw-body HMAC;
- wrong bearer;
- wrong service ID;
- wrong environment;
- sandbox credential in production;
- production credential in sandbox;
- missing signature;
- malformed signature prefix/length/hex;
- invalid signature;
- body changed by one byte after signing;
- JSON parsed/reserialized after signing;
- path encoding changed after signing;
- stale timestamp;
- future timestamp outside tolerance;
- invalid timestamp;
- duplicate request ID;
- request ID reused with a different body;
- missing request ID;
- missing POST idempotency key;
- GET succeeds without idempotency key;
- POST content type not JSON;
- body over configured size;
- constant-time comparison path exercised without leaking failure cause.

### 23.2 Session creation

- valid session returns the exact strict response and `requires_customer_action`;
- response contains no extra fields;
- bill not found;
- wrong venue/location;
- wrong connection;
- connection does not own bill;
- wrong integration/environment;
- disabled integration;
- feature disabled returns 404 with no side effects;
- bill already paid;
- bill/order completed;
- bill/order cancelled;
- bill changed incompatibly;
- amount above due;
- zero/negative/noninteger/overflow amount;
- wrong currency;
- unsupported method including `google_pay`;
- cardholder-data field rejected and not logged;
- unapproved Restec return host;
- disabled Safepay account;
- wrong-environment provider account;
- missing venue payment account;
- encrypted credential cannot be decrypted/key mismatch;
- provider rejects create;
- provider timeout before creation;
- ambiguous provider timeout after creation;
- local attach failure after provider creation;
- duplicate idempotency same body;
- idempotency conflict different body;
- concurrent same-key create;
- concurrent different-key create against the same due balance;
- active partial/split payment rules;
- returned URL is real HTTPS approved provider host;
- provider URL and tokens absent from logs/errors/snapshots;
- creation never marks payment/bill paid;
- browser success/cancel alone never marks paid.

### 23.3 Status GET

- each supported status serializes with exact casing;
- path ID must equal response ID;
- immutable public Restec reference returned;
- amount/currency/expiry unchanged;
- `paidAt` appears only as specified;
- unknown/cross-environment/cross-connection session hidden;
- disabled route returns 404;
- no provider URL, payload, secret, account, cardholder, bank, settlement, commission, or
  infrastructure leakage;
- exact empty body signature accepted.

### 23.4 Safepay webhook

- valid real-format success signature and event;
- invalid signature;
- body changed after signature;
- wrong venue/account;
- wrong provider environment;
- unknown tracker;
- tracker linked to another payment;
- wrong amount;
- wrong currency;
- wrong payment/order/bill association;
- duplicate provider event;
- two concurrent duplicate webhooks;
- late paid event after expiry;
- paid event after browser cancellation;
- failure;
- expiry;
- full refund;
- partial refund;
- repeated refund;
- browser redirect without webhook;
- canonical payment + order/bill + provider inbox + Restec outbox atomicity;
- forced transaction failure leaves none of the financial/outbox effects partially committed;
- Safepay acknowledgement does not wait for Restec/POS.

### 23.5 Event construction and delivery

- exact `payment.completed` body;
- exact failed, expired, refunded, and partially-refunded bodies;
- nested session status/type agreement;
- private/public session association;
- payment/session amount and currency agreement;
- connection/location/bill/table agreement;
- internally consistent complete bill projection;
- exact raw body reused across retries;
- valid event HMAC;
- header/body event ID match;
- service ID and environment match;
- first attempt number is 1 and later attempts increment;
- Restec 202 accepted;
- Restec 200 duplicate accepted;
- Restec 429 with and without `Retry-After`;
- Restec 500;
- network timeout;
- dispatcher crash after Restec accepts;
- permanent 400;
- authentication/configuration 401;
- payload too large 413;
- dead-letter;
- audited manual replay;
- event ID/body stability;
- provider, customer, secret, settlement, database, and private infrastructure data absent.

### 23.6 Isolation and regression

- feature disabled returns 404 before any provider/database session side effect;
- production cannot use sandbox Restec or provider credentials;
- sandbox cannot use production Restec or provider credentials;
- non-Restec payments produce no Restec event;
- Paely public APIs do not expose private routes/data;
- existing production behavior is unchanged while flag false;
- normal QR, card, Google Pay, PayFast, refund, partial/split, dashboard, reconciliation, and
  existing Restec bill/external-payment tests remain passing.

Run the complete existing Paely payment suite, complete Restec-integration suite in Paely,
database/migration tests, typecheck, lint, and production build. Report exact commands, exit codes,
test counts, skipped tests, and failures. A skipped remote test is not a pass.

## 24. Real sandbox certification script

Create or improve one Paely certification script in the location and style already used by Paely.
Do not create a documentation-only simulation. The script must be sandbox-only, explicitly gated,
safe to rerun, and produce sanitized evidence.

It must actually:

1. Confirm Paely Sandbox health through the real deployed `/api/ping` route.
2. Cause or receive a real Restec-signed private payment-session POST.
3. Verify Paely accepted the real bearer, identity, environment, raw-body HMAC, request ID, and
   idempotency key.
4. Create a real Safepay sandbox hosted card checkout.
5. Validate and record the strict private response without printing the tokenized provider URL.
6. Provide the operator the Restec-branded checkout URL, not the private provider URL.
7. Pause/poll while the operator manually opens the Restec URL and enters a Safepay sandbox card.
8. Never automate card entry and never accept card details as script arguments.
9. Wait for a real Safepay sandbox webhook.
10. Verify the provider event was signature-verified and deduplicated.
11. Verify one canonical Paely payment and the expected canonical order/bill state.
12. Verify exactly one Paely `payment.completed` Restec outbox event with correct identifiers,
    amount, PKR currency, state, and bill projection.
13. Run or wait for the real Paely dispatcher.
14. Confirm Restec returned 202 or 200 and Paely marked the outbox delivered.
15. Confirm Restec accepted the private event, marked its session paid, and updated the bill.
16. Confirm Restec created and delivered one POS event.
17. Confirm the dummy POS accepted and stored the signed event.
18. Produce sanitized pass/fail evidence with IDs safe for the operator, timestamps, statuses, and
    hashes—not secrets, raw signed bodies, customer data, or provider URL tokens.

Do not call an environment-variable presence check “certification.” Do not mark the run passing if
the card was not completed, no real Safepay webhook arrived, the Paely outbox was only mocked, the
Restec event was not durably accepted, or the dummy POS receipt was not verified.

The current Restec-side operator script is `scripts/certify-real-payment-session.ts`. It creates a
real Restec bill and session, outputs only the Restec checkout URL, waits for manual completion,
polls Restec state, dispatches the Restec POS outbox, and queries sanitized evidence. Coordinate
Paely's script/runbook with it rather than duplicating or bypassing it.

## 25. Safe local verification workflow

Discover Paely's actual package manager and scripts from its lockfile and `package.json`. Then run
the repository's exact commands. A typical PowerShell structure is below; replace only command
names with the audited Paely scripts:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

git status --short
node --version

# Use exactly one, based on the committed lockfile:
npm ci
# pnpm install --frozen-lockfile
# yarn install --immutable

# Replace these with Paely's actual script names discovered from package.json.
npm run typecheck
npm run lint
npm test
npm run build

# Run focused integration suites using Paely's actual runner and file paths.
npm run test -- <actual-restec-payment-session-test-files>
npm run test -- <actual-safepay-webhook-test-files>
npm run test -- <actual-payment-order-regression-test-files>

# Validate migrations using Paely's established local Supabase workflow.
npx supabase status
npx supabase db reset
```

Do not add a package manager or replace the current one. Do not run a formatter over unrelated
files. Do not silently update lockfile dependencies unless required and explicitly justified.

Before finishing, inspect:

```powershell
git status --short
git diff --stat
git diff --check
```

Review every changed file and prove changes are limited to Paely's additive implementation, tests,
migration, safe script, and necessary documentation/environment examples.

## 26. Manual sandbox deployment instructions to produce, not execute

Do not deploy. In the final response, provide a copy/paste PowerShell runbook tailored to Paely's
actual repository and project names. It must keep production untouched and contain these phases.

### Phase A: review

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

git status --short
git diff --check
git diff -- <exact-new-migration-path>
git diff -- <exact-feature-and-route-files>
git diff -- <exact-tests-and-certification-script>

# Use Paely's actual commands:
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Expected result: all local checks pass; migration is additive; no production value or secret is in
the diff; feature default is false.

### Phase B: link and inspect Paely Sandbox Supabase only

```powershell
$env:PAELY_SANDBOX_SUPABASE_PROJECT_REF = '<sandbox-project-ref>'

# Confirm this value is the Paely SANDBOX project before continuing.
npx supabase link --project-ref $env:PAELY_SANDBOX_SUPABASE_PROJECT_REF
npx supabase migration list
npx supabase db push --dry-run
```

The runbook must include a positive operator checkpoint that compares the linked project reference
to the approved Paely Sandbox reference. Never include or infer the production project reference.

### Phase C: manually apply migration to Paely Sandbox only

```powershell
npx supabase db push
npx supabase migration list
```

Expected result: exactly the reviewed additive migration is newly applied. No destructive statement
and no production connection is used.

### Phase D: set sandbox flags/secrets manually

In the Paely Sandbox Vercel project only, configure:

```text
RESTEC_INTEGRATION_ENABLED=true
RESTEC_PAYMENT_SESSIONS_ENABLED=true
RESTEC_SANDBOX_MODE=true
```

Also configure the separate sandbox Restec bearer/request-HMAC/event-HMAC identities, Restec
sandbox URL/return host, Safepay sandbox account, and existing sandbox encryption key through the
approved secret manager. Do not put values in commands or logs.

In production, verify only through the approved configuration review process that:

```text
RESTEC_PAYMENT_SESSIONS_ENABLED=false
```

Do not access or change the production project while performing this task.

### Phase E: deploy reviewed commit to Paely Sandbox only

Give the operator the repository's actual reviewed deployment mechanism. Prefer the existing
Vercel Git integration if that is Paely's standard process. Identify the exact sandbox project and
branch mapping without exposing IDs/secrets. Do not run `vercel deploy`, promote, alias, or modify
production.

Environment-variable changes require a new sandbox deployment. The runbook must explicitly tell
the operator to redeploy the same tested commit after configuring variables.

### Phase F: health and real certification

```powershell
$paelySandboxBase = 'https://<paely-sandbox-host>'
$restecSandboxBase = 'https://<restec-sandbox-host>'

Invoke-RestMethod -Method Get -Uri "$paelySandboxBase/api/ping"

# Use Paely's actual gated script name and safe non-secret arguments.
$env:RUN_REAL_RESTEC_PAYMENT_SESSION_CERTIFICATION = 'true'
npm run <actual-paely-certification-script>
```

Then run the current Restec certification from the Restec repository:

```powershell
$env:RUN_REAL_PAYMENT_SESSION_CERTIFICATION = 'true'
npm run certify:real-payment-session
```

Do not pass card data on the command line. The operator manually uses Safepay's sandbox card page.

### Phase G: rollback

```text
1. Set RESTEC_PAYMENT_SESSIONS_ENABLED=false in Paely Sandbox.
2. Redeploy the previously tested Paely Sandbox commit/configuration.
3. Confirm authenticated private POST and GET now return 404.
4. Confirm no new provider/payment sessions are created.
5. Continue processing already committed financial/provider webhook and outbox evidence.
6. Reconcile in-flight sessions manually.
7. Preserve new tables/columns/inbox/outbox/delivery evidence.
8. Do not drop the migration or delete financial rows.
9. Roll back application code only through the repository's normal reviewed commit-revert process.
10. Keep Paely Production unchanged and disabled.
```

## 27. SQL verification queries

After auditing the Paely schema, include executable, read-only SQL using the actual Paely table and
column names. Do not leave pseudocode placeholders in the final implementation report. Every query
must be scoped by a single safe test ID and return no credential ciphertext, provider URL/token,
customer data, raw webhook payload, or raw signed body.

At minimum provide Paely Sandbox queries that prove:

1. one private session exists for the Restec public session reference;
2. it belongs to the expected connection/location/external bill;
3. one canonical payment exists with amount/currency/status;
4. provider tracker correlation exists without exposing the tracker value—return a boolean or hash;
5. one Safepay provider event was accepted/deduplicated;
6. order/bill totals and status are correct;
7. exactly one logical Restec outbox event exists;
8. the outbox event ID/body hash stayed stable across delivery attempts;
9. Restec returned 200/202 and the event is delivered;
10. no dead-letter exists for the certification event;
11. duplicate provider event count/effect remains one;
12. no sensitive card fields exist in session/payment/outbox data.

Use a transaction with read-only intent where supported:

```sql
begin transaction read only;
-- exact audited, test-ID-scoped SELECT statements here
rollback;
```

Also give the operator these Restec-side read-only verification queries. Replace
`<rps_test_id>` only with the certification's Restec public session ID:

```sql
begin transaction read only;

select public_payment_session_id,
       environment,
       connection_id,
       location_id,
       external_bill_id,
       method,
       amount_minor,
       currency,
       status,
       expires_at,
       paid_at,
       created_at,
       updated_at,
       (private_payment_session_reference is not null) as has_private_session,
       (encrypted_provider_checkout_url is not null) as has_encrypted_checkout_url
from public.payment_sessions
where public_payment_session_id = '<rps_test_id>';

select private_event_id,
       event_type,
       schema_version,
       status,
       processed_at,
       received_at
from public.private_event_inbox
where payload->'data'->'payment_session'->>'restec_payment_session_reference' = '<rps_test_id>';

select public_event_id,
       event_type,
       status,
       attempt_count,
       next_attempt_at,
       delivered_at,
       dead_lettered_at,
       created_at
from public.pos_outbox_events
where payload->'data'->>'payment_session_id' = '<rps_test_id>';

select a.public_event_id,
       a.attempt_number,
       a.outcome,
       a.response_status,
       a.error_code,
       a.duration_ms,
       a.created_at
from public.webhook_delivery_attempts a
join public.pos_outbox_events o
  on o.public_event_id = a.public_event_id
where o.payload->'data'->>'payment_session_id' = '<rps_test_id>'
order by a.attempt_number;

select r.event_id,
       r.event_type,
       r.received_at
from public.mock_pos_receipts r
join public.pos_outbox_events o
  on o.public_event_id = r.event_id
where o.payload->'data'->>'payment_session_id' = '<rps_test_id>';

rollback;
```

Expected successful evidence:

- one Restec session, status `paid`;
- non-null private-session and encrypted-checkout flags, without selecting their values;
- one accepted `payment.completed` private inbox fact;
- one delivered POS outbox fact;
- at least one successful delivery attempt;
- one dummy POS receipt;
- no dead-letter.

If any actual Restec column differs in the deployed migration version, stop and reconcile migration
state instead of editing an ad hoc query or changing production.

## 28. Restec-side limitations Paely must account for

Paely cannot repair these from its repository, but its implementation and report must call them
out:

1. Restec's current `accept_payment_session_event` RPC matches primarily on public session
   reference and connection. It does not fully compare private session ID, event amount/currency,
   or nested status against the stored session.
2. Restec's `ReconciliationService.reconcilePaymentSessions` can update a session from private GET,
   but a discovered `paid` state does not update the Restec bill, insert a private inbox/outbox
   event, or notify the POS. The signed Paely event remains mandatory.
3. Restec's private GET response parsing is less strict than its declared TypeScript interface.
   Paely must still return the strict schema in this prompt.
4. Restec's private client retries immediately up to three times and currently has no in-client
   backoff/jitter or `Retry-After` handling. Paely idempotency must tolerate that behavior.
5. Restec must configure the real Safepay hosted-checkout hostname in
   `RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS`; Paely cannot change that safely.
6. The Restec repository does not contain or certify Safepay/PayFast provider code. Provider
   correctness must be demonstrated in Paely and by real sandbox evidence.
7. Current Restec certification is not remotely complete. Environment-variable checks and local
   mocks do not certify this workflow.
8. Restec has canonical/mock POS connectors, but real POS-vendor connector certification is a
   separate Restec operational task.

Do not work around these limitations by bypassing the signed event route, calling a public Restec
route, or weakening identifiers.

## 29. Implementation quality gates

Before reporting completion:

- all private routes are behind both the general Restec integration gate and payment-session gate;
- production default is disabled;
- all request/event signatures use exact raw bytes;
- all secret comparisons are constant time;
- replay and idempotency are durable;
- concurrent creates cannot duplicate provider sessions/charges;
- provider webhook financial commit and Restec outbox insertion are atomic;
- event body bytes and ID are stable across retries;
- 200/202 acceptance is implemented;
- provider/bank/settlement/card/infrastructure data cannot cross the private response or event;
- no public Paely route exposes the new private data;
- no existing financial flow regressed;
- migration is additive;
- local tests/typecheck/lint/build pass;
- real remote certification is labeled pending unless actually completed with sanitized evidence.

Use status labels precisely:

- **Implemented and locally tested**: code exists and relevant local automated tests passed.
- **Implemented, database-integration tested**: real local/sandbox PostgreSQL transaction and
  concurrency tests passed.
- **Mocked only**: a fake provider/Restec endpoint was used.
- **Deployed to sandbox, not certified**: route exists remotely but no complete provider lifecycle.
- **Remotely certified**: real Safepay sandbox hosted checkout, real verified provider webhook,
  Paely canonical commit/outbox, Restec acceptance/projection/outbox, and dummy POS receipt all
  passed.
- **Blocked**: name the external or technical blocker and evidence.

Never promote a lower status to a higher one.

## 30. Required final response from Paely Codex

Return a structured implementation report containing exactly these major sections:

1. **Current Paely audit**
   - actual files, functions, routes, tables, provider adapters, flags, workers, and gaps found.
2. **Compatibility assessment against Restec**
   - every locked request/response/header/event field and whether it is implemented.
3. **Exact routes implemented**
   - methods, paths, gates, auth, and handlers.
4. **Exact request and response schemas**
   - strict JSON examples and validation rules, with no secret values.
5. **Exact authentication and signature rules**
   - raw bytes, canonicalization, constant time, timestamp/replay, identity/environment.
6. **Exact event schema**
   - all five types, status mapping, bill invariants, stable byte behavior.
7. **Database migration**
   - migration path, additive objects/columns/constraints/indexes/functions, and safety review.
8. **Files changed**
   - every file and why.
9. **Feature flags**
   - defaults, route behavior, sandbox values, production-disabled proof.
10. **Environment matrix**
    - variable names, ownership, secrecy, validation, and Restec value matching without values.
11. **Safepay sandbox requirements**
    - actual existing adapter/account/webhook dependencies and remaining setup.
12. **Idempotency design**
    - fingerprint, scope, constraints, concurrency, ambiguous provider recovery.
13. **Outbox/retry design**
    - atomic insert, body stability, claim/lease, exact schedule, success/failure classification,
      dead letter, replay.
14. **Regression protection**
    - existing flows and tests proving no disruption.
15. **Test results**
    - exact commands, exit codes, counts, skips/failures, database/concurrency coverage.
16. **Build results**
    - typecheck, lint, production build commands and results.
17. **Manual deployment commands**
    - exact Paely Sandbox PowerShell runbook; no automatic deployment.
18. **SQL verification queries**
    - executable Paely and Restec read-only queries with actual identifiers.
19. **End-to-end certification steps**
    - manual card entry, real webhook, Paely/Restec/POS evidence, and exact current status.
20. **Production isolation proof**
    - separate resources/credentials and production flag false.
21. **Rollback procedure**
    - feature disable/redeploy/reconcile/preserve evidence; no destructive schema rollback.
22. **Remaining blockers**
    - Paely, provider, Restec, credentials, deployment, monitoring, or certification gaps with no
      assumptions stated as facts.

End with a concise verdict stating one of:

```text
Implemented and locally tested; remote certification pending.
Deployed to Paely Sandbox; real Safepay-to-Restec-to-POS certification pending.
Remotely certified in sandbox with sanitized evidence; production remains disabled.
Blocked: <specific verified blocker>.
```

Do not deploy automatically. Do not access production. Do not change production environment
variables. Do not rotate secrets. Do not expose secret values. Do not modify Restec. Do not accept
card data. Do not call Restec public APIs. Do not claim success until a real Safepay sandbox
webhook and complete Restec-to-POS delivery are verified.

$BaseUrl = "https://paely-sandbox.vercel.app"
$VenueId = "10000000-0000-4000-8000-000000000001"

function Read-SecretText([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    return ([System.Net.NetworkCredential]::new("", $secure)).Password
}

$AdminToken = Read-SecretText "qDyAJGXJMZWG9F_wZB7356P7fse3jW6nwz1Trm4_mYT_pjsx0jabIMUHDn0LQ4_x"
$SafepayPublicKey = Read-SecretText "sec_edeeec49-06be-4171-b40a-5c701a61847b"
$SafepaySecretKey = Read-SecretText "7580163455f2cbeaaac6c00984ad025dd0ebb494c15beac4752130016afdc83d"
$SafepayWebhookSecret = Read-SecretText "d48f304217ad4f265d9182c20e713604f061f7c2bdf124585c2924ae0170fa98"
