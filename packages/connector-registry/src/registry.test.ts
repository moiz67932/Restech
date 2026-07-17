import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorRegistry } from './index.js';
test('registry resolves only enabled compatible connectors', () => {
  const registry = new ConnectorRegistry();
  assert.equal(registry.resolve('canonical_rest', '1.0.0').id, 'canonical_rest');
  assert.equal(registry.resolve('mock_pos', '1.0.0').id, 'mock_pos');
  assert.throws(() => registry.resolve('unknown', '1.0.0'));
  assert.throws(() => registry.resolve('canonical_rest', '2.0.0'));
  assert.throws(() => registry.resolve('canonical_rest', '1.0.0', false));
});
