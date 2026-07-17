# Reconciliation

The service compares bill version, total, currency, paid, refunded, due and payment status. Results are `matched`, `pending`, `mismatch` or `review_required`; it never rewrites financial facts. A protected route supports comparison and manual-review marking, and service logic supports audited outbox requeue. Batch scheduling remains an operational responsibility.
