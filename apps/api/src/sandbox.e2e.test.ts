import assert from 'node:assert/strict';
import test from 'node:test';
const enabled =
  process.env.RUN_REMOTE_SANDBOX_TESTS === 'true' &&
  Boolean(process.env.RESTEC_SANDBOX_TEST_API_KEY);
test('sandbox E2E is explicitly gated from normal test runs', { skip: !enabled }, async () => {
  const response = await fetch(`${process.env.RESTEC_PUBLIC_BASE_URL}/health`);
  assert.equal(response.status, 200);
});
