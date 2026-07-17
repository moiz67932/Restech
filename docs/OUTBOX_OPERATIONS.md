# POS Outbox Operations

Claims use `FOR UPDATE SKIP LOCKED` and expiring leases. Attempts store only status, outcome, code and duration. 200/201/202/204 succeed. Network errors, timeout, 408, 425, 429, 500, 502, 503 and 504 retry; permanent failures and exhausted retries dead-letter. Manual replay retains the event ID and history and requires authenticated, audited administration. Response bodies are not stored.
