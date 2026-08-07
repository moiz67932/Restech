# Phase 6 security and credential policy decisions

## Rotation model

Webhook delivery uses stable event-bound secret versions. New outbox events bind to the single active version; retries retain their original version. Normal rotation changes the prior version to `grace` and adds a new `active` version. Grace is operator-configurable from 0 through 604800 seconds and defaults to 86400 seconds in the operator script.

API credential rotation retains the prior credential in overlap until its explicit grace deadline. Scope and location preservation must be validated before production use.

## Emergency revoke

Revocation is explicit, version-specific, audited, and never implicit in ordinary rotation. Queued events bound to a revoked secret fail closed rather than being silently dropped or silently re-signed. A separate, audited re-sign migration is required for compromised-secret recovery.

## Security boundaries

- IP allowlists are metadata and validation support; production enforcement remains deployment/UAT gated.
- mTLS subject metadata is retained, but certificate enforcement is infrastructure gated.
- Trusted proxy identity must come only from an approved deployment proxy; untrusted forwarding headers are not authoritative.
- Production rate limiting requires a shared adapter and fails closed when unavailable.
- Callback URLs require HTTPS in production and reject private, link-local, loopback, metadata, credential-bearing, and unsafe DNS answers. Redirects are not followed.
- The existing encryption key remains in place. No master-key rotation is part of Phase 6.
- Operator tooling displays a newly issued webhook secret once and never reads it back.
