import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decryptSecret, signEvent, signRequest } from '@restec/security';
import { PrivateDependencyError } from '@restec/paely-client';
import type { Config } from './config.js';
import { createApp } from './app.js';
import { MemoryRepository } from './memory-repository.js';
import {
  assertCheckoutDestination,
  assertResolvedCheckoutDestination,
  paymentStatusFromEvent,
} from './payment-sessions.js';

const enabledConfig: Config = {
  NODE_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_ENV: 'sandbox',
  RESTEC_PUBLIC_BASE_URL: 'https://api.example',
  RESTEC_PAYMENT_SESSIONS_ENABLED: true,
  RESTEC_PAYMENT_SESSION_TTL_SECONDS: 900,
  RESTEC_CHECKOUT_PUBLIC_BASE_URL: 'https://api.example',
  RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS: 'checkout.example',
  RESTEC_PAYMENT_SESSION_RETURN_POLL_SECONDS: 2,
  RESTEC_TIMESTAMP_TOLERANCE_SECONDS: 300,
  RESTEC_PRIVATE_REQUEST_TIMEOUT_MS: 1000,
  RESTEC_POS_DELIVERY_TIMEOUT_MS: 1000,
  RESTEC_MAX_DELIVERY_ATTEMPTS: 3,
  RESTEC_DISPATCH_BATCH_SIZE: 10,
  PAELY_PRIVATE_BASE_URL: 'https://private.example',
  PAELY_SERVICE_ID: 'restec',
  PAELY_PRIVATE_BEARER_TOKEN: '1234567890123456',
  PAELY_PRIVATE_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SERVICE_ID: 'financial-core',
  RESTEC_API_KEY_HASH_SECRET: '12345678901234567890123456789012',
  RESTEC_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  RESTEC_INTERNAL_JOB_TOKEN: '1234567890123456',
  RESTEC_STRICT_RATE_LIMITING: false,
};

test('provider cancellation remains a distinct terminal session state', () => {
  assert.equal(paymentStatusFromEvent('payment.failed', 'cancelled'), 'cancelled');
  assert.equal(paymentStatusFromEvent('payment.failed', 'failed'), 'failed');
});
const apiKey = 'rst_test_aaaaaaaaaaaaexample';
const requestSecret = 'request-secret';
const webhookSecret = 'webhook-secret';

