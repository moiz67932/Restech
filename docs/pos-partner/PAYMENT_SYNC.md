# Customer payment synchronization

Create a customer payment session only for an existing payable bill whose Restec reconciliation state is `matched`. The requested currency must match the bill and the amount must not exceed `amount_due`.

The create response contains a public `payment_session_id`, a Restec `checkout_url`, amount, currency, method, expiry, and status. Redirect the customer to that URL. The POS must not collect or forward cardholder data.

Session states are `requires_customer_action`, `processing`, `paid`, `failed`, `expired`, `cancelled`, `refunded`, and `partially_refunded`. A redirect or browser return is not payment proof. Poll the status endpoint only when the POS needs reconciliation; Restec also sends a signed event.

Restec applies terminal states monotonically. A committed paid result is not reverted by a retry or a late non-authoritative request. Duplicate authoritative events do not create another POS notification.

For final POS state:

- Close the bill only when `bill.payment_status` is `paid` and `bill.amount_due` is zero.
- Retain `external_bill_id`, `payment_session_id`, `payment_reference`, and `event_id` for reconciliation.
- Treat refund events as authoritative state notifications. v1 does not offer a POS endpoint to initiate a refund.
