import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { sha256 } from '@restec/security';
import { createApp } from './app.js';
import { MemoryRepository } from './memory-repository.js';
import type { Config } from './config.js';

const config: Config = {
  NODE_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_ENV: 'test' as const,
  RESTEC_PUBLIC_BASE_URL: 'http://localhost',
  RESTEC_PAYMENT_SESSIONS_ENABLED: false,
  RESTEC_PAYMENT_SESSION_TTL_SECONDS: 900,
  RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS: '',
  RESTEC_PAYMENT_SESSION_RETURN_POLL_SECONDS: 2,
  RESTEC_TIMESTAMP_TOLERANCE_SECONDS: 300,
  RESTEC_PRIVATE_REQUEST_TIMEOUT_MS: 1000,
  RESTEC_POS_DELIVERY_TIMEOUT_MS: 1000,
  RESTEC_MAX_DELIVERY_ATTEMPTS: 3,
  RESTEC_DISPATCH_BATCH_SIZE: 10,
  PAELY_PRIVATE_BASE_URL: 'https://private.example',
  PAELY_SERVICE_ID: 'service',
  PAELY_PRIVATE_BEARER_TOKEN: '1234567890123456',
  PAELY_PRIVATE_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SERVICE_ID: 'paely',
  RESTEC_API_KEY_HASH_SECRET: '12345678901234567890123456789012',
  RESTEC_SECRET_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  RESTEC_INTERNAL_JOB_TOKEN: '1234567890123456',
  RESTEC_STRICT_RATE_LIMITING: false,
};
const bill = (id: string) => ({
  request_id: 'req_test',
  restec_bill_id: `bil_${id}`,
  external_bill_id: id,
  external_table_id: 'T1',
  sync_status: 'accepted' as const,
  order_status: 'open',
  payment_status: 'unpaid',
  table_session_status: 'dining',
  currency: 'PKR',
  grand_total: 100,
  amount_paid: 0,
  amount_refunded: 0,
  amount_due: 100,
  version: 1,
  reconciliation_status: 'matched',
  updated_at: new Date().toISOString(),
});

const setup = async () => {
  const repo = new MemoryRepository();
  repo.tables.set('t1', {
    connection_id: 'con_1',
    table_id: 'tbl_1',
    external_table_id: 'T1',
    name: 'Table 1',
    active: true,
  });
  const token = randomBytes(32).toString('base64url');
  await repo.provisionTableQr('con_1', 'T1', sha256(token), 'sandbox');
  const app = createApp({
    repository: repo,
    privateClient: {} as never,
    config,
    eventSigningSecret: 'x',
    internalJobToken: 'job',
  });
  return { repo, app, token };
};

test('table QR creates bill-pinned visits with private cache controls', async () => {
  const { repo, app, token } = await setup();
  repo.bills.set('con_1:A', bill('A'));
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'A',
    version: 1,
    terminal: false,
  });
  const entry = await app.request(`/t/${token}`, { redirect: 'manual' });
  assert.equal(entry.status, 303);
  assert.match(entry.headers.get('cache-control')!, /no-store/);
  const oldVisit = new URL(entry.headers.get('location')!).pathname;
  assert.match(await (await app.request(oldVisit)).text(), /Amount due: 100 PKR/);
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'A',
    version: 2,
    terminal: true,
  });
  repo.bills.set('con_1:B', { ...bill('B'), amount_due: 77, grand_total: 77 });
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'B',
    version: 1,
    terminal: false,
  });
  assert.match(await (await app.request(oldVisit)).text(), /visit has ended/);
  assert.doesNotMatch(await (await app.request(oldVisit)).text(), /77 PKR/);
  const newEntry = await app.request(`/t/${token}`, { redirect: 'manual' });
  assert.match(
    await (await app.request(new URL(newEntry.headers.get('location')!).pathname)).text(),
    /77 PKR/,
  );
});