function fixture(
  createOverride?: () => Promise<{
    privatePaymentSessionId: string;
    status: 'requires_customer_action';
    providerCheckoutUrl: string;
    amountMinor: number;
    currency: 'PKR';
    expiresAt: string;
  }>,
  refreshOverride?: (expected: {
    privatePaymentSessionId: string;
    amountMinor: number;
    currency: 'PKR';
  }) => Promise<{
    privatePaymentSessionId: string;
    status: 'requires_customer_action';
    providerCheckoutUrl: string;
    amountMinor: number;
    currency: 'PKR';
    expiresAt: string;
  }>,
) {
  const repo = new MemoryRepository();
  repo.credentials.set(apiKey, {
    partnerId: 'ptr_test',
    environment: 'sandbox',
    signingSecret: requestSecret,
    status: 'active',
    keyPrefix: 'aaaaaaaaaaaa',
  });
  repo.connections.set('con_test', {
    connectionId: 'con_test',
    partnerId: 'ptr_test',
    locationId: 'loc_test',
    environment: 'sandbox',
    connectorType: 'canonical_rest',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId: '00000000-0000-4000-8000-000000000002',
    privateConnectionId: '00000000-0000-4000-8000-000000000001',
    configuration: {
      webhook_url: 'https://api.example/api/test/mock-pos-webhook',
      webhook_secret: webhookSecret,
    },
  });
  repo.bills.set('con_test:BILL-1', {
    request_id: 'req_bill',
    restec_bill_id: 'bil_test',
    external_bill_id: 'BILL-1',
    external_table_id: 'T1',
    sync_status: 'accepted',
    order_status: 'accepted',
    payment_status: 'unpaid',
    table_session_status: 'dining',
    currency: 'PKR',
    grand_total: 10_000,
    amount_paid: 0,
    amount_refunded: 0,
    amount_due: 10_000,
    version: 1,
    reconciliation_status: 'matched',
    updated_at: new Date().toISOString(),
  });
  let privateCalls = 0;
  let refreshCalls = 0;
  const privateClient = {
    async createPaymentSession() {
      privateCalls++;
      if (createOverride) return createOverride();
      return {
        privatePaymentSessionId: 'private-session-hidden',
        status: 'requires_customer_action',
        providerCheckoutUrl:
          'https://checkout.example/hosted?tracker=existing-tracker&token=expired-token',
        amountMinor: 10_000,
        currency: 'PKR',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async refreshPaymentSession(expected: {
      privatePaymentSessionId: string;
      amountMinor: number;
      currency: 'PKR';
    }) {
      refreshCalls++;
      if (refreshOverride) return refreshOverride(expected);
      return {
        privatePaymentSessionId: expected.privatePaymentSessionId,
        status: 'requires_customer_action',
        providerCheckoutUrl:
          'https://checkout.example/hosted?tracker=existing-tracker&token=fresh-token',
        amountMinor: expected.amountMinor,
        currency: expected.currency,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
  } as any;
  const app = createApp({
    repository: repo,
    privateClient,
    config: enabledConfig,
    eventSigningSecret: 'event-secret',
    internalJobToken: 'job-secret',
    checkoutLookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  return {
    app,
    repo,
    privateCalls: () => privateCalls,
    refreshCalls: () => refreshCalls,
  };
}

const signed = (path: string, method: string, body = '', requestId = `req_${Date.now()}`) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Restec-Environment': 'sandbox',
    'X-Restec-Timestamp': String(timestamp),
    'X-Restec-Signature': signRequest(requestSecret, timestamp, method, path, body),
    'X-Request-Id': requestId,
  };
};

async function createHostedPaymentSession(
  app: ReturnType<typeof createApp>,
  key: string,
): Promise<string> {
  const path = '/v1/locations/loc_test/bills/BILL-1/payment-sessions';
  const body = JSON.stringify({ amount_minor: 10_000, currency: 'PKR', method: 'card' });
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      ...signed(path, 'POST', body, `req_create_${key.replaceAll('-', '_')}`),
      'Idempotency-Key': key,
    },
    body,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { payment_session_id: string }).payment_session_id;
}

test('customer return polling stops for every terminal payment-session state', async (t) => {
  for (const terminal of [
    'paid',
    'failed',
    'cancelled',
    'expired',
    'refunded',
    'partially_refunded',
  ] as const) {
    await t.test(terminal, async () => {
      const { app, repo } = fixture();
      const publicId = await createHostedPaymentSession(app, `return-polling-${terminal}`);
      const pending = await app.request(`/s/${publicId}/return`);
      assert.match(await pending.text(), /http-equiv="refresh"/);

      if (terminal === 'refunded' || terminal === 'partially_refunded')
        await repo.transitionPaymentSession(publicId, 'paid', new Date().toISOString());
      await repo.transitionPaymentSession(publicId, terminal, new Date().toISOString());
      const completed = await app.request(`/s/${publicId}/return`);
      const completedHtml = await completed.text();
      assert.doesNotMatch(completedHtml, /http-equiv="refresh"/);
      assert.match(completedHtml, new RegExp(`Status: ${terminal}`));
    });
  }
});

test('payment session is Restec-only, encrypted at rest, idempotent, and refreshes before redirect', async () => {
  const { app, repo, privateCalls, refreshCalls } = fixture();
  const path = '/v1/locations/loc_test/bills/BILL-1/payment-sessions';
  const body = JSON.stringify({
    amount_minor: 10_000,
    currency: 'PKR',
    method: 'card',
    customer: { email: 'sandbox@example.com', mobile: '03000000000' },
  });
  const first = await app.request(path, {
    method: 'POST',
    headers: { ...signed(path, 'POST', body, 'req_payment_create_1'), 'Idempotency-Key': 'pay-1' },
    body,
  });
  assert.equal(first.status, 201, await first.clone().text());
  const response = (await first.json()) as any;
  assert.equal(response.status, 'requires_customer_action');
  assert.match(response.payment_session_id, /^rps_test_/);
  assert.equal(response.checkout_url, `https://api.example/s/${response.payment_session_id}`);
  assert.equal(JSON.stringify(response).includes('private-session-hidden'), false);
  assert.equal(JSON.stringify(response).includes('checkout.example'), false);
  const stored = await repo.getPaymentSession(response.payment_session_id);
  assert(stored?.encryptedProviderCheckoutUrl);
  assert.equal(stored.encryptedProviderCheckoutUrl.includes('checkout.example'), false);
  const evidenceResponse = await app.request(
    `/api/internal/test/payment-sessions/${response.payment_session_id}/evidence`,
    { headers: { Authorization: 'Bearer job-secret' } },
  );
  assert.equal(evidenceResponse.status, 200, await evidenceResponse.clone().text());
  assert.equal(
    ((await evidenceResponse.json()) as { private_payment_session_id?: string })
      .private_payment_session_id,
    'private-session-hidden',
  );

  const replay = await app.request(path, {
    method: 'POST',
    headers: { ...signed(path, 'POST', body, 'req_payment_create_2'), 'Idempotency-Key': 'pay-1' },
    body,
  });
  assert.equal(replay.status, 201);
  assert.equal(privateCalls(), 1);

  const statusPath = `/v1/locations/loc_test/payment-sessions/${response.payment_session_id}`;
  const statusResponse = await app.request(statusPath, {
    headers: signed(statusPath, 'GET', '', 'req_payment_status_1'),
  });
  assert.equal(statusResponse.status, 200);
  const statusBody = (await statusResponse.json()) as any;
  assert.deepEqual(
    { status: statusBody.status, checkout_url: statusBody.checkout_url },
    { status: 'requires_customer_action', checkout_url: undefined },
  );

  const redirect = await app.request(`/s/${response.payment_session_id}`, {
    redirect: 'manual',
  });
  assert.equal(redirect.status, 303);
  assert.equal(
    redirect.headers.get('location'),
    'https://checkout.example/hosted?tracker=existing-tracker&token=fresh-token',
  );
  assert.match(redirect.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(privateCalls(), 1);
  assert.equal(refreshCalls(), 1);
  const refreshed = await repo.getPaymentSession(response.payment_session_id);
  assert(refreshed?.encryptedProviderCheckoutUrl);
  assert.equal(
    decryptSecret(
      refreshed.encryptedProviderCheckoutUrl,
      enabledConfig.RESTEC_SECRET_ENCRYPTION_KEY,
    ),
    'https://checkout.example/hosted?tracker=existing-tracker&token=fresh-token',
  );
  assert.equal(refreshed.providerCheckoutHost, 'checkout.example');
  assert.equal(redirect.headers.get('location')?.includes('expired-token'), false);
});

test('checkout refresh rejects an invalid host and never falls back to the original URL', async () => {
  const { app, repo, refreshCalls } = fixture(undefined, async (expected) => ({
    privatePaymentSessionId: expected.privatePaymentSessionId,
    status: 'requires_customer_action',
    providerCheckoutUrl: 'https://unapproved.example/hosted?token=fresh-secret',
    amountMinor: expected.amountMinor,
    currency: expected.currency,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }));
  const publicId = await createHostedPaymentSession(app, 'pay-invalid-host');
  const before = await repo.getPaymentSession(publicId);

  const redirect = await app.request(`/s/${publicId}`, { redirect: 'manual' });

  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get('location'), null);
  const error = (await redirect.json()) as {
    error: { code: string; details: { retryable: boolean } };
  };
  assert.equal(error.error.code, 'invalid_checkout_destination');
  assert.equal(error.error.details.retryable, false);
  assert.equal(refreshCalls(), 1);
  const after = await repo.getPaymentSession(publicId);
  assert.equal(after?.encryptedProviderCheckoutUrl, before?.encryptedProviderCheckoutUrl);
  assert.equal(repo.paymentSessionCheckoutRefreshLeases.has(publicId), false);
});

test('Paely refresh failure is safely classified, logged without secrets, and never redirects', async () => {
  const oldCapability = 'expired-token';
  const tracker = 'existing-tracker';
  const { app, repo, refreshCalls } = fixture(undefined, async () => {
    throw new PrivateDependencyError(true, 503, {
      operation: 'payment_session_refresh',
      failureKind: 'http',
      downstreamRequestId: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      providerRequestId: 'provider-refresh-request',
      attempts: 3,
    });
  });
  const publicId = await createHostedPaymentSession(app, 'pay-refresh-failure');
  const before = await repo.getPaymentSession(publicId);
  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  let redirect: Response;
  try {
    redirect = await app.request(`/s/${publicId}`, { redirect: 'manual' });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(redirect.status, 503);
  assert.equal(redirect.headers.get('location'), null);
  const body = (await redirect.json()) as {
    error: { code: string; details: { retryable: boolean } };
  };
  assert.equal(body.error.code, 'dependency_unavailable');
  assert.equal(body.error.details.retryable, true);
  assert.equal(refreshCalls(), 1);
  assert.equal(
    (await repo.getPaymentSession(publicId))?.encryptedProviderCheckoutUrl,
    before?.encryptedProviderCheckoutUrl,
  );
  assert.equal(repo.paymentSessionCheckoutRefreshLeases.has(publicId), false);
  assert.equal(logs.length, 1);
  assert(logs[0]!.includes('payment_session_refresh'));
  assert(!logs[0]!.includes(oldCapability));
  assert(!logs[0]!.includes(tracker));
  assert(!logs[0]!.includes('private-session-hidden'));
});

test('concurrent checkout redirects make one refresh call and never overwrite each other', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { app, refreshCalls, privateCalls } = fixture(undefined, async (expected) => {
    entered();
    await gate;
    return {
      privatePaymentSessionId: expected.privatePaymentSessionId,
      status: 'requires_customer_action',
      providerCheckoutUrl:
        'https://checkout.example/hosted?tracker=existing-tracker&token=concurrent-fresh',
      amountMinor: expected.amountMinor,
      currency: expected.currency,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  });
  const publicId = await createHostedPaymentSession(app, 'pay-concurrent-refresh');

  const firstPromise = app.request(`/s/${publicId}`, { redirect: 'manual' });
  await started;
  const second = await app.request(`/s/${publicId}`, { redirect: 'manual' });

  assert.equal(second.status, 503);
  assert.equal(second.headers.get('location'), null);
  assert.equal(
    ((await second.json()) as { error: { details: { retryable: boolean } } }).error.details
      .retryable,
    true,
  );
  assert.equal(refreshCalls(), 1);
  assert.equal(privateCalls(), 1);
  release();
  const first = await firstPromise;
  assert.equal(first.status, 303);
  assert.equal(
    first.headers.get('location'),
    'https://checkout.example/hosted?tracker=existing-tracker&token=concurrent-fresh',
  );
});

test('checkout refresh lease migration serializes URL replacement without financial writes', () => {
  const migration = readFileSync(
    new URL(
      '../../../supabase/migrations/20260727000100_payment_session_checkout_refresh.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /claim_payment_session_checkout_refresh/);
  assert.match(migration, /complete_payment_session_checkout_refresh/);
  assert.match(migration, /release_payment_session_checkout_refresh/);
  assert.match(migration, /checkout_refresh_lock_token = p_lock_token/);
  assert.match(
    migration,
    /private_payment_session_reference = p_private_payment_session_reference/,
  );
  assert.match(migration, /encrypted_provider_checkout_url = p_encrypted_provider_checkout_url/);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.(?:payments|bill_mappings)/i);
  assert.doesNotMatch(migration, /delete\s+from/i);
});

test('private event migration validates both identifier namespaces before inbox insertion', () => {
  const migration = readFileSync(
    new URL(
      '../../../supabase/migrations/20260731000100_private_event_identifier_validation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const predicate of [
    'paely_connection_mapping_not_found',
    'paely_location_mapping_not_found',
    'connection_reference_mismatch',
    'location_reference_mismatch',
    'payment_session_reference_mismatch',
    'external_bill_reference_mismatch',
    'amount_mismatch',
    'payment_method_mismatch',
    'payment_status_mismatch',
  ])
    assert.match(migration, new RegExp(predicate));
  assert.match(migration, /private_connection_reference=.*connection_id/);
  assert.match(migration, /private_location_reference=.*location_id/);
  assert.ok(
    migration.indexOf('paely_connection_mapping_not_found') <
      migration.indexOf('insert into public.private_event_inbox'),
  );
  assert.ok(
    migration.indexOf('location_reference_mismatch') <
      migration.indexOf('insert into public.private_event_inbox'),
  );
});

test('concurrent duplicate creation makes one private call', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { app, privateCalls } = fixture(async () => {
    entered();
    await gate;
    return {
      privatePaymentSessionId: 'private-session-hidden',
      status: 'requires_customer_action',
      providerCheckoutUrl: 'https://checkout.example/hosted/token-hidden',
      amountMinor: 10_000,
      currency: 'PKR',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  });
  const path = '/v1/locations/loc_test/bills/BILL-1/payment-sessions';
  const body = JSON.stringify({ amount_minor: 10_000, currency: 'PKR', method: 'card' });
  const firstPromise = app.request(path, {
    method: 'POST',
    headers: {
      ...signed(path, 'POST', body, 'req_payment_concurrent_1'),
      'Idempotency-Key': 'pay-concurrent',
    },
    body,
  });
  await started;
  const second = await app.request(path, {
    method: 'POST',
    headers: {
      ...signed(path, 'POST', body, 'req_payment_concurrent_2'),
      'Idempotency-Key': 'pay-concurrent',
    },
    body,
  });
  assert.equal(second.status, 409);
  assert.equal(privateCalls(), 1);
  release();
  assert.equal((await firstPromise).status, 201);
});

test('checkout destination validation rejects open-redirect and local-network forms', () => {
  const allowed = new Set(['checkout.example']);
  assert.equal(
    assertCheckoutDestination('https://checkout.example/path', allowed).hostname,
    'checkout.example',
  );
  for (const value of [
    'http://checkout.example/path',
    'https://user:pass@checkout.example/path',
    'https://localhost/path',
    'https://127.0.0.1/path',
    'https://10.0.0.1/path',
    'https://unlisted.example/path',
    'ftp://checkout.example/path',
  ])
    assert.throws(() => assertCheckoutDestination(value, allowed), value);
});

test('checkout destination rejects a trusted hostname resolving to a private address', async () => {
  await assert.rejects(() =>
    assertResolvedCheckoutDestination(
      'https://checkout.example/path',
      new Set(['checkout.example']),
      async () => [{ address: '192.168.1.10', family: 4 }],
    ),
  );
});

test('cardholder fields are rejected and disabled payment routes are isolated', async () => {
  const { app } = fixture();
  const path = '/v1/locations/loc_test/bills/BILL-1/payment-sessions';
  const body = JSON.stringify({
    amount_minor: 10_000,
    currency: 'PKR',
    method: 'card',
    card_number: 'never-accepted',
  });
  const rejected = await app.request(path, {
    method: 'POST',
    headers: { ...signed(path, 'POST', body, 'req_payment_card_data'), 'Idempotency-Key': 'pay-2' },
    body,
  });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(await rejected.json()).includes('never-accepted'), false);

  const disabled = createApp({
    repository: (() => {
      const repository = new MemoryRepository();
      repository.credentials.set('rst_live_bbbbbbbbbbbbexample', {
        partnerId: 'ptr_live',
        environment: 'production',
        signingSecret: requestSecret,
        status: 'active',
        keyPrefix: 'bbbbbbbbbbbb',
      });
      return repository;
    })(),
    privateClient: {
      createPaymentSession: () => assert.fail('must not call private service'),
    } as any,
    config: { ...enabledConfig, RESTEC_ENV: 'production', RESTEC_PAYMENT_SESSIONS_ENABLED: false },
    eventSigningSecret: 'event-secret',
    internalJobToken: 'job-secret',
  });
  const disabledPath = '/v1/locations/loc_live/bills/BILL-1/payment-sessions';
  const disabledBody = JSON.stringify({ amount_minor: 100, currency: 'PKR', method: 'card' });
  const disabledTimestamp = Math.floor(Date.now() / 1000);
  const disabledHeaders = {
    Authorization: 'Bearer rst_live_bbbbbbbbbbbbexample',
    'Content-Type': 'application/json',
    'X-Restec-Environment': 'production',
    'X-Restec-Timestamp': String(disabledTimestamp),
    'X-Restec-Signature': signRequest(
      requestSecret,
      disabledTimestamp,
      'POST',
      disabledPath,
      disabledBody,
    ),
    'X-Request-Id': 'req_disabled_payment_post',
    'Idempotency-Key': 'disabled-payment',
  };
  assert.equal(
    (
      await disabled.request(disabledPath, {
        method: 'POST',
        headers: disabledHeaders,
        body: disabledBody,
      })
    ).status,
    404,
  );
  const disabledGetPath = '/v1/locations/loc_live/payment-sessions/rps_live_disabled_example';
  const disabledGetTimestamp = Math.floor(Date.now() / 1000);
  assert.equal(
    (
      await disabled.request(disabledGetPath, {
        headers: {
          Authorization: 'Bearer rst_live_bbbbbbbbbbbbexample',
          'Content-Type': 'application/json',
          'X-Restec-Environment': 'production',
          'X-Restec-Timestamp': String(disabledGetTimestamp),
          'X-Restec-Signature': signRequest(
            requestSecret,
            disabledGetTimestamp,
            'GET',
            disabledGetPath,
            '',
          ),
          'X-Request-Id': 'req_disabled_payment_get',
        },
      })
    ).status,
    404,
  );
  assert.equal((await disabled.request('/s/rps_live_example')).status, 404);
  assert.equal(
    (
      await disabled.request('/api/test/mock-pos-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    404,
  );
});

test('authoritative event wins, deduplicates, updates the bill, and dummy POS verifies it', async () => {
  const { app, repo } = fixture();
  const createPath = '/v1/locations/loc_test/bills/BILL-1/payment-sessions';
  const createBody = JSON.stringify({ amount_minor: 10_000, currency: 'PKR', method: 'card' });
  const created = await app.request(createPath, {
    method: 'POST',
    headers: {
      ...signed(createPath, 'POST', createBody, 'req_payment_event_create'),
      'Idempotency-Key': 'pay-event',
    },
    body: createBody,
  });
  const publicId = ((await created.json()) as any).payment_session_id;
  await app.request(`/s/${publicId}/cancel`);
  assert.equal((await repo.getPaymentSession(publicId))?.status, 'requires_customer_action');

  const eventBody = JSON.stringify({
    id: 'private-payment-event-1',
    type: 'payment.completed',
    schema_version: '2026-07-01',
    created_at: new Date().toISOString(),
    data: {
      connection_id: '00000000-0000-4000-8000-000000000001',
      location_id: '00000000-0000-4000-8000-000000000002',
      external_bill_id: 'BILL-1',
      external_table_id: 'T1',
      payment: {
        payment_id: 'private-payment-hidden',
        amount: 10_000,
        currency: 'PKR',
        method: 'card',
        status: 'completed',
      },
      payment_session: {
        private_payment_session_id: 'private-session-hidden',
        restec_payment_session_reference: publicId,
        status: 'paid',
      },
      bill: {
        grand_total: 10_000,
        amount_paid: 10_000,
        amount_refunded: 0,
        amount_due: 0,
        payment_status: 'paid',
        version: 1,
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const eventHeaders = {
    'Content-Type': 'application/json',
    'X-Paely-Event-Id': 'private-payment-event-1',
    'X-Paely-Service-Id': 'financial-core',
    'X-Paely-Environment': 'sandbox',
    'X-Paely-Timestamp': String(timestamp),
    'X-Paely-Signature': signEvent('event-secret', timestamp, eventBody),
    'X-Paely-Delivery-Attempt': '1',
  };
  const accepted = await app.request('/api/internal/events/paely/v1', {
    method: 'POST',
    headers: eventHeaders,
    body: eventBody,
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const duplicate = await app.request('/api/internal/events/paely/v1', {
    method: 'POST',
    headers: eventHeaders,
    body: eventBody,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(repo.events.size, 1);
  assert.equal(repo.outbox.size, 1);
  assert.equal((await repo.getPaymentSession(publicId))?.status, 'paid');
  assert.equal((await repo.getBill('con_test', 'BILL-1'))?.payment_status, 'paid');

  const publicEvent = repo.outbox.values().next().value!;
  const publicBody = JSON.stringify(publicEvent.payload);
  assert.equal(publicBody.includes('private-payment-hidden'), false);
  const receiptTimestamp = Math.floor(Date.now() / 1000);
  const receiptHeaders = {
    'Content-Type': 'application/json',
    'X-Restec-Event-Id': publicEvent.publicEventId,
    'X-Restec-Environment': 'sandbox',
    'X-Restec-Timestamp': String(receiptTimestamp),
    'X-Restec-Signature': signEvent(webhookSecret, receiptTimestamp, publicBody),
  };
  const invalidReceipt = await app.request('/api/test/mock-pos-webhook', {
    method: 'POST',
    headers: {
      ...receiptHeaders,
      'X-Restec-Signature': signEvent('wrong', receiptTimestamp, publicBody),
    },
    body: publicBody,
  });
  assert.equal(invalidReceipt.status, 401);
  const staleTimestamp = receiptTimestamp - 1000;
  const staleReceipt = await app.request('/api/test/mock-pos-webhook', {
    method: 'POST',
    headers: {
      ...receiptHeaders,
      'X-Restec-Timestamp': String(staleTimestamp),
      'X-Restec-Signature': signEvent(webhookSecret, staleTimestamp, publicBody),
    },
    body: publicBody,
  });
  assert.equal(staleReceipt.status, 401);
  const receipt = await app.request('/api/test/mock-pos-webhook', {
    method: 'POST',
    headers: receiptHeaders,
    body: publicBody,
  });
  assert.equal(receipt.status, 204, await receipt.clone().text());
  const receiptReplay = await app.request('/api/test/mock-pos-webhook', {
    method: 'POST',
    headers: receiptHeaders,
    body: publicBody,
  });
  assert.equal(receiptReplay.status, 204);
  assert.equal(repo.mockPosReceipts.size, 1);
});

test('mapped Paely identifiers strictly accept the real expired-event namespaces', async () => {
  const publicSessionId = 'rps_test_1cf36a50b061fddd7eecd80375';
  const publicConnectionId = 'con_sandbox_canonical';
  const privateConnectionId = '10000000-0000-4000-8000-000000000201';
  const publicLocationId = 'loc_sandbox_demo';
  const privateLocationId = '10000000-0000-4000-8000-000000000001';
  const externalBillId = 'CERT-ms3jl1ru-f8b308d6';
  const repo = new MemoryRepository();
  const connection = {
    connectionId: publicConnectionId,
    partnerId: 'ptr_sandbox_demo',
    locationId: publicLocationId,
    environment: 'sandbox' as const,
    connectorType: 'mock_pos',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId,
    privateConnectionId,
    configuration: {},
  };
  repo.connections.set(publicConnectionId, connection);
  repo.connections.set('con_sandbox_other', {
    ...connection,
    connectionId: 'con_sandbox_other',
    locationId: 'loc_sandbox_other',
    privateConnectionId: '10000000-0000-4000-8000-000000000202',
    privateLocationId: '10000000-0000-4000-8000-000000000002',
  });
  repo.bills.set(`${publicConnectionId}:${externalBillId}`, {
    request_id: 'req_exact_fixture',
    restec_bill_id: 'bil_exact_fixture',
    external_bill_id: externalBillId,
    external_table_id: 'TABLE-1',
    sync_status: 'accepted',
    order_status: 'accepted',
    payment_status: 'unpaid',
    table_session_status: 'dining',
    currency: 'PKR',
    grand_total: 10_000,
    amount_paid: 0,
    amount_refunded: 0,
    amount_due: 10_000,
    version: 1,
    reconciliation_status: 'matched',
    updated_at: new Date().toISOString(),
  });
  const session = {
    id: '00000000-0000-4000-8000-000000000301',
    publicPaymentSessionId: publicSessionId,
    environment: 'sandbox' as const,
    partnerId: 'ptr_sandbox_demo',
    connectionId: publicConnectionId,
    locationId: publicLocationId,
    externalBillId,
    privateLocationReference: privateLocationId,
    privateConnectionReference: privateConnectionId,
    privatePaymentSessionReference: 'paely-session-exact',
    method: 'card' as const,
    amountMinor: 10_000,
    currency: 'PKR' as const,
    status: 'requires_customer_action' as const,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: 'exact-fixture',
    requestFingerprint: 'exact-fixture',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  repo.paymentSessions.set(publicSessionId, session);
  const app = createApp({
    repository: repo,
    privateClient: {} as never,
    config: enabledConfig,
    eventSigningSecret: 'event-secret',
    internalJobToken: 'job-secret',
  });
  const baseEvent = {
    id: 'ef8948f1-6220-4246-b865-f1813a45a527',
    type: 'payment.expired',
    schema_version: '2026-07-01',
    created_at: new Date().toISOString(),
    data: {
      connection_id: privateConnectionId,
      location_id: privateLocationId,
      external_bill_id: externalBillId,
      external_table_id: 'TABLE-1',
      payment: {
        payment_id: 'paely-payment-exact',
        amount: 10_000,
        currency: 'PKR',
        method: 'card',
        status: 'failed',
      },
      payment_session: {
        private_payment_session_id: 'paely-session-exact',
        restec_payment_session_reference: publicSessionId,
        status: 'expired',
      },
      bill: {
        grand_total: 10_000,
        amount_paid: 0,
        amount_refunded: 0,
        amount_due: 10_000,
        payment_status: 'failed',
        version: 1,
      },
    },
  };
  let eventSequence = 0;
  const deliver = async (mutate: (event: any) => void = () => {}, sameId = false) => {
    const event = structuredClone(baseEvent);
    mutate(event);
    if (!sameId)
      event.id = `${baseEvent.id.slice(0, -2)}${String(eventSequence++).padStart(2, '0')}`;
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    return app.request('/api/internal/events/paely/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paely-Event-Id': event.id,
        'X-Paely-Service-Id': 'financial-core',
        'X-Paely-Environment': 'sandbox',
        'X-Paely-Timestamp': String(timestamp),
        'X-Paely-Signature': signEvent('event-secret', timestamp, body),
        'X-Paely-Delivery-Attempt': '1',
      },
      body,
    });
  };
  const rejectionCode = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error.code;

  const accepted = await deliver(() => {}, true);
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal(repo.events.size, 1);
  assert.equal(repo.outbox.size, 1);
  assert.equal((await repo.getPaymentSession(publicSessionId))?.status, 'expired');
  const duplicate = await deliver(() => {}, true);
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  assert.equal(repo.events.size, 1);
  assert.equal(repo.outbox.size, 1);

  assert.equal(
    await rejectionCode(
      await deliver((event) => {
        event.data.connection_id = '10000000-0000-4000-8000-000000000299';
      }),
    ),
    'paely_connection_mapping_not_found',
  );
  assert.equal(
    await rejectionCode(
      await deliver((event) => {
        event.data.location_id = '10000000-0000-4000-8000-000000000099';
      }),
    ),
    'paely_location_mapping_not_found',
  );
  assert.equal(
    await rejectionCode(
      await deliver((event) => {
        event.data.connection_id = '10000000-0000-4000-8000-000000000202';
      }),
    ),
    'connection_reference_mismatch',
  );
  assert.equal(
    await rejectionCode(
      await deliver((event) => {
        event.data.location_id = '10000000-0000-4000-8000-000000000002';
      }),
    ),
    'location_reference_mismatch',
  );
  for (const [mutate, expected] of [
    [
      (event: any) => (event.data.external_bill_id = 'OTHER-BILL'),
      'external_bill_reference_mismatch',
    ],
    [(event: any) => (event.data.payment.amount = 9_999), 'amount_mismatch'],
    [(event: any) => (event.data.payment.currency = 'USD'), 'amount_mismatch'],
    [(event: any) => (event.data.payment.method = 'cash'), 'payment_method_mismatch'],
    [
      (event: any) => (event.data.payment_session.private_payment_session_id = 'other-session'),
      'payment_session_reference_mismatch',
    ],
  ] as const) {
    assert.equal(await rejectionCode(await deliver(mutate)), expected);
  }
  assert.equal(repo.events.size, 1, 'rejected associations must not reach the durable inbox');
});
