# Paely Private Compatibility

This internal-only document records alignment with the authoritative private contract in `reference/paely/paely-restec-private-api.yaml`. Requests sign `timestamp.METHOD.path.exact_raw_body`, keep the private idempotency key across safe transient retries, create a new request ID per network attempt, and never forward private response identifiers or raw errors into public output. The inbound event signature covers `timestamp.exact_raw_body`; acceptance occurs only after the inbox and POS outbox commit.
