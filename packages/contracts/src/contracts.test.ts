import assert from 'node:assert/strict';
import test from 'node:test';
import { billSchema, externalPaymentSchema } from './index.js';
const bill = {
  external_table_id: '12',
  version: 1,
  currency: 'PKR',
  status: 'open',
  order_status: 'accepted',
  items: [
    { external_item_id: 'i1', name: 'Meal', quantity: 2, unit_amount: 100, total_amount: 200 },
  ],
  totals: { subtotal: 200, tax: 10, service_charge: 0, discount: 0, tip: 0, grand_total: 210 },
  occurred_at: '2026-07-17T00:00:00Z',
  metadata: {},
};
test('valid bill uses integer consistent minor units', () =>
  assert.equal(billSchema.parse(bill).totals.grand_total, 210));
test('floating money and inconsistent totals fail', () => {
  assert.throws(() =>
    billSchema.parse({ ...bill, totals: { ...bill.totals, grand_total: 210.5 } }),
  );
  assert.throws(() => billSchema.parse({ ...bill, totals: { ...bill.totals, subtotal: 199 } }));
});
test('unknown payment and raw card fields fail', () => {
  const payment = {
    external_payment_id: 'p1',
    method: 'cash',
    amount: 100,
    currency: 'PKR',
    status: 'completed',
    occurred_at: '2026-07-17T00:00:00Z',
    metadata: {},
  };
  assert.doesNotThrow(() => externalPaymentSchema.parse(payment));
  assert.throws(() => externalPaymentSchema.parse({ ...payment, card_number: '4111111111111111' }));
});
