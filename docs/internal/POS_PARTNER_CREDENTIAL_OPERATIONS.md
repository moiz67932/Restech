# POS partner credential operations

The operator CLI is `npm run provision:pos-partner -- <command>`. It performs no write unless `--apply` is present. Production issuance additionally requires the one-turn approval flag documented by the tool. Keep the JSON input in restricted temporary storage and never commit it.

Provision input contains partner/restaurant/location display names, the POS external location ID, HTTPS callback URL, future expiry, approved scopes, technical contacts, optional IP CIDRs, optional certificate subjects/fingerprints, and only an identifier for optional POS inbound authentication. The inbound credential value, when applicable, is supplied separately through the operator secret channel and encrypted before persistence.

```text
npm run provision:pos-partner -- provision --environment sandbox --input <restricted-json> --apply
npm run provision:pos-partner -- rotate --environment sandbox --input <restricted-json> --grace-seconds 86400 --apply
npm run provision:pos-partner -- revoke --key-prefix <approved-prefix> --apply
```

Provisioning is an atomic transaction. The API credential is hashed; request/webhook and optional inbound secrets are encrypted. Initial issuance prints only partner-deliverable values once: partner ID, Restec location ID, external location confirmation, environment, scopes, expiry, credential version, API credential, request-signing secret, and webhook-signing secret. It does not print internal connection or downstream references.

For rotation, transmit the new credential and signing secret through the approved secure channel, verify the new version in sandbox or a controlled production smoke test, then allow the prior version to expire at the approved grace boundary. Emergency revocation uses the key prefix and takes effect immediately. Record operator identity, ticket, recipient confirmation, timestamps, and the last-used audit in the change record.

Never paste issuance output into logs, chat, source control, or a general support ticket. If delivery confirmation fails, revoke the new credential and issue a different value; stored secrets are not recoverable.
