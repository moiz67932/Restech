import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStoredCredentials, sanitizeDatabaseError } from './create-sandbox-credentials.ts';

const expected = {
  partner_id: 'ptr_sandbox_demo',
  environment: 'sandbox' as const,
  key_prefix: 'prefix',
  key_hash: 'stored-api-key-hash',
  encrypted_signing_secret: 'stored-request-signing-secret',
  encrypted_connector_configuration: 'stored-connector-configuration',
  encrypted_webhook_secret: 'stored-webhook-secret',
};

test('credential read-back requires the API key hash and both signing secrets', () => {
  assert.doesNotThrow(() =>
    assertStoredCredentials(
      {
        apiKey: {
          key_hash: expected.key_hash,
          encrypted_signing_secret: expected.encrypted_signing_secret,
        },
        connections: [
          {
            id: 'con_sandbox_canonical',
            encrypted_configuration: expected.encrypted_connector_configuration,
          },
          {
            id: 'con_sandbox_mock',
            encrypted_configuration: expected.encrypted_connector_configuration,
          },
        ],
        webhook: { encrypted_signing_secret: expected.encrypted_webhook_secret },
      },
      expected,
    ),
  );

  assert.throws(
    () =>
      assertStoredCredentials(
        {
          apiKey: {
            key_hash: expected.key_hash,
            encrypted_signing_secret: expected.encrypted_signing_secret,
          },
          connections: [
            {
              id: 'con_sandbox_canonical',
              encrypted_configuration: expected.encrypted_connector_configuration,
            },
            {
              id: 'con_sandbox_mock',
              encrypted_configuration: expected.encrypted_connector_configuration,
            },
          ],
          webhook: { encrypted_signing_secret: 'wrong' },
        },
        expected,
      ),
    /webhook secret verification failed/i,
  );
});

test('database diagnostics retain useful fields and redact credentials', () => {
  const secret = 'credential-that-must-not-be-printed';
  assert.deepEqual(
    sanitizeDatabaseError(
      {
        message: `duplicate value ${secret}`,
        code: '23505',
        details: `Key contains ${secret}`,
        hint: null,
      },
      [secret],
    ),
    {
      message: 'duplicate value [redacted]',
      code: '23505',
      details: 'Key contains [redacted]',
      hint: null,
    },
  );
});
