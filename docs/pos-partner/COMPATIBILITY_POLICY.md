# Compatibility policy

The URL major version defines the compatibility boundary. Restec keeps existing required fields, enum meanings, signing input, identifier meaning, and successful idempotent behavior compatible within `/v1`.

Restec may add optional response fields, new problem codes, new webhook event types, or new enum values only with advance notice appropriate to impact. Partners must ignore unknown optional response fields but must not silently accept unknown financial event types or states.

Breaking changes require a new major path, migration guide, sandbox overlap period, and separately scheduled production cutover. A field will not become required, change units, or change meaning within v1.

Webhook `event_version` governs the external event envelope. The same logical event keeps its `event_id`, body, and version across retries.

Security fixes may tighten invalid-input rejection without a major version when valid documented requests are unaffected. Deprecated compatibility fields remain documented for at least one announced transition window.
