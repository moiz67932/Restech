# Connector Development Guide

A connector is the sole adapter between a vendor payload or delivery API and Restec canonical contracts. Authentication, vendor schema parsing, normalization, outbound serialization, delivery configuration, and health checks belong in the connector. Authorization, public IDs, idempotency, financial state, durable events, retry policy, audit, and reconciliation belong in the core.

Register a connector by implementing `PosConnector`, validating all configuration and outputs, and adding its version to the registry. `verifyInboundRequest` authenticates the vendor request; `normalizeBill` and `normalizeExternalPayment` return strict canonical values; `serializeEvent` creates the vendor payload; and `deliverEvent` returns delivered, retry, or permanent failure without hiding response classification. Secrets are encrypted at rest and injected server-side.

Tests must cover authentication failures, malformed/unknown fields, translation fixtures, output validation, timeouts, retry/permanent statuses, secret redaction, SSRF controls, and version mismatch. Certification includes sandbox concurrency, duplicate, delayed, out-of-order, and replay cases plus production smoke approval. Upgrades use a new explicit connector version and a controlled connection migration.

Never put private platform identifiers, raw payment credentials, generic core financial logic, unbounded logging, invented vendor fields, or direct database access inside a connector. Generate an empty skeleton with `npm run create:connector -- vendor-name`, then add `index.ts`, `types.ts`, `schemas.ts`, `authentication.ts`, `translator.ts`, `delivery.ts`, `fixtures/`, `tests/`, and `README.md` only from verified vendor documentation.
