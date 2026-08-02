#!/usr/bin/env bash
set -euo pipefail

: "${RESTEC_BASE_URL:?required}"
: "${RESTEC_API_CREDENTIAL:?required}"
: "${RESTEC_REQUEST_SIGNING_SECRET:?required}"
: "${RESTEC_LOCATION_ID:?required}"

restec_request() {
  local method="$1" path="$2" body="${3-}" idempotency_key="${4-}" include_environment="${5-false}"
  local timestamp request_id input signature
  timestamp="$(date +%s)"
  request_id="req_$(openssl rand -hex 16)"
  input="${timestamp}.${method}.${path}.${body}"
  signature="v1=$(printf '%s' "$input" | openssl dgst -sha256 -hmac "$RESTEC_REQUEST_SIGNING_SECRET" -hex | sed 's/^.* //')"
  local headers=(-H "Authorization: Bearer ${RESTEC_API_CREDENTIAL}" -H "Content-Type: application/json" -H "X-Request-Id: ${request_id}" -H "X-Restec-Timestamp: ${timestamp}" -H "X-Restec-Signature: ${signature}")
  [[ -n "$idempotency_key" ]] && headers+=(-H "Idempotency-Key: ${idempotency_key}")
  [[ "$include_environment" == true ]] && headers+=(-H "X-Restec-Environment: sandbox")
  if [[ "$method" == GET ]]; then
    curl --fail-with-body --silent --show-error -X GET "${headers[@]}" "${RESTEC_BASE_URL}${path}"
  else
    curl --fail-with-body --silent --show-error -X "$method" "${headers[@]}" --data-binary "$body" "${RESTEC_BASE_URL}${path}"
  fi
}

external_bill_id="BILL-1001"
bill_path="/v1/locations/${RESTEC_LOCATION_ID}/bills/${external_bill_id}"
bill_v1='{"external_table_id":"TABLE-12","external_order_id":"ORDER-1001","version":1,"currency":"PKR","status":"open","order_status":"accepted","items":[{"external_item_id":"ITEM-1","name":"Lunch","quantity":1,"unit_amount":10000,"total_amount":10000,"notes":"No onions"}],"totals":{"subtotal":10000,"tax":0,"service_charge":0,"discount":0,"tip":0,"grand_total":10000},"occurred_at":"2026-08-02T10:00:00Z","metadata":{}}'
bill_v2="${bill_v1/\"version\":1/\"version\":2}"

# Authenticate while creating/updating a bill.
# restec_request PUT "$bill_path" "$bill_v1" "bill-${external_bill_id}-v1"
# restec_request PUT "$bill_path" "$bill_v2" "bill-${external_bill_id}-v2"

cash_bill_path="/v1/locations/${RESTEC_LOCATION_ID}/bills/BILL-CASH-1001"
terminal_bill_path="/v1/locations/${RESTEC_LOCATION_ID}/bills/BILL-TERMINAL-1001"
cash_bill="${bill_v1/ORDER-1001/ORDER-CASH-1001}"
terminal_bill="${bill_v1/ORDER-1001/ORDER-TERMINAL-1001}"
cash='{"external_payment_id":"CASH-1001","method":"cash","amount":10000,"currency":"PKR","status":"completed","occurred_at":"2026-08-02T10:05:00Z","metadata":{}}'
terminal='{"external_payment_id":"TERMINAL-1001","method":"card_terminal","amount":10000,"currency":"PKR","status":"completed","occurred_at":"2026-08-02T10:05:00Z","processor_reference":"APPROVAL-1001","metadata":{}}'
# restec_request PUT "$cash_bill_path" "$cash_bill" "bill-BILL-CASH-1001-v1"
# restec_request POST "${cash_bill_path}/external-payments" "$cash" "payment-CASH-1001"
# restec_request PUT "$terminal_bill_path" "$terminal_bill" "bill-BILL-TERMINAL-1001-v1"
# restec_request POST "${terminal_bill_path}/external-payments" "$terminal" "payment-TERMINAL-1001"

session='{"amount_minor":10000,"currency":"PKR","method":"card","return_context":{"pos_reference":"ORDER-1001"}}'
# restec_request POST "${bill_path}/payment-sessions" "$session" "session-${external_bill_id}-1" true
# restec_request GET "/v1/locations/${RESTEC_LOCATION_ID}/payment-sessions/rps_test_example" "" "" true

# Reconcile after an ambiguous response.
# restec_request GET "$bill_path"
