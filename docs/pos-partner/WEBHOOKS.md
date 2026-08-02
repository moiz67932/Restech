# Webhooks

Restec sends a versioned JSON event to the environment-specific HTTPS callback registered during onboarding.

Required headers:

| Header                      | Meaning                                |
| --------------------------- | -------------------------------------- |
| `X-Restec-Event-Id`         | Stable event ID used for deduplication |
| `X-Restec-Timestamp`        | Unix seconds used in the signature     |
| `X-Restec-Signature`        | HMAC-SHA256 signature                  |
| `X-Restec-Environment`      | `sandbox` or `production`              |
| `X-Restec-Delivery-Attempt` | One-based delivery attempt             |

The JSON body contains `event_id`, `event_type`, `event_version`, `occurred_at`, `environment`, `partner_id`, `location_id`, `external_bill_id`, optional `payment_session_id`, `payment_reference`, `amount_minor`, `currency`, `payment_method`, `payment_status`, `bill`, and `metadata`.

Canonical signing input:

```text
${xRestecTimestamp}.${exactRawBody}
```

Compute HMAC-SHA256 using the webhook-signing secret for the header environment. Format the result as `v1=<lowercase-hex>` and compare in constant time. Reject timestamps outside five minutes and reject a body environment that differs from the header or callback environment.

Processing order:

1. Read and retain the exact raw body bytes.
2. Verify timestamp, environment, and signature.
3. Validate the v1 event schema.
4. In one durable transaction, insert `event_id` under a unique constraint and apply the POS update.
5. Return 200, 201, 202, or 204 only after that transaction commits.

If the unique insert reports an existing identical event, return a supported 2xx without applying another financial action. If the same event ID has different content, reject it and escalate.

Restec retries network failures and HTTP 408, 425, 429, 500, 502, 503, and 504. Other 4xx responses are permanent failures. Delays are 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours, then 12 hours capped. Exhausted events enter manual review.
