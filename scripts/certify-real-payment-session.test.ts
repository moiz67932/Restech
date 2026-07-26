import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CertificationHttpError,
  certificationBillBody,
  cleanupCertificationBill,
  createPaymentSessionWithCleanup,
} from './certify-real-payment-session.js';

test('cleanupCertificationBill cancels the existing certification bill at the next version', async () => {
  const calls: Array<{
    method: string;
    path: string;
    body: any;
    idempotencyKey?: string;
    operation?: string;
  }> = [];
  const result = await cleanupCertificationBill({
    signedRequest: async (method, path, body, idempotencyKey, operation) => {
      calls.push({ method, path, body, idempotencyKey, operation });
      return Response.json({
        request_id: 'req_cleanup',
        external_bill_id: 'CERT-example',
        version: 4,
        order_status: 'cancelled',
      });
    },
    billPath: '/v1/locations/loc_test/bills/CERT-example',
    externalBillId: 'CERT-example',
    externalTableId: '2',
    currentVersion: 3,
  });

  assert.deepEqual(result, {
    request_id: 'req_cleanup',
    external_bill_id: 'CERT-example',
    version: 4,
    order_status: 'cancelled',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(calls[0]?.operation, 'bill_cleanup');
  assert.equal(calls[0]?.idempotencyKey, 'cert-cleanup-example-v4');
  assert.equal(calls[0]?.body.version, 4);
  assert.equal(calls[0]?.body.status, 'cancelled');
  assert.equal(calls[0]?.body.order_status, 'cancelled');
});

test('payment-session failure is classified and automatically cancels the bill', async () => {
  const calls: string[] = [];
  const reports: string[] = [];
  const original = new CertificationHttpError(
    'payment_session_create',
    502,
    'dependency_unavailable',
    'req_original',
    false,
  );

  await assert.rejects(
    createPaymentSessionWithCleanup({
      signedRequest: async (method, _path, body, _key, operation) => {
        calls.push(`${method}:${operation}`);
        if (operation === 'payment_session_create') throw original;
        assert.equal((body as { order_status: string }).order_status, 'cancelled');
        return Response.json({
          request_id: 'req_cleanup',
          external_bill_id: 'CERT-example',
          version: 2,
          order_status: 'cancelled',
        });
      },
      createPath: '/v1/locations/loc_test/bills/CERT-example/payment-sessions',
      createBody: { amount_minor: 10_000 },
      paymentIdempotencyKey: 'cert-payment-example',
      billPath: '/v1/locations/loc_test/bills/CERT-example',
      externalBillId: 'CERT-example',
      externalTableId: '2',
      expectedCheckoutOrigin: 'https://api.example',
      report: (message) => reports.push(message),
    }),
    (error) => error === original,
  );

  assert.deepEqual(calls, ['POST:payment_session_create', 'PUT:bill_cleanup']);
  assert.match(reports[0] ?? '', /restec\.certification_request_failure/);
  assert.match(reports[0] ?? '', /dependency_unavailable/);
  assert.match(reports[1] ?? '', /restec\.certification_bill_cleanup/);
  assert.match(reports[1] ?? '', /cancelled/);
});

test('failed automatic cleanup prints an exact sandbox cleanup command', async () => {
  const reports: string[] = [];
  await assert.rejects(
    createPaymentSessionWithCleanup({
      signedRequest: async (_method, _path, _body, _key, operation) => {
        if (operation === 'payment_session_create')
          throw new CertificationHttpError(
            'payment_session_create',
            502,
            'dependency_unavailable',
            'req_original',
            true,
          );
        throw new Error('cleanup dependency still unavailable');
      },
      createPath: '/payment-sessions',
      createBody: {},
      paymentIdempotencyKey: 'cert-payment-example',
      billPath: '/bills/CERT-example',
      externalBillId: 'CERT-example',
      externalTableId: '2',
      expectedCheckoutOrigin: 'https://api.example',
      report: (message) => reports.push(message),
    }),
    CertificationHttpError,
  );

  assert.match(reports.join('\n'), /Automatic certification bill cleanup failed/);
  assert.match(reports.join('\n'), /\$env:RESTEC_CERTIFICATION_EXTERNAL_BILL_ID='CERT-example'/);
  assert.match(reports.join('\n'), /npm run certify:real-payment-session -- --cleanup/);
});

test('invalid payment-session response also triggers bill cleanup', async () => {
  const operations: string[] = [];
  await assert.rejects(
    createPaymentSessionWithCleanup({
      signedRequest: async (_method, _path, _body, _key, operation) => {
        operations.push(operation ?? '');
        return Response.json(
          operation === 'payment_session_create'
            ? { status: 'unexpected' }
            : {
                request_id: 'req_cleanup',
                external_bill_id: 'CERT-example',
                version: 2,
                order_status: 'cancelled',
              },
        );
      },
      createPath: '/payment-sessions',
      createBody: {},
      paymentIdempotencyKey: 'cert-payment-example',
      billPath: '/bills/CERT-example',
      externalBillId: 'CERT-example',
      externalTableId: '2',
      expectedCheckoutOrigin: 'https://api.example',
      report: () => undefined,
    }),
    /response was incomplete/,
  );
  assert.deepEqual(operations, ['payment_session_create', 'bill_cleanup']);
});

test('certificationBillBody preserves financial values when cancelling', () => {
  const open = certificationBillBody('2', 1);
  const cancelled = certificationBillBody('2', 2, true);
  assert.deepEqual(cancelled.items, open.items);
  assert.deepEqual(cancelled.totals, open.totals);
  assert.equal(cancelled.external_table_id, open.external_table_id);
  assert.equal(cancelled.status, 'cancelled');
});
