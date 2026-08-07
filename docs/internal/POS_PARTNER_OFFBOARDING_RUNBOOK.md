# POS partner offboarding runbook

Offboarding is staged: request → stop new work → drain existing financial and POS delivery work → consistency audit → quarantine unresolved/ambiguous work → revoke only the scoped credentials → disposition webhooks → archive lifecycle records.

Active or ambiguous payment sessions, pending refunds/corrections, and financial dead letters block final completion. Existing financial evidence and event history are retained. A one-location or sandbox offboarding operation must not alter another location or production.

Rollback is performed by restoring the staged lifecycle state before final revoke; final revoke itself is not a deletion operation. Use synthetic credentials in tests and rerun the Phase 6 preservation audit afterward.
