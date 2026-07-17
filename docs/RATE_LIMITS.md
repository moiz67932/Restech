# Rate Limits

Limits are configurable and enforced per API credential using shared gateway or persistent state. Responses use HTTP 429 with `Retry-After`. Credential changes, webhook tests, sandbox scenarios, manual replay, and authentication failures receive stricter budgets. Final numeric limits require operational approval and load-test evidence.
