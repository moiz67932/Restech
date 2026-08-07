# Phase 2 migration rollback and recovery procedure

Never destructively roll back financial evidence. The supported boundary is:

1. Stop financial writes and workers.
2. If migration execution fails before commit, let the transaction roll back and verify the schema has no partial Phase 2 objects.
3. If application deployment fails after migration commit, roll the application forward/back only across the documented compatibility boundary; preserve reservation, payment, inbox, outbox and audit rows.
4. If old application code must run, disable Phase 2 routes until a compatibility review confirms its SQL assumptions.
5. Prefer restoring a disposable database snapshot into a disposable environment, then replaying a forward-fix migration.

Example local commands (no credentials):

```text
npm run db:start
npm run db:lint
npm run db:test:reset
npm run test:database:certify
```

Destructive reset is guarded by `RESTEC_DATABASE_CERTIFICATION=true`, `RESTEC_DATABASE_TARGET=disposable-local`, `RESTEC_ENV=test|sandbox`, `RESTEC_ALLOW_DATABASE_RESET=true`, and absence of remote database URLs.