test('table lifecycle rejects competing and reopened stale bills across 500 generations', async () => {
  const { repo } = await setup();
  for (let i = 0; i < 500; i++) {
    const id = `B${i}`;
    repo.bills.set(`con_1:${id}`, bill(id));
    await repo.syncTableLifecycle({
      connectionId: 'con_1',
      locationId: 'loc_1',
      environment: 'sandbox',
      externalTableId: 'T1',
      externalBillId: id,
      version: 1,
      terminal: false,
    });
    await repo.syncTableLifecycle({
      connectionId: 'con_1',
      locationId: 'loc_1',
      environment: 'sandbox',
      externalTableId: 'T1',
      externalBillId: id,
      version: 2,
      terminal: true,
    });
  }
  await assert.rejects(
    () =>
      repo.syncTableLifecycle({
        connectionId: 'con_1',
        locationId: 'loc_1',
        environment: 'sandbox',
        externalTableId: 'T1',
        externalBillId: 'B0',
        version: 3,
        terminal: false,
      }),
    /bill_table_generation_conflict/,
  );
  repo.bills.set('con_1:C', bill('C'));
  repo.bills.set('con_1:D', bill('D'));
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'C',
    version: 1,
    terminal: false,
  });
  await assert.rejects(
    () =>
      repo.syncTableLifecycle({
        connectionId: 'con_1',
        locationId: 'loc_1',
        environment: 'sandbox',
        externalTableId: 'T1',
        externalBillId: 'D',
        version: 1,
        terminal: false,
      }),
    /table_active_bill_conflict/,
  );
});

test('historical visits across 500 generations never resolve the current guest bill', async () => {
  const { repo, app, token } = await setup();
  const retained = new Map<number, string>();
  for (let i = 0; i < 500; i++) {
    const id = `H${i}`;
    repo.bills.set(`con_1:${id}`, {
      ...bill(id),
      grand_total: i + 1,
      amount_due: i + 1,
    });
    await repo.syncTableLifecycle({
      connectionId: 'con_1',
      locationId: 'loc_1',
      environment: 'sandbox',
      externalTableId: 'T1',
      externalBillId: id,
      version: 1,
      terminal: false,
    });
    if ([1, 2, 5, 25, 100, 250, 499].includes(i)) {
      const scan = await app.request(`/t/${token}`, { redirect: 'manual' });
      retained.set(i, new URL(scan.headers.get('location')!).pathname);
    }
    if (i < 499)
      await repo.syncTableLifecycle({
        connectionId: 'con_1',
        locationId: 'loc_1',
        environment: 'sandbox',
        externalTableId: 'T1',
        externalBillId: id,
        version: 2,
        terminal: true,
      });
  }
  for (const [generation, visit] of retained) {
    const body = await (await app.request(visit)).text();
    if (generation === 499) assert.match(body, /Amount due: 500 PKR/);
    else {
      assert.match(body, /visit has ended/);
      assert.doesNotMatch(body, /500 PKR/);
    }
  }
});

test('disabled connection fails closed for new scans and existing visits', async () => {
  const { repo, app, token } = await setup();
  repo.connections.set('con_1', { connectorEnabled: true } as any);
  repo.bills.set('con_1:A', bill('A'));
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'A',
    version: 1,
    terminal: false,
  });
  const scan = await app.request(`/t/${token}`, { redirect: 'manual' });
  const visit = new URL(scan.headers.get('location')!).pathname;
  repo.connections.set('con_1', { connectorEnabled: false } as any);
  assert.match(await (await app.request(`/t/${token}`)).text(), /unavailable/);
  assert.match(await (await app.request(visit)).text(), /unavailable/);
});

test('terminal table lifecycle cannot hide a bill with protected payment capacity', async () => {
  const { repo } = await setup();
  repo.bills.set('con_1:A', bill('A'));
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'A',
    version: 1,
    terminal: false,
  });
  repo.financialReservations.set('con_1:digital:A', {
    connectionId: 'con_1',
    externalBillId: 'A',
    reservationIdentity: 'digital:A',
    channel: 'digital_session',
    amountMinor: 100,
    currency: 'PKR',
    requestHash: 'x',
    state: 'reserved',
  });
  await assert.rejects(
    () =>
      repo.syncTableLifecycle({
        connectionId: 'con_1',
        locationId: 'loc_1',
        environment: 'sandbox',
        externalTableId: 'T1',
        externalBillId: 'A',
        version: 2,
        terminal: true,
      }),
    /payment_in_progress/,
  );
  assert.equal(
    (await repo.resolveTableQr(sha256('x'.repeat(43)), 'sandbox')).status,
    'invalid_link',
  );
  assert.equal([...repo.tableSessions.values()].filter((v) => v.active).length, 1);
});

test('customer page escapes a table display name', async () => {
  const { repo, app, token } = await setup();
  repo.tables.get('t1').name = '<img src=x onerror=alert(1)>';
  repo.bills.set('con_1:A', bill('A'));
  await repo.syncTableLifecycle({
    connectionId: 'con_1',
    locationId: 'loc_1',
    environment: 'sandbox',
    externalTableId: 'T1',
    externalBillId: 'A',
    version: 1,
    terminal: false,
  });
  const entry = await app.request(`/t/${token}`, { redirect: 'manual' });
  const body = await (await app.request(new URL(entry.headers.get('location')!).pathname)).text();
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(body, /<img src=x/);
});
