# Refunds and financial corrections

Restec v1 is receive-only for provider-authoritative financial corrections. POS partners do not have a refund, void, reversal, chargeback, or dispute-creation endpoint in v1.

## Refunds

Supported refund facts are authenticated provider refunds for supported hosted digital payments. A refund may be full or partial, and several partial refunds are allowed while their completed total is no greater than the original completed payment. Refunds use integer minor units and the original payment currency.

Each refund is a separate immutable fact linked to one original Restec payment. Restec does not edit the original payment amount or erase its historical `paid` event. The safe `correction_id` is stable across delivery retries; provider IDs are private.

The order receivable and payment settlement are separate projections. `amount_refunded` reports net payment correction; `amount_due` remains the order receivable and does not automatically reopen after a post-settlement refund. A refund does not reopen a table or create a new table generation.

## Events and retries

Restec sends one logical correction event through the durable outbox. Delivery may be retried, but the event ID is unchanged. A POS should deduplicate by event ID, correlate using the original Restec payment ID, and apply the correction to the original bill even if the bill/table is now closed or the physical table has been reused.

If the correction is ambiguous or requires review, retain the prior financial protection and wait for a later authoritative event/reconciliation result. Do not edit the database directly.

## Unsupported or provider-gated behavior

POS-originated refunds, cash refunds, physical-terminal refunds, voucher refunds, voids, reversals, chargeback creation, and dispute creation are not public v1 operations. Cash or terminal operators may complete their own external process, but Restec must not be told that money moved through an unsupported path as a completed correction until an approved provider/merchant authority contract exists.

Provider-originated void, reversal, chargeback, and dispute notifications require a certified event contract before Restec will project them. This is a capability gate, not a silent acceptance.
