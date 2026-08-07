# Phase 3 cross-guest privacy certification

Local MemoryRepository certification exercised 500 sequential table generations, retained an old customer visit, closed Bill A, opened Bill B, and refreshed the old visit. The old visit returned `session_ended`; it never rendered Bill B. A new permanent-QR scan created a new visit and rendered only Bill B.

- Cross-location/environment: token hashes are environment-bound; mismatched environment returns `invalid_link`.
- Rotation/disable: schema and resolver fail closed; PostgreSQL execution is gated.
- Cache: QR and visit pages set `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
- Internal identifier leakage: focused response test uses only safe table/bill projection.

`CROSS_GUEST_EXPOSURES = 0`

This is local source/mock evidence only. PostgreSQL/Supabase concurrency certification is `DATABASE_EXECUTION_GATED`.
