# Troubleshooting

Start with the HTTP status, top-level `code`, `request_id`, location ID, external bill ID, idempotency key identifier, and timestamp. Never send secrets in a support ticket.

| Symptom                   | Check                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| 401                       | Credential environment/expiry/revocation, clock drift, exact path/body signature input            |
| 403                       | Operation scope and Restec location scope                                                         |
| 404                       | Environment, public ID spelling, bill/session existence                                           |
| 409 on retry              | Same key, method, path, and exact bytes; bill revision ordering                                   |
| 422                       | Integer amounts, currency, line totals, grand total, supported enum                               |
| 429                       | Pause for `Retry-After`; reduce concurrency for that credential/location                          |
| 502/503 or timeout        | Retry safely with the same idempotency key, then GET bill/session state                           |
| Webhook signature failure | Exact raw bytes, header timestamp, environment secret, lowercase HMAC hex                         |
| Duplicate webhook         | Unique constraint on `event_id`; return 2xx for identical content                                 |
| POS and Restec differ     | Stop new payment attempts for the bill and reconcile public IDs, amount, currency, and timestamps |

Escalate with sanitized request/event evidence when a retry window expires, an event has conflicting content, or financial states differ. Do not force a paid/unpaid value as a repair.
