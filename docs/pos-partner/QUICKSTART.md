# Quickstart

Obtain a sandbox base URL, partner credential, request-signing secret, Restec location ID, environment value, and webhook-signing secret from Restec. Store secrets in a secret manager.

For every API request, create a new `X-Request-Id` and Unix-seconds `X-Restec-Timestamp`. Sign these exact bytes:

```text
timestamp.METHOD.path.exact_raw_body
```

Send the HMAC-SHA256 as `X-Restec-Signature: v1=<lowercase-hex>`. Use `Content-Type: application/json`, including for signed GET requests; a GET has an empty body.

1. Call `GET /v1/locations/{location_id}/tables` and confirm the expected table mapping.
2. Upsert bill revision 1 with `PUT /v1/locations/{location_id}/bills/{external_bill_id}` and an `Idempotency-Key`.
3. Send later bill revisions with a new idempotency key and a higher body `version`.
4. For a customer card payment, create a session and open the returned Restec `checkout_url`. Treat only a terminal Restec status or signed webhook as authoritative.
5. For cash or a physical terminal, report the completed payment with the external-payments endpoint.
6. Verify every webhook signature before persisting `event_id`. Persist the ID under a unique constraint before returning a supported 2xx.
7. Reconcile with the bill GET endpoint after timeouts or ambiguous responses.

Use the supplied Postman environment for placeholders only. Never place real credentials in a shared collection or source control.
