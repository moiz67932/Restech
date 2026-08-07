# Phase 6 webhook configuration source audit

## Finding

Webhook URL and secret information existed in two places:

1. `webhook_endpoints.url` and `webhook_endpoints.encrypted_signing_secret`.
2. `pos_connections.encrypted_configuration`, containing connector configuration including `webhook_url` and `webhook_secret` for existing provisioning and sandbox tooling.

Provisioning wrote both. The connector runtime read the encrypted connection configuration. Rotation tooling previously covered API credentials but did not provide a versioned webhook-secret lifecycle. This allowed silent drift.

## Phase 6 policy

`webhook_secret_versions` is the authoritative versioned secret source after the additive migration. `webhook_endpoints` remains a legacy compatibility record and is copied byte-for-byte into version 1. Existing connector configuration is not overwritten or normalized.

Outbox events bind to the active version when created. A retry does not select a newer secret based on wall-clock time.

If both sources are available but their safe fingerprints differ, operators must mark and investigate `webhook_configuration_conflict`; the migration does not overwrite either value and runtime must not silently choose by timestamp. Live fingerprint comparison is gated until a read-only database inventory is authorized.
