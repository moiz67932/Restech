# Current recovery flow

`compare_provider_state` authenticates the mapped provider read, compares the seven bill fields, and records a deduplicated `bill_projection_drift` case when they differ. It does not overwrite financial truth.

Payment-session reconciliation reads provider state and validates session identity, amount, currency, and bill constraints. Verified terminal states are submitted to `acceptPaymentSessionEvent`, which preserves Phase 1 reservation and inbox/outbox idempotency. Active provider state after a local deadline retains capacity. Late success capacity conflicts remain manual review.

`mark_manual_review` now creates a durable manual-review case and an audit record. `requeue_pos_event` replays the existing outbox row and therefore retains its event identity and attempt history. Provider paid/local processing, provider failed/local processing, and provider expired/local active are never resolved by guessing.
