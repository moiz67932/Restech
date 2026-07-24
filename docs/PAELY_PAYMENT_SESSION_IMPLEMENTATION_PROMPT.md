# Ready-to-Paste Paely Codex Prompt

Work only in the Paely repository. Do not modify Restec. Implement the private Restec payment-session contract in Restec's `docs/PAELY_PAYMENT_SESSION_PRIVATE_CONTRACT.md`.

Add:

1. `POST /api/internal/integrations/restec/v1/locations/{privateLocationId}/bills/{externalBillId}/payment-sessions`.
2. `GET /api/internal/integrations/restec/v1/payment-sessions/{privatePaymentSessionId}`.
3. Exact raw-body HMAC authentication using the existing bearer/service/environment/timestamp/signature/request-ID conventions.
4. Durable idempotency: same key and canonical input returns the same canonical payment and hosted session; same key/different input returns 409; a timeout after commit cannot create a second charge.
5. Bill/location/connection/environment/amount/currency validation.
6. Real Safepay sandbox hosted-checkout creation inside Paely, using Paely's existing regulated-provider integration. Return its HTTPS checkout URL only to Restec's private client.
7. Provider webhook verification and canonical payment/order update.
8. Durable outbox events for `payment.completed`, `payment.failed`, `payment.expired`, `payment.refunded`, and `payment.partially_refunded`.
9. Include `payment_session.private_payment_session_id`, `payment_session.restec_payment_session_reference`, and authoritative status in the signed Restec event, plus the existing bill/payment projections.
10. Retry/deduplicate events without changing event IDs.

Never accept card data on these endpoints, expose credentials or settlement data, trust browser return/cancel as payment proof, or call Restec public endpoints as a shortcut. Add migrations, repository implementations, mock integration tests, concurrency/timeout tests, webhook tests, and sanitized error tests. Deploy only to Paely sandbox after review; report the exact deployed route availability and the exact hosted-checkout hostname without sharing URL tokens or secrets.
