# curl examples

Restec has no login endpoint. Authentication is the issued bearer credential plus an HMAC signature on each request. `restec.sh` demonstrates authentication, bill create/update, customer payment-session create/status, cash and physical-terminal payments, safe retries, and reconciliation.

Set these partner-side values in your shell secret store, then source the script:

```bash
export RESTEC_BASE_URL="https://sandbox-api.restec.example" # Replace with the activated URL from Restec.
export RESTEC_API_CREDENTIAL="REPLACE_WITH_ISSUED_VALUE"
export RESTEC_REQUEST_SIGNING_SECRET="REPLACE_WITH_ISSUED_VALUE"
export RESTEC_LOCATION_ID="loc_example"
source ./restec.sh
```

The helper generates a fresh request ID/signature for each attempt. Pass the same idempotency key and exact body to retry a mutation. Inspect `application/problem+json`: reconcile on 409, correct fields on 422, and honor `Retry-After` on 429.
