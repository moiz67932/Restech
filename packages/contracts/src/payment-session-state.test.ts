import assert from 'node:assert/strict';
import test from 'node:test';
import { transitionPaymentSessionStatus } from './payment-session-state.js';

test('payment session state machine preserves authoritative paid state', () => {
  assert.deepEqual(transitionPaymentSessionStatus('processing', 'paid'), {
    kind: 'applied',
    status: 'paid',
  });
  assert.deepEqual(transitionPaymentSessionStatus('paid', 'paid'), {
    kind: 'noop',
    status: 'paid',
  });
  assert.throws(() => transitionPaymentSessionStatus('paid', 'failed'));
  assert.throws(() => transitionPaymentSessionStatus('paid', 'cancelled'));
});

test('late authoritative payment can override customer cancellation or failure', () => {
  assert.equal(transitionPaymentSessionStatus('cancelled', 'paid').status, 'paid');
  assert.equal(transitionPaymentSessionStatus('failed', 'paid').status, 'paid');
  assert.equal(transitionPaymentSessionStatus('expired', 'paid').status, 'paid');
  assert.equal(
    transitionPaymentSessionStatus('paid', 'partially_refunded').status,
    'partially_refunded',
  );
  assert.equal(transitionPaymentSessionStatus('partially_refunded', 'refunded').status, 'refunded');
});
