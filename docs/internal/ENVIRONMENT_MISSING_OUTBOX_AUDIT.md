# `environment_missing` residual outbox audit

## Proven Restec evidence

- The supplied UUID `da6da150-2739-4da9-adc9-8ee7c4ed569f` is absent from Restec `pos_outbox_events` by both row ID and public event ID, absent from `webhook_delivery_attempts`, and absent from matching Restec audit rows.
- Private connection reference `10000000-0000-4000-8000-000000000201` maps to active Restec sandbox connection `con_sandbox_canonical` and location `loc_sandbox_demo`.
- Certified bill `CERT-msbkm85r-d17bef97` is a distinct Restec record: paid/matched, with one `payment.completed` inbox row and Restec outbox row `a131d5b1-1a39-4aba-8f7b-d17bff2d3948`, public event `evt_7c018eb04b6fed0befbb7449`, delivered once.
- The residual UUID is therefore not the certified run's canonical Restec event. It originated in the payment application's own integration outbox or another upstream audit store.
- Restec's receiver requires an explicit environment header. The current Restec POS dispatcher derives environment from the authorized connection and emits it in both the public event body and `X-Restec-Environment`.

## Evidence that remains unavailable

The payment application's certification diagnostics endpoint is reachable but returned 401 for all credentials available in this repository. The accessible deployment account lists the sandbox project but exposes no deployment for log inspection. No payment-application database or repository was modified. Without authorized diagnostics, the exact event type, aggregate/bill/payment/session identifiers, payload, producer code revision, and whether its row had a missing payload environment, missing delivery header input, or both cannot be proven.

The observed `failed_condition=environment_missing` is consistent with a historical outbox row that lacked the environment value needed to construct the delivery header. That is an inference, not a certified fact. Do not assign it a payment event type from proximity: batch claims are queue-wide, ordered by due/creation time, and do not filter to the newly certified session. An older eligible row can be claimed in the same dispatcher batch as a new delivered row.

## Safe archival/manual-review procedure

1. Pause replay for this one outbox row; do not pause unrelated delivered events.
2. Export immutable row, payload hash, headers/derived header inputs, attempts, connection, aggregate references, producer version, and timestamps to restricted audit storage.
3. Resolve environment from immutable connection ownership only; never infer it from a URL or a nearby event.
4. Compare the aggregate with Restec inbox/outbox and authoritative payment state.
5. If historical, non-financial, or superseded, mark it archived/manual-review with operator identity and reason. Never mark a financial record paid.
6. If it represents a missing financial notification, repair the producer invariant first, then replay the same logical event ID after dual review.
7. Confirm sandbox data cannot be routed to production before resuming the dispatcher.

Closure requires read-only access to the payment application's row and producer audit. Until then the exact root cause remains evidence-blocked and production readiness cannot be claimed.
