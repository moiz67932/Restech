import assert from 'node:assert/strict';
import test from 'node:test';
import { PaelyClient, PrivateDependencyError } from './index.js';
import { verifyRequestSignature } from '@restec/security';
test('private client signs exact body, preserves idempotency key, rotates request IDs, and removes private IDs', async () => {
  const requests: Request[] = [];
  let count = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    count++;
    if (count === 1) return new Response('{}', { status: 503 });
    return new Response(
      JSON.stringify({
        integration_bill_id: 'int_bill_private',
        paely_order_id: '00000000-0000-0000-0000-000000000000',
        private_table_uuid: '00000000-0000-0000-0000-000000000999',
        upstream_debug: { route: '/hidden' },
        external_bill_id: 'B1',
        external_table_id: 'T1',
        sync_status: 'accepted',
        order_status: 'accepted',
        payment_status: 'unpaid',
        table_session_status: 'dining',
        currency: 'PKR',
        grand_total: 100,
        amount_paid: 0,
        amount_refunded: 0,
        amount_due: 100,
        version: 1,
        reconciliation_status: 'matched',
        updated_at: '2026-07-17T00:00:00Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = new PaelyClient({
    baseUrl: 'https://private.example',
    bearerToken: 'token',
    serviceId: 'service',
    environment: 'sandbox',
    signingSecret: 'secret',
    timeoutMs: 1000,
    fetch: fetcher,
  });
  const body = {
    external_table_id: 'T1',
    version: 1,
    currency: 'PKR',
    status: 'open' as const,
    order_status: 'accepted' as const,
    items: [
      { external_item_id: 'I1', name: 'Meal', quantity: 1, unit_amount: 100, total_amount: 100 },
    ],
    totals: { subtotal: 100, tax: 0, service_charge: 0, discount: 0, tip: 0, grand_total: 100 },
    occurred_at: '2026-07-17T00:00:00Z',
    metadata: {},
  };
  const result = await client.upsertBill(
    '00000000-0000-0000-0000-000000000001',
    'B1',
    body,
    'stable-key',
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.headers.get('Idempotency-Key'), 'stable-key');
  assert.equal(requests[1]!.headers.get('Idempotency-Key'), 'stable-key');
  assert.notEqual(
    requests[0]!.headers.get('X-Request-Id'),
    requests[1]!.headers.get('X-Request-Id'),
  );
  const raw = JSON.stringify(body);
  const first = requests[0]!;
  assert(
    verifyRequestSignature({
      secret: 'secret',
      signature: first.headers.get('X-Restec-Signature')!,
      timestamp: Number(first.headers.get('X-Restec-Timestamp')),
      method: 'PUT',
      path: new URL(first.url).pathname,
      rawBody: raw,
    }),
  );
  assert(!('integration_bill_id' in result));
  assert(!('paely_order_id' in result));
  assert(!('private_table_uuid' in result));
  assert(!('upstream_debug' in result));
});
test('payment-session client uses the private contract and deterministic idempotency', async () => {
  let captured: Request | undefined;
  const client = new PaelyClient({
    baseUrl: 'https://private.example',
    bearerToken: 'token',
    serviceId: 'service',
    environment: 'sandbox',
    signingSecret: 'secret',
    timeoutMs: 1000,
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return new Response(
        JSON.stringify({
          privatePaymentSessionId: 'opaque-private-id',
          status: 'requires_customer_action',
          providerCheckoutUrl: 'https://checkout.example/opaque-token',
          amountMinor: 100,
          currency: 'PKR',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  const body = {
    connectionId: '00000000-0000-4000-8000-000000000001',
    amountMinor: 100,
    currency: 'PKR' as const,
    method: 'card' as const,
    returnUrls: {
      success: 'https://api.example/s/rps_test_example/return',
      cancel: 'https://api.example/s/rps_test_example/cancel',
    },
    restecPaymentSessionReference: 'rps_test_example',
  };
  const result = await client.createPaymentSession(
    '00000000-0000-4000-8000-000000000002',
    'BILL-1',
    body,
    'stable-private-key',
  );
  assert.equal(result.status, 'requires_customer_action');
  assert.equal(captured?.headers.get('Idempotency-Key'), 'stable-private-key');
  assert.equal(captured?.headers.get('X-Restec-Environment'), 'sandbox');
  assert.equal(captured?.headers.get('X-Restec-Service-Id'), 'service');
  const requestBody = await captured!.clone().text();
  assert(
    verifyRequestSignature({
      secret: 'secret',
      signature: captured!.headers.get('X-Restec-Signature')!,
      timestamp: Number(captured!.headers.get('X-Restec-Timestamp')),
      method: 'POST',
      path: new URL(captured!.url).pathname,
      rawBody: requestBody,
    }),
  );
});

test('private client consumes and classifies a Paely Vercel invocation failure', async () => {
  const responses: Response[] = [];
  let attempt = 0;
  const client = new PaelyClient({
    baseUrl: 'https://private.example',
    bearerToken: 'token',
    serviceId: 'service',
    environment: 'sandbox',
    signingSecret: 'secret',
    timeoutMs: 1000,
    fetch: async () => {
      attempt++;
      const response = new Response(
        'A server error has occurred\n\nFUNCTION_INVOCATION_FAILED\n\nprivate diagnostic',
        {
          status: 500,
          headers: {
            'Content-Type': 'text/plain',
            'X-Vercel-Id': `provider-request-${attempt}`,
          },
        },
      );
      responses.push(response);
      return response;
    },
  });

  await assert.rejects(
    client.getBill('00000000-0000-4000-8000-000000000001', 'B1'),
    (error: unknown) => {
      assert(error instanceof PrivateDependencyError);
      assert.equal(error.dependency, 'paely_private_api');
      assert.equal(error.operation, 'bill_get');
      assert.equal(error.failureKind, 'http');
      assert.equal(error.status, 500);
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 3);
      assert.match(error.downstreamRequestId ?? '', /^req_[0-9a-f]{32}$/);
      assert.equal(error.providerRequestId, 'provider-request-3');
      assert.equal(error.downstreamErrorCode, undefined);
      assert(!error.message.includes('FUNCTION_INVOCATION_FAILED'));
      return true;
    },
  );
  assert.equal(attempt, 3);
  assert(responses.every((response) => response.bodyUsed));
});

test('private client records sanitized Paely JSON error metadata without retrying', async () => {
  let attempt = 0;
  const client = new PaelyClient({
    baseUrl: 'https://private.example',
    bearerToken: 'token',
    serviceId: 'service',
    environment: 'sandbox',
    signingSecret: 'secret',
    timeoutMs: 1000,
    fetch: async () => {
      attempt++;
      return new Response(
        JSON.stringify({
          error: {
            code: 'table_mapping_not_found',
            request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            message: 'private message that must not escape',
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await assert.rejects(
    client.getBill('00000000-0000-4000-8000-000000000001', 'B1'),
    (error: unknown) => {
      assert(error instanceof PrivateDependencyError);
      assert.equal(error.operation, 'bill_get');
      assert.equal(error.status, 404);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.equal(error.downstreamErrorCode, 'table_mapping_not_found');
      assert.equal(error.downstreamRequestId, 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      assert(!error.message.includes('private message'));
      return true;
    },
  );
  assert.equal(attempt, 1);
});
