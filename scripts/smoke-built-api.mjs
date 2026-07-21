import assert from 'node:assert/strict';
import { once } from 'node:events';
import process from 'node:process';

Object.assign(process.env, {
  NODE_ENV: 'test',
  RESTEC_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  PAELY_PRIVATE_BASE_URL: 'https://private.example.invalid',
  PAELY_SERVICE_ID: 'runtime-smoke',
  PAELY_PRIVATE_BEARER_TOKEN: 'runtime-smoke-bearer-token',
  PAELY_PRIVATE_SIGNING_SECRET: 'runtime-smoke-request-secret',
  PAELY_EVENT_SIGNING_SECRET: 'runtime-smoke-event-secret',
  RESTEC_API_KEY_HASH_SECRET: 'runtime-smoke-api-hash-secret-000000000000',
  RESTEC_SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  RESTEC_INTERNAL_JOB_TOKEN: 'runtime-smoke-job-token',
});

const [{ PaelyClient }, { RepositoryError }, { ConnectorRegistry }, security, { app }] =
  await Promise.all([
    import('@restec/paely-client'),
    import('@restec/database'),
    import('@restec/connector-registry'),
    import('@restec/security'),
    import('../apps/api/dist/bootstrap.js'),
  ]);

assert.equal(typeof PaelyClient, 'function', 'Paely client failed to import');
assert.equal(typeof RepositoryError, 'function', 'Repository package failed to import');
assert.equal(typeof ConnectorRegistry, 'function', 'Connector packages failed to import');
assert.equal(typeof security.verifyRequestSignature, 'function', 'Authentication failed to import');
assert.equal(
  typeof security.verifyEventSignature,
  'function',
  'Event verification failed to import',
);

const health = await app.request('/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok', environment: 'test', version: '1.0.0' });

const eventReceiver = await app.request('/api/internal/events/paely/v1', { method: 'POST' });
assert.equal(eventReceiver.status, 400, 'Paely event receiver route did not start');

const dispatchJob = await app.request('/api/internal/jobs/dispatch-pos-events', { method: 'POST' });
assert.equal(dispatchJob.status, 404, 'Dispatch job route did not start');

const reconciliationJob = await app.request('/api/internal/jobs/reconcile', { method: 'POST' });
assert.equal(reconciliationJob.status, 404, 'Reconciliation job route did not start');

const { serve } = await import('@hono/node-server');
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const networkHealth = await globalThis.fetch(`http://127.0.0.1:${address.port}/health`);
const networkBody = await networkHealth.json();
await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve(undefined))),
);
assert.equal(networkHealth.status, 200);
assert.deepEqual(networkBody, { status: 'ok', environment: 'test', version: '1.0.0' });

process.stdout.write(
  `Built API startup smoke passed: packages, authentication, event receiver, jobs, and HTTP GET /health -> ${networkHealth.status} ${JSON.stringify(networkBody)}.\n`,
);
