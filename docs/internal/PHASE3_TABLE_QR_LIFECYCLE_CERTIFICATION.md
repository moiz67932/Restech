# Phase 3 table QR lifecycle certification

Verdict: `RESTEC_PHASE3_TABLE_QR_PARTIAL`

The implementation adds opaque permanent table QR provisioning, environment-bound token hashes, a current table-session generation, and separately issued customer-visit capabilities. A customer visit resolves only its original generation. Open bills bind a table; ordinary updates retain binding; moves supersede the old binding; completed/cancelled bills end it; a new bill creates a new generation. A stale terminal bill cannot reopen and reclaim the table. Merge and split are unsupported in v1.

Local test evidence: 500 sequential table generations passed; an old visit after reuse reported ended and did not render the new bill; competing active bills were rejected. `CROSS_GUEST_EXPOSURES = 0`.

The migration supplies partial unique indexes for one active table/bill and a SQL lifecycle function. It was structurally checked but not executed on real PostgreSQL/Supabase. Therefore `DATABASE_EXECUTION_GATED` remains, as does Phase 2's database-partial verdict. Payment and financial code was not changed; local Phase 1 regression suite passed.

Public partner OpenAPI and Postman did not change because QR provisioning is operator-only and POS bill operations are unchanged. The documentation portal now exposes the partner table/QR guide.

Remaining blockers: real PostgreSQL migration/RPC race certification, live table-provisioning operational validation, product approval for terminal visit retention and merge/split, plus existing Phase 2 and real-provider/POS gates.
