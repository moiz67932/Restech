import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRateLimiter, SharedRateLimiterRequired } from './index.js';
test('memory limiter enforces a bounded test window', async () => {
  const limiter = new MemoryRateLimiter();
  assert.equal((await limiter.consume({ key: 'a', limit: 1, windowSeconds: 60 })).allowed, true);
  const denied = await limiter.consume({ key: 'a', limit: 1, windowSeconds: 60 });
  assert.equal(denied.allowed, false);
  assert(denied.retryAfterSeconds > 0);
});
test('missing shared adapter fails closed', async () =>
  await assert.rejects(
    () => new SharedRateLimiterRequired().consume({ key: 'a', limit: 1, windowSeconds: 1 }),
    /shared production/,
  ));
