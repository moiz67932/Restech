# Phase 2 transaction isolation analysis

The repository invokes security-definer PostgreSQL functions through Supabase RPC. Each function is one database statement/transaction from the client boundary; bill capacity functions explicitly lock the bill row before reading or inserting reservations. The effective PostgreSQL isolation level and rollback/crash-window behavior remain execution-gated in this worktree and must be recorded from a disposable database run.
