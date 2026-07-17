import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateApiKey,
  hashApiKey,
  secureEqual,
  signEvent,
  signRequest,
  verifyEventSignature,
  verifyRequestSignature,
  verifyTimestamp,
} from './index.js';
test('request signature covers method path and exact body', () => {
  const signature = signRequest('secret', 100, 'PUT', '/v1/test', '{"x":1}');
  assert.equal(
    verifyRequestSignature({
      secret: 'secret',
      signature,
      timestamp: 100,
      method: 'PUT',
      path: '/v1/test',
      rawBody: '{"x":1}',
    }),
    true,
  );
  assert.equal(
    verifyRequestSignature({
      secret: 'secret',
      signature,
      timestamp: 100,
      method: 'POST',
      path: '/v1/test',
      rawBody: '{"x":1}',
    }),
    false,
  );
  assert.equal(
    verifyRequestSignature({
      secret: 'secret',
      signature,
      timestamp: 100,
      method: 'PUT',
      path: '/v1/test',
      rawBody: '{"x": 1}',
    }),
    false,
  );
});
test('event signature and timestamps are verified', () => {
  const signature = signEvent('secret', 100, '{}');
  assert(verifyEventSignature({ secret: 'secret', signature, timestamp: 100, rawBody: '{}' }));
  assert(!verifyTimestamp(100, 500, 300));
  assert(verifyTimestamp(100, 400, 300));
});
test('API keys are environment-prefixed and hashed', () => {
  assert.match(generateApiKey('sandbox').key, /^rst_test_/);
  assert.match(generateApiKey('production').key, /^rst_live_/);
  assert(secureEqual(hashApiKey('key', 'pepper'), hashApiKey('key', 'pepper')));
});
