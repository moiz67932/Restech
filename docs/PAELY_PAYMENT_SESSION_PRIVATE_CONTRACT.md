# Paely Payment Session Private Contract

This is an internal service-to-service contract. It must never be published in POS-facing artifacts.

## Create

`POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions`

Headers:

- `Authorization: Bearer <private token>`
- `X-Restec-Service-Id`
- `X-Restec-Environment: sandbox|production`
- `X-Restec-Timestamp: <Unix seconds>`
- `X-Restec-Signature: v1=<lowercase HMAC-SHA256>`
- `X-Request-Id: req_<unique per attempt>`
- `Idempotency-Key: <stable deterministic key>`
- `Content-Type: application/json`

Canonical signature bytes are:

`timestamp + "." + UPPERCASE_METHOD + "." + request_path + "." + exact_raw_body`

The JSON string created by `JSON.stringify` is signed and sent without reserialization.

Request:

```json
{
  "connectionId": "10000000-0000-4000-8000-000000000201",
  "amountMinor": 10000,
  "currency": "PKR",
  "method": "card",
  "customer": {
    "email": "sandbox@example.com",
    "mobile": "03000000000"
  },
  "returnUrls": {
    "success": "https://restech-api-qkrx.vercel.app/s/rps_test_example/return",
    "cancel": "https://restech-api-qkrx.vercel.app/s/rps_test_example/cancel"
  },
  "restecPaymentSessionReference": "rps_test_example"
}
```

Response:

```json
{
  "privatePaymentSessionId": "opaque-private-reference",
  "status": "requires_customer_action",
  "providerCheckoutUrl": "https://approved-host.example/opaque-path",
  "amountMinor": 10000,
  "currency": "PKR",
  "expiresAt": "2026-07-23T12:30:00Z"
}
```

The response must be strict, the URL must be HTTPS and unexpired, and amount/currency must match. Paely must treat the idempotency key plus exact logical input as one creation. Same key/body returns the same session; same key/different body returns 409. A timeout after Paely commits must be safely recoverable by the same key.

## Status

`GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}`

It uses the same identity, environment, timestamp, signature, request-ID, timeout, and sanitized-error rules. The signed body is empty. Response fields are `privatePaymentSessionId`, optional `restecPaymentSessionReference`, `status`, `amountMinor`, `currency`, `expiresAt`, and optional `paidAt`.

## Event extension

Events continue to POST `/api/internal/events/paely/v1` with the existing exact-body event signature plus:

- `X-Paely-Service-Id: <approved identity>`
- `X-Paely-Environment: sandbox|production`
- `X-Paely-Event-Id`
- `X-Paely-Timestamp`
- `X-Paely-Signature`
- `X-Paely-Delivery-Attempt`

Payment-session events include:

```json
{
  "payment_session": {
    "private_payment_session_id": "opaque-private-reference",
    "restec_payment_session_reference": "rps_test_example",
    "status": "paid"
  }
}
```

Supported types are `payment.completed`, `payment.failed`, `payment.expired`, `payment.refunded`, and `payment.partially_refunded`. `payment.completed` must be emitted only after the regulated provider webhook has been verified and Paely has durably updated canonical payment/order state. The event must include the existing connection, location, bill, payment, and bill-projection fields. Re-delivery keeps the same event ID and exact semantic fact.

## Error mapping

- 401/403: non-retryable private authentication/authorization failure, publicly sanitized to a generic dependency error.
- 404: non-retryable missing private location/bill/session; no route details forwarded.
- 409: idempotency conflict unless Paely documents a temporary in-progress conflict.
- 422: non-retryable contract validation failure.
- 408/425/429/5xx/network/timeout: retryable according to the existing Restec client policy.
- Malformed success: non-retryable 502-equivalent dependency failure.

No raw Paely body, URL, identifier, stack, provider response, credential, commission, settlement, submerchant, or bank detail may cross the public Restec boundary.
