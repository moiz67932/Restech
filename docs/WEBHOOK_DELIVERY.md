# Webhook Delivery

Each logical event keeps one `evt_` identifier across every attempt. Restec signs `timestamp + "." + exact_json_body` and sends the event ID, timestamp, signature, and attempt number. Receivers verify exact bytes, enforce a clock window, and durably deduplicate before returning 2xx.

Statuses 200, 201, 202, and 204 succeed. Network errors, timeouts, 408, 425, 429, 500, 502, 503, and 504 retry on a bounded schedule. Other 4xx outcomes are permanent. Exhausted delivery becomes dead-lettered; controlled replay keeps the same event ID and is audited. Response bodies are never stored.
