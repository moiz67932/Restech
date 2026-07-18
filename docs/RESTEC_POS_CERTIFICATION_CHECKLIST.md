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

Certification confirms the tested contract and environment only. It does not certify untested POS versions, locations, payload extensions, or operational changes.
