# Paely Sandbox Certification

Normal tests use a local mock server. Real calls require approved sandbox credentials and `RUN_REAL_PAELY_SANDBOX_CERTIFICATION=true npm run certify:paely-sandbox`.

Certify all four private operations, exact signatures, stable idempotency, request-ID rotation, sanitized errors, private-ID removal, callback verification, atomic inbox/outbox, duplicates and POS-unavailable independence. Store request IDs and hashes, never secrets or raw private errors.
