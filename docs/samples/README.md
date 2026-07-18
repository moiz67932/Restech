# Restec signature and webhook samples

Copyable examples are provided for [cURL](curl.md), [Node.js/TypeScript](node-typescript.ts), [Python](python.py), [PHP](php.php), [Java](RestecExample.java), [C#](RestecExample.cs), and [Go](restec_example.go). Each includes a signed bill call, webhook verification, event-ID deduplication guidance, and status/error handling.

Every implementation computes HMAC-SHA256 over the timestamp and exact raw JSON bytes, prefixes the lowercase hexadecimal digest with `v1=`, uses constant-time comparison for inbound webhooks, enforces a timestamp window, and deduplicates `X-Restec-Event-Id`.

```text
request_input = timestamp + "." + METHOD + "." + path + "." + exact_raw_body
webhook_input = timestamp + "." + exact_raw_body
```

Use placeholder `rst_test_example` and `replace-with-signing-secret` values only. Do not parse and reserialize a body after signing. Common failures return `invalid_credentials`, `replay_detected`, or `idempotency_conflict` in the standard error envelope.

Use HTTPS, integer minor units, a stable logical `Idempotency-Key`, and a fresh unique `X-Request-Id` per network attempt. Treat non-2xx responses as the documented error envelope and retry only retryable statuses.
