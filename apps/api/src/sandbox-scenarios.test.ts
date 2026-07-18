import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository } from './memory-repository.js';

const repository = () => {
  const repo = new MemoryRepository();
  repo.connections.set('con_test', {
    connectionId: 'con_test',
    partnerId: 'ptr_test',
    locationId: 'loc_test',
    environment: 'sandbox',
    connectorType: 'mock_pos',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId: '00000000-0000-0000-0000-000000000002',
    privateConnectionId: '00000000-0000-0000-0000-000000000001',
    configuration: { webhook_url: 'https://1.1.1.1/webhook', failure_mode: 'success' },
  });
  repo.bills.set('con_test:INV-1', {
    request_id: 'req_original',
    restec_bill_id: 'bil_test',
    external_bill_id: 'INV-1',
    external_table_id: '12',
    sync_status: 'accepted',
    order_status: 'accepted',
    payment_status: 'unpaid',
    table_session_status: 'dining',
    currency: 'PKR',
    grand_total: 10000,
    amount_paid: 0,
    amount_refunded: 0,
    amount_due: 10000,
    version: 1,
    reconciliation_status: 'matched',
    updated_at: new Date().toISOString(),
  });
  return repo;
};

test('sandbox partial and duplicate scenarios use the normal projection and outbox pipeline', async () => {
  const partial = repository();
  await partial.createSandboxEvent('con_test', 'partial_payment.completed', 'INV-1', 4000);
  assert.equal((await partial.getBill('con_test', 'INV-1'))?.payment_status, 'partially_paid');
  assert.equal((await partial.getBill('con_test', 'INV-1'))?.amount_due, 6000);
  assert.equal(partial.outbox.size, 1);
  const duplicate = repository();
  await duplicate.createSandboxEvent('con_test', 'duplicate_event', 'INV-1', 10000);
  assert.equal(duplicate.events.size, 1);
  assert.equal(duplicate.outbox.size, 1);
});

test('sandbox webhook failure scenario reaches a retry-capable mock connector', async () => {
  const repo = repository();
  await repo.createSandboxEvent('con_test', 'webhook_429', 'INV-1', 10000);
  const [event] = repo.outbox.values();
  assert.equal(event?.connectorType, 'mock_pos');
  assert.equal(event?.configuration.failure_mode, '429');
});
