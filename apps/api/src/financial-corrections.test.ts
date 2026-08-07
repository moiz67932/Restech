import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository } from './memory-repository.js';
import type { CanonicalBillState, FinancialCorrection } from '@restec/database';

const bill = (overrides: Partial<CanonicalBillState> = {}): CanonicalBillState => ({
  request_id: 'req_test',
  restec_bill_id: 'bil_test',
  external_bill_id: 'BILL-CORRECTION',
  external_table_id: 'TABLE-1',
  sync_status: 'accepted',
  order_status: 'completed',
  payment_status: 'paid',
  table_session_status: 'closed',
  currency: 'PKR',
  grand_total: 10_000,
  amount_paid: 10_000,
  amount_refunded: 0,
  amount_due: 0,
  version: 1,
  reconciliation_status: 'matched',
  updated_at: new Date().toISOString(),
  ...overrides,
});

const correction = (n: number, amount: number): FinancialCorrection => ({
  correctionId: `cor_${n}`,
  logicalIdentity: `logical_${n}`,
  type: 'refund',
  status: 'completed',
  connectionId: 'con_correction',
  externalBillId: 'BILL-CORRECTION',
  originalPaymentId: 'pay_original',
  amountMinor: amount,
  currency: 'PKR',
  authority: 'provider',
  source: 'provider_event',
  occurredAt: new Date().toISOString(),
});

test('financial corrections are immutable, idempotent, and do not reopen receivable', async () => {
  const repo = new MemoryRepository();
  repo.bills.set('con_correction:BILL-CORRECTION', bill());
  const first = await repo.recordProviderCorrection(correction(1, 2_000));
  assert.equal(first.duplicate, false);
  assert.equal(first.bill.amount_refunded, 2_000);
  assert.equal(first.bill.amount_due, 0);
  assert.equal(first.bill.amount_paid, 10_000);
  const duplicate = await repo.recordProviderCorrection(correction(1, 2_000));
  assert.equal(duplicate.duplicate, true);
  assert.equal((await repo.listFinancialCorrections('con_correction', 'BILL-CORRECTION')).length, 1);
});

test('concurrent refund corrections never exceed original completed payment', async () => {
  const repo = new MemoryRepository();
  repo.bills.set('con_correction:BILL-CORRECTION', bill());
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) => repo.recordProviderCorrection(correction(index, 200))),
  );
  const rows = await repo.listFinancialCorrections('con_correction', 'BILL-CORRECTION');
  const completed = rows.filter((row) => row.status === 'completed').reduce((sum, row) => sum + row.amountMinor, 0);
  assert.equal(completed, 10_000);
  assert.equal(results.filter((result) => result.correction.status === 'review_required').length, 50);
  assert.ok(completed <= 10_000);
});

test('same logical provider correction with a different technical event remains one fact', async () => {
  const repo = new MemoryRepository();
  repo.bills.set('con_correction:BILL-CORRECTION', bill());
  const base = correction(1, 1_000);
  await repo.recordProviderCorrection(base);
  const duplicateWithDifferentEventId = { ...base, correctionId: 'cor_other_event_id' };
  const result = await repo.recordProviderCorrection(duplicateWithDifferentEventId);
  assert.equal(result.duplicate, true);
  assert.equal((await repo.listFinancialCorrections('con_correction', 'BILL-CORRECTION')).length, 1);
});
