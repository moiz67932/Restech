# Restec POS Integration Guide

Restec is a digital payment and restaurant POS integration service. A POS integrates once with the Restec JSON API, reports bill changes and completed external payments, receives signed payment events, and reconciles through bill lookup.

## What each team builds

Restec provides authenticated bill, payment, table, sandbox, reconciliation, and webhook interfaces. The POS team must call the bill API whenever a bill changes; report completed cash or terminal payments; host one HTTPS webhook endpoint; verify signatures; store event IDs uniquely; apply each event once; acknowledge only after durable acceptance; and reconcile after downtime.

The physical table QR is stable. Send the correct `external_table_id`; bill changes update server state and do not require replacing the QR.

## Environments and credentials

| Environment | Base URL                        | Key prefix  |
| ----------- | ------------------------------- | ----------- |
| Sandbox     | `https://sandbox-api.restec.io` | `rst_test_` |
| Production  | `https://api.restec.io`         | `rst_live_` |

Credentials never cross environments. Each credential set contains an API key, request-signing secret, and webhook-signing secret. A full API key is shown once. Rotate by overlapping old and new credentials, moving traffic, then revoking the old key.

## Request signing

Every `/v1` request requires `Authorization`, `X-Restec-Timestamp`, `X-Restec-Signature`, `X-Request-Id`, and `Content-Type: application/json`. Mutations also require `Idempotency-Key`.

Build the signing input without added whitespace:

```text
timestamp + "." + UPPERCASE_METHOD + "." + request_path + "." + exact_raw_body
```

Hash it with HMAC-SHA256 and send lowercase hex as `v1=<hex>`. Sign exactly the bytes sent. For GET, the raw body is empty. Generate a fresh `req_...` for every network attempt and use a constant-time comparison in verification code.

## Idempotency and retries

Choose one stable `Idempotency-Key` for each logical mutation. Retrying the same method, path, and body returns the original response. Reusing the key for different input returns `409 idempotency_conflict`. A request still being processed returns a retryable `409`. Keep the idempotency key but generate a new request ID and signature on every retry.

Retry `408`, `425`, `429`, `500`, `502`, `503`, and `504` with bounded exponential backoff and jitter. Honor `Retry-After`. Do not automatically retry permanent validation and authorization errors.

## Create or update a bill

`PUT /v1/locations/{locationId}/bills/{externalBillId}`

```json
{
  "external_table_id": "12",
  "external_order_id": "ORDER-991",
  "version": 1,
  "currency": "PKR",
  "status": "open",
  "order_status": "accepted",
  "items": [
    {
      "external_item_id": "ITEM-91",
      "name": "Zinger Burger",
      "quantity": 2,
      "unit_amount": 85000,
      "total_amount": 170000,
      "notes": "One without mayo"
    }
  ],
  "totals": {
    "subtotal": 170000,
    "tax": 8500,
    "service_charge": 0,
    "discount": 0,
    "tip": 0,
    "grand_total": 178500
  },
  "occurred_at": "2026-07-18T10:30:00Z",
  "metadata": {}
}
```

Money is an integer in minor units: `178500` means PKR 1,785.00. Quantities are positive integers. Item totals, subtotal, tax, service charge, tip, discount, and grand total must reconcile exactly. New bills start at version 1. Increment the version whenever content changes. Same version and body is a no-op; same version with different content or an older version returns `409 bill_version_conflict`.

The response contains only Restec and POS identifiers plus the canonical bill/payment state. `amount_due` is the field to reconcile.

## Retrieve a bill

`GET /v1/locations/{locationId}/bills/{externalBillId}` returns the current canonical state and does not require `Idempotency-Key`. Use it after outages, ambiguous timeouts, or webhook downtime.

## Report an external payment

`POST /v1/locations/{locationId}/bills/{externalBillId}/external-payments`

```json
{
  "external_payment_id": "POSPAY-55431",
  "method": "card_terminal",
  "amount": 178500,
  "currency": "PKR",
  "status": "completed",
  "occurred_at": "2026-07-18T10:45:00Z",
  "processor_reference": "OPTIONAL-REFERENCE",
  "metadata": {}
}
```

Methods are `cash`, `card_terminal`, `wallet_terminal`, `voucher`, or `other`. Never send PAN, card number, CVV, PIN, track data, bank credentials, or raw wallet credentials. Reuse `external_payment_id` only for the same payment fact.

## Tables

`GET /v1/locations/{locationId}/tables` returns `table_id`, `external_table_id`, name, and active state. Use the external ID assigned during onboarding when sending a bill.

## Payment webhooks

Restec posts to the certified HTTPS endpoint with `X-Restec-Event-Id`, `X-Restec-Timestamp`, `X-Restec-Signature`, and `X-Restec-Delivery-Attempt`. Verify HMAC-SHA256 over `timestamp + "." + exact_raw_body` before parsing.

In one durable transaction: insert the event ID into a unique column, store the payload or required update, and commit. Return `200`, `201`, `202`, or `204` afterward. A unique-conflict means the event was already accepted and should receive success without a second financial action.

Events are `payment.completed`, `payment.failed`, and `payment.refunded`. The same bill may receive several completed events for partial payments. Close an invoice only when both `payment_status = paid` and `amount_due = 0`.

Delivery retries keep the same event ID. Temporary failures retry after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours. Responses `400`, `401`, `403`, `404`, `409`, and `422` are permanent unless an exception is agreed during certification.

## Sandbox scenarios

`POST /v1/test/scenarios` exists only in sandbox and returns 404 in production. Supply `external_bill_id`, optional `location_id`, optional minor-unit `amount`, and one of: `payment.completed`, `payment.failed`, `payment.refunded`, `partial_payment.completed`, `duplicate_event`, `delayed_event`, `out_of_order_event`, `webhook_timeout`, `webhook_429`, `webhook_500`, `amount_mismatch`, or `bill_already_paid`.

Scenarios use the normal event acceptance and delivery path. They do not establish production payment state.

## Error model

```json
{
  "error": {
    "code": "bill_version_conflict",
    "message": "The supplied bill version conflicts with the current version.",
    "request_id": "req_01EXAMPLE",
    "details": {}
  }
}
```

Stable codes are `invalid_request`, `invalid_credentials`, `access_denied`, `resource_not_found`, `replay_detected`, `idempotency_conflict`, `bill_version_conflict`, `payment_in_progress`, `bill_already_paid`, `payload_too_large`, `amount_mismatch`, `invalid_status_transition`, `rate_limited`, `internal_error`, and `dependency_unavailable`. Quote `request_id` when escalating.

## Versioning, rate limits, and support

The current event schema is `2026-07-01`; the HTTP API is `/v1`. Compatible fields may be added. Breaking changes use a new version with a migration window. Rate limits apply by credential, partner, location, and endpoint class; a limited response includes `Retry-After`.

Use placeholder credentials in tickets. Never send signing secrets or full API keys. Provide environment, request ID, event ID when relevant, UTC timestamp, endpoint, status, and a redacted summary. Copyable implementations are in `docs/samples/`; the sandbox collection is in `docs/postman/`.

Complete [the certification checklist](RESTEC_POS_CERTIFICATION_CHECKLIST.md) before production access.
