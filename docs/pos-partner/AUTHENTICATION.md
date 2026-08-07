# Authentication

Restec issues a distinct API credential and request-signing secret for each environment. A credential identifies one partner, grants explicit operation scopes, and is limited to named Restec location IDs. Production and sandbox values are not interchangeable.

Required headers on partner API requests:

| Header                 | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `Authorization`        | `Bearer <Restec API credential>`                                |
| `Content-Type`         | `application/json`                                              |
| `X-Request-Id`         | A new `req_` identifier for this HTTP attempt                   |
| `X-Restec-Timestamp`   | Current Unix time in seconds                                    |
| `X-Restec-Signature`   | `v1=` plus lowercase HMAC-SHA256 hex                            |
| `Idempotency-Key`      | Required for PUT and POST; reuse only for the same logical body |
| `X-Restec-Environment` | Required on payment-session create and status requests          |

Canonical signing input:

```text
${timestamp}.${method.toUpperCase()}.${url.pathname}.${exactRawBody}
```

The path begins with `/` and excludes scheme, host, query string, and fragment. Sign the exact UTF-8 bytes sent on the wire. For GET, the body portion is empty but the final period remains. Requests normally have a five-minute timestamp tolerance.

Never reuse `X-Request-Id`, even when retrying. Keep the same `Idempotency-Key` and exact body for a mutation retry, but generate a new timestamp, request ID, and signature.

Restec records credential last use. Expired or revoked credentials return 401. During an approved rotation grace window, both versions may work; after that window, the prior version returns 401. A location outside the credential scope returns 403 without revealing the object.

Credential rotation is additive: Restec issues the new environment-specific credential first and retains the prior credential only for the documented grace interval. The partner must install the new credential and signing secret before grace ends. Existing partner, location, environment, and scope assignments are preserved during ordinary rotation.
