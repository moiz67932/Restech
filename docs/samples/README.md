# Restec signature and webhook samples

The examples cover cURL, Node.js/TypeScript, Python, PHP, Java, C#, and Go. Each implementation must compute HMAC-SHA256 over the timestamp and exact raw JSON bytes, prefix the lowercase hexadecimal digest with `v1=`, use constant-time comparison for inbound webhooks, enforce a timestamp window, and deduplicate `X-Restec-Event-Id`.

```text
request_input = timestamp + "." + METHOD + "." + path + "." + exact_raw_body
webhook_input = timestamp + "." + exact_raw_body
```

Use placeholder `rst_test_example` and `replace-with-signing-secret` values only. Do not parse and reserialize a body after signing. Common failures return `invalid_credentials`, `replay_detected`, or `idempotency_conflict` in the standard error envelope.

Language primitives: cURL calls a precomputed signature helper; Node.js uses `crypto.createHmac`; Python uses `hmac.new`; PHP uses `hash_hmac`; Java uses `javax.crypto.Mac` and `MessageDigest.isEqual`; C# uses `HMACSHA256` and `CryptographicOperations.FixedTimeEquals`; Go uses `crypto/hmac` and `hmac.Equal`. In every language, verify timestamps before accepting a webhook and store the event ID before returning 2xx.
