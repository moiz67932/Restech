# Idempotency and retries

Every PUT and POST requires an `Idempotency-Key` of 1 to 200 characters. Scope keys to one business action, for example a bill ID plus revision or an external payment ID. Keep the key and exact JSON bytes unchanged across retries.

Every HTTP attempt also needs a new `X-Request-Id`, current timestamp, and newly computed signature. Reusing a request ID is rejected as replay even when the idempotency key is correct.

Safe retry guidance:

- Retry connection failures, timeouts, 429, 502, 503, and 504.
- Retry a mutation only with the same idempotency key and exact body.
- Honor `Retry-After` when present.
- Otherwise use exponential backoff with jitter: about 1, 2, 4, 8, 16, 30, then 60 seconds.
- Stop automatic API retries after 15 minutes and reconcile with a GET before operator review.
- Do not retry 400, 401, 403, 404, 409, 413, or 422 without correcting the cause. A 409 marked retryable may be retried after a short delay with the same body and key.

A duplicate identical mutation returns the original status and response. A reused key with a different method, path, or body returns `idempotency_conflict`. Bill versions add a second invariant: same version plus same bytes is safe; same version plus different bytes is `bill_version_conflict`.

Webhook retry timing and permanent-failure rules are in `WEBHOOKS.md`. The POS must deduplicate webhooks even if Restec has already recorded an earlier 2xx, because network acknowledgement can be lost.
