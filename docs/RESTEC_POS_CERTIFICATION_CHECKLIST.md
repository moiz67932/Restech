# Restec POS Certification Checklist

Record evidence, time, build version, tester, and result for every item.

- [ ] Sandbox and production credentials are isolated.
- [ ] Valid authentication and exact-byte request signing succeed.
- [ ] Invalid, modified, expired, and future signatures fail.
- [ ] Bill creation starts at version 1 and updates increment versions.
- [ ] Same-version replay is safe; conflicting and stale versions fail.
- [ ] Cash and each supported terminal method update the correct bill.
- [ ] Partial payment preserves a positive amount due.
- [ ] Full payment closes only the correct invoice and only at zero amount due.
- [ ] Hosted payment creation returns `requires_customer_action` and a Restec-origin checkout URL.
- [ ] Hosted payment status is not marked paid by browser return or client input.
- [ ] PAN, CVV, expiry, PIN, OTP, track data, and provider credentials are rejected.
- [ ] Checkout redirect accepts only an approved exact HTTPS host and rejects IP, local, credential-bearing, HTTP, and unlisted destinations.
- [ ] A duplicate/idempotent payment-session request creates only one private payment.
- [ ] A customer cancellation followed by an authoritative completed event finishes as paid.
- [ ] Payment-session create, status, and browser routes return 404 when disabled.
- [ ] Webhook signature and timestamp are verified before parsing.
- [ ] Event IDs have a database unique constraint and duplicates are acknowledged safely.
- [ ] The POS responds only after durable event acceptance.
- [ ] `429`, `500`, and timeout responses produce a retry with the same event ID.
- [ ] A permanent invalid delivery becomes visible as dead-letter evidence.
- [ ] Reconciliation after downtime restores the correct invoice state.
- [ ] No cardholder authentication data or raw payment credentials are exchanged.
- [ ] Public responses and support logs contain only Restec and POS-visible data.
- [ ] Production webhook URL is HTTPS and passes destination validation.
- [ ] Operations, monitoring, alerting, and escalation contacts are approved.
- [ ] Real sandbox checkout, authoritative payment event, paid bill projection, POS outbox delivery, and signed dummy POS receipt are captured as evidence.

Certification confirms the tested contract and environment only. It does not certify untested POS versions, locations, payload extensions, or operational changes.
