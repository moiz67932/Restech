import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpSharedRateLimiter, MemoryRateLimiter, SharedRateLimiterRequired } from './index.js';
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
test('HTTP shared limiter validates the adapter response', async () => {
  const limiter = new HttpSharedRateLimiter(
    'https://limiter.example/v1/consume',
    'token-token-token-token',
    async () =>
      new Response(JSON.stringify({ allowed: true, remaining: 9, retryAfterSeconds: 1 }), {
        status: 200,
      }),
  );
  assert.deepEqual(await limiter.consume({ key: 'partner:test', limit: 10, windowSeconds: 60 }), {
    allowed: true,
    remaining: 9,
    retryAfterSeconds: 1,
  });
});
