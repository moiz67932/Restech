# Phase 6 credential inventory

This is a metadata-only inventory. It intentionally contains no credential, signing secret, encrypted value, master key, or reversible secret material.

| Class                                | Source of truth                                                          | Runtime consumer                                       | Lifecycle support                                      | Safe validation status                                             |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| API bearer credential                | `api_keys`                                                               | `publicAuth` / `SupabaseRepository.authenticateApiKey` | issue, use, last-used, overlap, expiry, revoke, rotate | code-path verified; live row inventory gated                       |
| API request-signing secret           | `api_keys.encrypted_signing_secret`                                      | `publicAuth`                                           | encrypted storage, overlap, expiry, revoke, rotate     | decrypt-fail-closed path verified; live ciphertext inventory gated |
| Webhook secret v1 and later          | `webhook_secret_versions` after migration                                | outbox dispatcher                                      | active, grace, retired, revoked, event binding         | synthetic lifecycle verified; live row inventory gated             |
| Legacy webhook secret                | `webhook_endpoints.encrypted_signing_secret` and legacy connector config | transition fallback only                               | read-only compatibility during migration               | conflict audit required before fallback removal                    |
| Connector configuration              | `pos_connections.encrypted_configuration`                                | connector resolution and destination selection         | encrypted read, fail closed on decrypt error           | existing behavior preserved; live decrypt audit gated              |
| Inbound/private provider credentials | encrypted integration profile/configuration                              | private connector                                      | encrypted storage, no public exposure                  | metadata-only; provider UAT gated                                  |

## Required per-record metadata

For an operator-run inventory, record only: credential type, partner, location, environment, safe record ID, version, status, creation/expiry/grace/revocation/last-use timestamps, scope set, encrypted-secret-present flag, decrypt-success flag, and a truncated diagnostic SHA-256 fingerprint. Never record plaintext.

## Preservation result

No live credential inventory was mutated or normalized. `CURRENT_CREDENTIAL_PRESERVATION` is application-testable but live validation remains database/credential-access gated.
