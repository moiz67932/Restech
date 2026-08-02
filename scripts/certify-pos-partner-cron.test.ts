import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForCronCertification } from './certify-pos-partner-cron.js';

test('cron-only certification waits for scheduler evidence and never dispatches', async () => {
  let polls = 0;
  let sleeps = 0;
  const result = await waitForCronCertification({
    timeoutMs: 1000,
    pollMs: 1,
    sleep: async () => {
      sleeps++;
    },
    readStatus: async () => ({ status: polls++ === 0 ? 'processing' : 'paid' }),
    readEvidence: async () =>
      polls < 2
        ? { payment_session_status: 'processing', dead_lettered: false }
        : {
            payment_session_status: 'paid',
            bill_payment_status: 'paid',
            private_event_accepted: true,
            payment_completed_inbox_count: 1,
            pos_outbox_status: 'delivered',
            payment_completed_pos_count: 1,
            delivery_attempts: 1,
            mock_pos_accepted: true,
            matching_mock_pos_receipt_count: 1,
            dead_lettered: false,
          },
  });
  assert.equal(result.result, 'PASS');
  assert.equal(sleeps, 1);
});
