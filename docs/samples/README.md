# Restec signature and webhook samples

Copyable examples are provided for [cURL](curl.md), [Node.js/JavaScript](node-javascript.mjs), [Node.js/TypeScript](node-typescript.ts), [Python](python.py), [PHP](php.php), [Java](RestecExample.java), [C#](RestecExample.cs), and [Go](restec_example.go). They cover signed bill and hosted payment-session calls, webhook verification, event-ID deduplication guidance, and status/error handling.

Every implementation computes HMAC-SHA256 over the timestamp and exact raw JSON bytes, prefixes the lowercase hexadecimal digest with `v1=`, uses constant-time comparison for inbound webhooks, enforces a timestamp window, and deduplicates `X-Restec-Event-Id`.

```text
request_input = timestamp + "." + METHOD + "." + path + "." + exact_raw_body
webhook_input = timestamp + "." + exact_raw_body
```

Use placeholder `rst_test_example` and `replace-with-signing-secret` values only. Do not parse and reserialize a body after signing. Common failures return `invalid_credentials`, `replay_detected`, or `idempotency_conflict` in the standard error envelope.

Use HTTPS, integer minor units, a stable logical `Idempotency-Key`, and a fresh unique `X-Request-Id` per network attempt. Treat non-2xx responses as the documented error envelope and retry only retryable statuses.

Card data is entered only on the secure hosted checkout. Open only the returned Restec `checkout_url`; do not interpret a browser redirect as payment completion. Apply payment only after a verified signed webhook or authenticated status response.
