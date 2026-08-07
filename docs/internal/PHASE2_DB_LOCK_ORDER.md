# Phase 2 database lock order

The intended financial order is bill mapping row, then its reservation/mutation rows, then immutable payment/session evidence and outbox evidence. The Phase 1 RPCs lock the bill with `SELECT ... FOR UPDATE` before calculating capacity. Outbox claims lock eligible outbox rows with `FOR UPDATE SKIP LOCKED` and update their lease in the same statement. A multi-connection PostgreSQL run is still required to certify this behavior.
