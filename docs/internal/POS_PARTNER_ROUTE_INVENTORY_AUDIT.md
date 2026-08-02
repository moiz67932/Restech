# POS partner route inventory audit

Audited against `apps/api/src/app.ts`, authentication middleware, contracts, repositories, migrations, and tests on commit `72382fe` plus the POS partner v1 working-tree changes.

## Partner-suitable routes

| Method/path                                                              | Purpose                         | Auth and headers                                                                                | Schema                        | Success/errors                                       | Idempotency/retry                                | Boundary                       | Source       |
| ------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------- | ------------------------------------------------ | ------------------------------ | ------------ |
| `GET /health`                                                            | Liveness/version                | None                                                                                            | No body                       | 200                                                  | Safe GET retry                                   | Public, not tenant data        | `app.ts:119` |
| `PUT /v1/locations/:locationId/bills/:externalBillId`                    | Full bill upsert                | Bearer, JSON, request ID, timestamp, HMAC, idempotency key; `bills:write` and location scope    | `billSchema`                  | 200; 400/401/403/404/409/413/422/429/500/502/503/504 | Stable key/body; bill version replay/conflict    | Partner and location           | `app.ts:180` |
| `GET /v1/locations/:locationId/bills/:externalBillId`                    | Bill/payment projection         | Bearer, JSON, request ID, timestamp, HMAC; `bills:read` and location scope                      | Empty body                    | 200; 400/401/403/404/409/429/500/503                 | Safe GET retry with new request ID               | Partner and location           | `app.ts:217` |
| `POST /v1/locations/:locationId/bills/:externalBillId/external-payments` | Completed cash/terminal fact    | Bearer, JSON, request ID, timestamp, HMAC, idempotency key; `payments:write` and location scope | `externalPaymentSchema`       | 200; 400/401/403/404/409/413/422/429/500/502/503/504 | Stable key/body and external payment ID          | Partner, location, bill        | `app.ts:223` |
| `POST /v1/locations/:locationId/bills/:externalBillId/payment-sessions`  | Customer hosted-payment session | Above plus environment header; `payment_sessions:write`                                         | `paymentSessionRequestSchema` | 201; 400/401/403/404/409/413/422/429/500/502/503/504 | Deterministic public session ID; stable key/body | Partner, location, bill        | `app.ts:274` |
| `GET /v1/locations/:locationId/payment-sessions/:paymentSessionId`       | Payment status                  | Bearer, JSON, request ID, timestamp, HMAC, environment; `payment_sessions:read`                 | Public session ID             | 200; 400/401/403/404/409/429/500/503                 | Safe GET retry                                   | Partner, location, environment | `app.ts:424` |
| `GET /v1/locations/:locationId/tables`                                   | Table mappings                  | Bearer, JSON, request ID, timestamp, HMAC; `tables:read`                                        | Empty body                    | 200; 400/401/403/409/429/500/503                     | Safe GET retry                                   | Partner and location           | `app.ts:449` |

Authentication is applied at `app.ts:123` and `auth.ts:13`. Object/scope authorization begins at `app.ts:124`; common idempotency begins at `app.ts:136`.

## Publicly reachable but not POS partner API

| Route class                                        | Purpose                                                       | Classification                                       |
| -------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `/s/:paymentSessionId` and its return/cancel pages | Customer browser flow using a public opaque session reference | Customer-only; excluded from OpenAPI                 |
| `/v1/test/scenarios`                               | Sandbox scenario injection                                    | Test-only; excluded from OpenAPI and partner package |
| `/api/test/mock-pos-webhook`                       | Sandbox mock receiver                                         | Test-only; excluded                                  |

## Protected non-public routes

The event receiver, evidence endpoints, dispatcher, and reconciliation jobs under `/api/internal/` require service/job authentication or return a non-revealing 404. They are not part of the POS partner contract and are excluded from OpenAPI, Postman, examples, and partner documents.
