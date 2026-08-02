# Go-live checklist

- [ ] UAT is signed off with no skipped required case.
- [ ] Restec has supplied and activated stable production API and callback connectivity.
- [ ] Production credentials are newly issued, location-scoped, expiry-dated, and stored securely.
- [ ] Sandbox credentials cannot access production.
- [ ] Callback TLS, DNS, signature verification, deduplication, and supported 2xx acknowledgement are verified.
- [ ] POS alerts cover signature failure, retry backlog, stale bills, and reconciliation mismatches.
- [ ] Restec alerts cover callback failures, dead letters, queue age, credential failures, and error rate.
- [ ] Peak-load and network-failure tests meet the agreed service objectives.
- [ ] Backup/restore and rollback evidence is current.
- [ ] Support contacts, incident runbook, maintenance window, rollback authority, and status communications are agreed.
- [ ] A low-value restaurant smoke test completes end to end.
- [ ] Post-launch monitoring ownership and a 24-hour review are scheduled.

Do not proceed if any required production endpoint, credential, scheduler, alert, backup, or recovery gate is unverified.
