# Traditional payment synchronization

After the POS has authoritative proof that a cash, physical-terminal, wallet-terminal, voucher, or approved other payment completed, report it to:

```text
POST /v1/locations/{location_id}/bills/{external_bill_id}/external-payments
```

The request requires an external payment ID, method, positive amount, matching currency, `status: completed`, occurrence time, and an idempotency key. The external payment ID must be stable and unique within its location connection.

Restec validates location access, bill existence, amount, currency, bill state, and duplicate identity before committing the result through the payment domain. It persists an audit event and updates the customer-facing bill projection. It never accepts cardholder data.

An amount up to the current `amount_due` is supported. A smaller amount produces a partial balance; a later distinct completed payment may settle the remainder. Overpayment is rejected. A payment cannot be reported while the bill is in `payment_in_progress`, and a fully paid bill rejects another financial result.

An identical retry with the same idempotency key returns the original response. Reusing the key or external payment ID with different content returns 409. After a timeout, retry with identical bytes and the same idempotency key, then reconcile with the bill GET endpoint.

This endpoint records completed facts only. Pending, declined, voided, cancelled, reversed, and refunded POS-originated payment reports are unsupported in v1.
