# cURL

```bash
BASE_URL=https://sandbox-api.restec.io
PATH_VALUE=/v1/locations/loc_example/bills/INV-1001
TIMESTAMP=$(date +%s)
REQUEST_ID=req_$(openssl rand -hex 16)
BODY='{"external_table_id":"12","version":1,"currency":"PKR","status":"open","order_status":"accepted","items":[{"external_item_id":"I1","name":"Meal","quantity":1,"unit_amount":10000,"total_amount":10000}],"totals":{"subtotal":10000,"tax":0,"service_charge":0,"discount":0,"tip":0,"grand_total":10000},"occurred_at":"2026-07-18T10:30:00Z","metadata":{}}'
SIGNATURE=v1=$(printf '%s' "$TIMESTAMP.PUT.$PATH_VALUE.$BODY" | openssl dgst -sha256 -hmac "$REQUEST_SIGNING_SECRET" -hex | sed 's/^.* //')
curl --fail-with-body -X PUT "$BASE_URL$PATH_VALUE" \
  -H "Authorization: Bearer $RESTEC_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Restec-Timestamp: $TIMESTAMP" \
  -H "X-Restec-Signature: $SIGNATURE" \
  -H "X-Request-Id: $REQUEST_ID" \
  -H "Idempotency-Key: bill-INV-1001-v1" \
  --data-binary "$BODY"
```

For a webhook, capture the exact body to a file before parsing, reject timestamps outside five minutes, compute `openssl dgst -sha256 -hmac "$WEBHOOK_SIGNING_SECRET"` over `timestamp + "." + body`, and compare through an application primitive that is constant-time. Insert `X-Restec-Event-Id` into a database unique column in the same transaction as the invoice update; acknowledge an already-present ID with 2xx. Treat `408`, `425`, `429`, and documented 5xx statuses as retryable; inspect the JSON error code for all other failures.
