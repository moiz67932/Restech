# Certification Plan

Certification gates are: contract/schema conformance; exact-byte signing; environment and access isolation; idempotency and concurrency; bill and external-payment state transitions; durable event acceptance; retry/dead-letter/replay; unsafe destination blocking; sandbox scenario coverage; reconciliation; log/content leakage; portal role checks; and migration/rollback rehearsal.

Evidence must include command output, fixture hashes, event IDs, delivery attempts, audit entries, and explicit approval for production credentials. A connector is certified for a specific version and configuration only. Any schema, authentication, retry, or financial mapping change requires targeted recertification.
