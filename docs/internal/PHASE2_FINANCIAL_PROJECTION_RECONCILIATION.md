# Phase 2 financial projection reconciliation

`scripts/audit-financial-database-consistency.ts` is read-only by default. It checks completed reservation evidence, bill projection existence, duplicate reservation identities, duplicate outbox logical keys, negative `amount_due`, and unexplained paid-over-total states. It prints counts and problem classes only; it never repairs money state. A clean audit against a real database is required before certification.
