import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeWebhookUrl, retryDelaySeconds } from './index.js';

test('webhook destination blocks private, link-local, metadata, credentials, and non-HTTPS production URLs', async () => {
  const publicLookup = async () => [{ address: '203.0.113.10', family: 4 as const }];
  await assert.doesNotReject(() =>
    assertSafeWebhookUrl('https://pos.example/webhook', 'production', publicLookup as any),
  );
  await assert.rejects(() =>
    assertSafeWebhookUrl('http://pos.example/webhook', 'production', publicLookup as any),
  );
  await assert.rejects(() =>
    assertSafeWebhookUrl(
      'https://user:pass@pos.example/webhook',
      'production',
      publicLookup as any,
    ),
  );
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
  ])
    await assert.rejects(() =>
      assertSafeWebhookUrl(
        'https://pos.example/webhook',
        'production',
        async () => [{ address, family: address.includes(':') ? 6 : 4 }] as any,
      ),
    );
});

test('retry schedule matches the delivery contract', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(retryDelaySeconds),
    [30, 120, 600, 1800, 7200, 21600, 43200],
  );
});
