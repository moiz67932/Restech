# Customer payment synchronization

Create a customer payment session only for an existing payable bill whose Restec reconciliation state is `matched`. The requested currency must match the bill and the amount must fit Restec's currently available payment capacity. `amount_due` is the economic unpaid balance; an active payment in another channel can temporarily make less capacity available.

Restec permits one active customer payment session per bill. Creating it protects its full amount before checkout is created. Cash and terminal payments may settle a different, unprotected remainder, but cannot consume the session's protected amount. A verified failure, cancellation, or expiry releases the session amount; browser navigation alone does not.

The create response contains a public `payment_session_id`, a Restec `checkout_url`, amount, currency, method, expiry, and status. Redirect the customer to that URL. The POS must not collect or forward cardholder data.

Session states are `requires_customer_action`, `processing`, `paid`, `failed`, `expired`, `cancelled`, `refunded`, and `partially_refunded`. A redirect or browser return is not payment proof. Poll the status endpoint only when the POS needs reconciliation; Restec also sends a signed event.

The `expires_at` value is a customer-action deadline, not by itself proof that the provider can no longer complete payment. After that time Restec blocks a new checkout redirect, while its scheduler queries the private provider state. Capacity is released only when the provider reports `failed`, `cancelled`, or `expired`; an active or unavailable provider result retains the reservation. The customer browser is never required for this process.

Restec applies terminal states monotonically. A committed paid result is not reverted by a retry or a late non-authoritative request. Duplicate authoritative events do not create another POS notification.

If session creation returns `payment_outcome_ambiguous`, do not create a replacement payment. Retry only the identical request with the same idempotency key and reconcile the public session/bill state.

For final POS state:

- Close the bill only when `bill.payment_status` is `paid` and `bill.amount_due` is zero.
- Retain `external_bill_id`, `payment_session_id`, `payment_reference`, and `event_id` for reconciliation.
- Treat refund events as authoritative state notifications. v1 does not offer a POS endpoint to initiate a refund.
