# Phase 2 migration-upgrade evidence

Status: **GATED — not executed without disposable PostgreSQL.**

The upgrade rehearsal must build through `20260802000100_pos_partner_credentials.sql`, seed historical unpaid, partial, paid, failed, expired, cancelled, refunded and partially-refunded sessions plus POS/inbox/outbox evidence, apply `20260807000100_financial_capacity_reservations.sql`, and compare immutable facts with the bill projection. Refunded sessions must be `completed` evidence, never active reservations.
