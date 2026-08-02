# API reference

The OpenAPI 3.1 file is authoritative for field constraints. All monetary values are integer minor units. Unknown JSON properties are rejected.

| Method | Path                                                                     | Scope                    | Idempotent success | Purpose                                   |
| ------ | ------------------------------------------------------------------------ | ------------------------ | ------------------ | ----------------------------------------- |
| GET    | `/health`                                                                | None                     | 200                | Restec service health                     |
| PUT    | `/v1/locations/{location_id}/bills/{external_bill_id}`                   | `bills:write`            | 200                | Create or update a bill                   |
| GET    | `/v1/locations/{location_id}/bills/{external_bill_id}`                   | `bills:read`             | 200                | Retrieve current bill/payment state       |
| POST   | `/v1/locations/{location_id}/bills/{external_bill_id}/external-payments` | `payments:write`         | 200                | Report a completed POS-originated payment |
| POST   | `/v1/locations/{location_id}/bills/{external_bill_id}/payment-sessions`  | `payment_sessions:write` | 201                | Create a customer payment session         |
| GET    | `/v1/locations/{location_id}/payment-sessions/{payment_session_id}`      | `payment_sessions:read`  | 200                | Retrieve customer payment status          |
| GET    | `/v1/locations/{location_id}/tables`                                     | `tables:read`            | 200                | List authorized table mappings            |

## Bill input

Required: `external_table_id`, positive integer `version`, three-letter uppercase `currency`, `status`, at least one `items` entry, `totals`, and ISO-8601 `occurred_at`. `order_status` defaults to `accepted`; `metadata` defaults to `{}`. Item quantity is an integer. Each item total must equal unit amount times quantity, and the grand total must equal subtotal plus tax, service charge and tip minus discount.

## Traditional payment input

Required: `external_payment_id`, `method`, positive `amount`, `currency`, `status: completed`, and `occurred_at`. Methods are `cash`, `card_terminal`, `wallet_terminal`, `voucher`, and `other`.

## Payment-session input

Required: positive `amount_minor`, `currency: PKR`, and `method: card`. Optional customer fields are email and mobile. Never include card number, security code, expiry, PIN, OTP, or track data.

## Responses

Successful state responses contain only Restec public identifiers and POS identifiers. Restec API operations return 200 or 201 as listed above; a POS webhook receiver may acknowledge with 200, 201, 202, or 204. Error outcomes include 400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, and 504 where documented in OpenAPI. See `ERRORS.md` for retry classification.
