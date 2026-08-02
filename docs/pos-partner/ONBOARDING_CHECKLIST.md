# Onboarding checklist

## POS partner provides

- [ ] Legal/technical partner name and technical escalation contacts.
- [ ] Sandbox and production external store/location identifiers.
- [ ] Separate sandbox and production HTTPS callback URLs.
- [ ] Expected peak API and webhook traffic.
- [ ] Optional inbound bearer/API authentication requirements.
- [ ] Optional mTLS certificate subjects/fingerprints.
- [ ] Optional outbound IP allow-list requirements.
- [ ] Table identifiers and names to map.

## Restec provides

- [ ] Partner/client ID.
- [ ] Sandbox Restec location ID and activated sandbox API base URL.
- [ ] One-time sandbox API credential and request-signing secret.
- [ ] One-time sandbox webhook-signing secret.
- [ ] Approved scopes, expiry, and rotation date.
- [ ] Customer table links through the agreed secure channel.
- [ ] Production values only after UAT approval; never copied from sandbox.

## Joint verification

- [ ] Credentials are stored in secret managers and absent from source control.
- [ ] Clock synchronization is enabled.
- [ ] Request signing and webhook signing pass known-body tests.
- [ ] Every external table maps to the correct Restec location.
- [ ] All UAT cases pass with retained request/event evidence.
- [ ] Support hours, incident severity, and go-live rollback contacts are agreed.
