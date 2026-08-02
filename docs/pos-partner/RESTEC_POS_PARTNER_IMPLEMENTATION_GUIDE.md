# Restec POS Partner v1 implementation guide

This compiled handoff follows the modular guides in this directory and the
public contract in openapi/restec-pos-partner-v1.yaml.

## Integration path

Use environment-specific credentials and a Restec location ID. Sign
timestamp.METHOD.path.exact_raw_body, send a new request ID per attempt,
and use a stable idempotency key for each mutation body.

## Bills, tables, and customer payments

List authorized tables, then create each bill with a new external bill ID at version 1. Send complete higher-version snapshots when the bill changes.
Create a hosted payment session for customer card entry and open only the
returned Restec checkout URL. Confirm completion through a verified webhook or
the signed payment-session status endpoint.

The current v1 contract validates table mappings but does not certify a
permanent table/customer QR resolver or reassignment lifecycle. Do not
construct customer links from identifiers or reuse a terminal bill ID.

## Cash and terminal payments

Report only completed cash, card-terminal, wallet-terminal, voucher, or
approved other payments to the external-payments endpoint. Never send
cardholder data. Retry an ambiguous mutation with the same key and bytes, then
reconcile through the bill GET endpoint.

## Webhooks and reconciliation

Read exact raw bytes, verify timestamp, environment, and HMAC in constant time,
validate the schema, insert the event ID under a unique constraint, and apply
the POS update in one durable transaction before returning 2xx. Identical
duplicates are successful no-ops; conflicting duplicates require escalation.

## UAT, go-live, and unsupported operations

Complete every case in UAT_TEST_PLAN.md, retain sanitized request/event
evidence, then follow GO_LIVE_CHECKLIST.md. POS-initiated refund, void, and
reversal operations are unsupported in v1; authoritative refund notifications
may still be delivered.

For exact fields, responses, examples, and error codes, use the canonical
OpenAPI file and the linked modular guides rather than editing this summary.
