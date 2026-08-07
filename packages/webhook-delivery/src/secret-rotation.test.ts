import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindEventToWebhookVersion,
  canDeliverWithVersion,
  expireWebhookGrace,
  revokeWebhookVersion,
  startWebhookRotation,
  type WebhookSecretVersion,
} from './secret-rotation.js';

const initial = (): WebhookSecretVersion[] => [
  { version: 1, status: 'active', validFrom: new Date('2026-01-01T00:00:00Z') },
];

test('webhook rotation has one active version and stable event binding', () => {
  const now = new Date('2026-01-02T00:00:00Z');
  const rotated = startWebhookRotation(initial(), { graceSeconds: 60, now });
  assert.equal(rotated.filter((v) => v.status === 'active').length, 1);
  assert.equal(rotated.find((v) => v.version === 1)?.status, 'grace');
  assert.equal(bindEventToWebhookVersion(rotated.find((v) => v.status === 'active')!), 2);
  assert.equal(canDeliverWithVersion(rotated.find((v) => v.version === 1)), true);
  assert.equal(expireWebhookGrace(rotated, new Date(now.getTime() + 61_000))[0]?.status, 'retired');
});

test('emergency revoke blocks only the revoked event binding', () => {
  const rotated = startWebhookRotation(initial(), { graceSeconds: 3600 });
  const revoked = revokeWebhookVersion(rotated, 1);
  assert.equal(canDeliverWithVersion(revoked.find((v) => v.version === 1)), false);
  assert.equal(canDeliverWithVersion(revoked.find((v) => v.version === 2)), true);
});

test('1000 events and 100 test rotations preserve accounting', () => {
  let versions = initial();
  const events = Array.from({ length: 1000 }, (_, index) => ({
    id: index,
    version: bindEventToWebhookVersion(versions.find((v) => v.status === 'active')!),
  }));
  for (let index = 0; index < 100; index++) {
    versions = startWebhookRotation(versions, { graceSeconds: 60, now: new Date(index * 1000) });
    versions = expireWebhookGrace(versions, new Date(index * 1000 + 61_000));
  }
  assert.equal(new Set(events.map((event) => event.id)).size, 1000);
  assert.equal(events.filter((event) => event.version === 1).length, 1000);
  assert.equal(versions.filter((version) => version.status === 'active').length, 1);
  assert.equal(Math.max(...versions.map((version) => version.version)), 101);
});
