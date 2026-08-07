# Current correction flow

Before Phase 5, provider refund events were accepted through the private webhook and projected by merging the provider-supplied bill state. The event was deduplicated by private event ID, but there was no separate correction identity, no correction ledger, and no protection against two technical event IDs representing one economic refund.

Phase 5 flow:

1. Authenticate the signed provider event and verify environment, connection, location, bill, currency, and payment-session references.
2. Convert a refund event into a safe Restec correction identity. The public payload contains a Restec correction ID and original Restec payment ID; raw provider correction identifiers are not exposed.
3. Insert one immutable correction keyed by logical identity. Duplicate provider deliveries and duplicate technical IDs are no-ops.
4. Accept only a completed refund whose aggregate completed refunds do not exceed the original completed payment. Over-refund-like provider truth is recorded as `review_required` and does not silently alter the projection.
5. Derive `amount_refunded` from correction facts. The original payment amount and `paid` history are not rewritten.
6. Emit one durable POS event ID; delivery retries reuse that ID.

Void, reversal, chargeback, and dispute events are not claimed as implemented because the current provider contract does not expose certified semantics for them.
