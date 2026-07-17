# Security

Production assumes HTTPS. Requests use environment-scoped API keys, exact-byte HMAC signatures, bounded timestamps, one-time request IDs, location authorization, payload limits, strict schemas, and durable idempotency. API keys are hashed; retrievable connector/webhook secrets use authenticated encryption and rotation overlap. Secrets, signatures, tokens, private identifiers, raw payment data, customer data, dependency responses, and stack details are redacted from logs and errors.

Outbound webhook enrollment resolves DNS and blocks localhost, loopback, RFC1918, link-local, metadata, and unsafe IPv6 destinations. Delivery uses HTTPS, manual redirect handling, bounded timeouts, leases, attempts, and retries. Production rate limits must use gateway or shared persistent state, keyed by credential, with stricter limits on credential management, tests, simulations, replays, and failed authentication.

RLS is enabled on all integration tables; browser roles have no direct financial/integration access. Service RPCs implement atomic mutations. Only verified server-to-server payment events may update payment truth. Customer/browser redirects never do so.
