import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ZodError, z } from 'zod';
import { billSchema, eventSchema, externalPaymentSchema } from '@restec/contracts';
import { derivePrivateIdempotencyKey, type PaelyClient } from '@restec/paely-client';
import { sha256, verifyEventSignature, verifyTimestamp } from '@restec/security';
import { ConnectorRegistry } from '@restec/connector-registry';
import { assertSafeWebhookUrl, retryDelaySeconds } from '@restec/webhook-delivery';
import type { RateLimiter } from '@restec/rate-limiting';
import { ReconciliationService } from './reconciliation.js';
import type { Config } from './config.js';
import { publicAuth, requestHash } from './auth.js';
import { ApiError, type Repository } from './types.js';
const parseRaw = (raw: Uint8Array) => JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
const privateEvent = z
  .object({
    id: z.string().min(1),
    type: z.enum(['payment.completed', 'payment.failed', 'payment.refunded']),
    schema_version: z.string(),
    created_at: z.string().datetime(),
    data: z.object({
      connection_id: z.string().uuid(),
      location_id: z.string().uuid(),
      external_bill_id: z.string(),
      external_table_id: z.string(),
      payment: z.object({
        payment_id: z.string(),
        amount: z.number().int().nonnegative(),
        currency: z.string(),
        method: z.string(),
        status: z.string(),
      }),
      bill: z.object({
        grand_total: z.number().int().nonnegative(),
        amount_paid: z.number().int().nonnegative(),
        amount_refunded: z.number().int().nonnegative(),
        amount_due: z.number().int().nonnegative(),
        payment_status: z.string(),
        version: z.number().int().positive(),
      }),
    }),
  })
  .strict();
export function createApp(deps: {
  repository: Repository;
  privateClient: PaelyClient;
  config: Config;
  eventSigningSecret: string;
  internalJobToken: string;
  connectorRegistry?: ConnectorRegistry;
  rateLimiter?: RateLimiter;
}) {
  const registry = deps.connectorRegistry ?? new ConnectorRegistry();
  const reconciliation = new ReconciliationService(deps.repository, deps.privateClient);
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({ status: 'ok', environment: deps.config.RESTEC_ENV, version: '0.1.0' }),
  );
  const api = new Hono();
  api.use('/v1/*', publicAuth(deps.repository, deps.config, deps.rateLimiter));
  const connection = async (c: any) => {
    const credential = c.get('credential');
    const found = await deps.repository.authorizeLocation(
      c.req.param('locationId'),
      credential.partnerId,
      deps.config.RESTEC_ENV === 'production' ? 'production' : 'sandbox',
    );
    if (!found) throw new ApiError(403, 'access_denied', 'Access to this location is denied.');
    return found;
  };
  const idempotent = async (c: any, operation: string, work: (key: string) => Promise<unknown>) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) throw new ApiError(400, 'invalid_request', 'An idempotency key is required.');
    const path = new URL(c.req.url).pathname;
    const begin = await deps.repository.reserveIdempotency(c.get('credential').partnerId, key, {
      requestHash: requestHash(c.req.method, path, c.get('rawBody')),
      method: c.req.method,
      path,
    });
    if (begin.kind === 'conflict')
      throw new ApiError(
        409,
        'idempotency_conflict',
        'This idempotency key was used with different request content.',
      );
    if (begin.kind === 'processing')
      throw new ApiError(409, 'idempotency_conflict', 'The matching request is still processing.', {
        retryable: true,
      });
    if (begin.kind === 'replay')
      return c.json(begin.result.responseBody as any, begin.result.responseStatus as any);
    try {
      const result = await work(
        derivePrivateIdempotencyKey(c.get('credential').partnerId, key, operation),
      );
      await deps.repository.completeIdempotency(c.get('credential').partnerId, key, 200, result);
      return c.json(result as any);
    } catch (error) {
      await deps.repository.releaseIdempotency(c.get('credential').partnerId, key);
      throw error;
    }
  };
  api.put('/v1/locations/:locationId/bills/:externalBillId', async (c) =>
    idempotent(c, 'bill_upsert', async (privateKey) => {
      const con = await connection(c);
      const body = billSchema.parse(parseRaw(c.get('rawBody')));
      const privateResult = await deps.privateClient.upsertBillDetailed(
        con.privateLocationId,
        c.req.param('externalBillId'),
        body,
        privateKey,
      );
      const result = {
        request_id: c.get('requestId'),
        restec_bill_id: `bil_${sha256(`${con.connectionId}:${c.req.param('externalBillId')}`).slice(0, 24)}`,
        ...privateResult.publicState,
      };
      return deps.repository.saveBillState(
        con.connectionId,
        c.req.param('externalBillId'),
        body,
        result as any,
        requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody')),
        privateResult.privateBillReference,
      );
    }),
  );
  api.get('/v1/locations/:locationId/bills/:externalBillId', async (c) => {
    const con = await connection(c);
    const value = await deps.repository.getBill(con.connectionId, c.req.param('externalBillId'));
    if (!value) throw new ApiError(404, 'resource_not_found', 'The requested bill was not found.');
    return c.json(value as any);
  });
  api.post('/v1/locations/:locationId/bills/:externalBillId/external-payments', async (c) =>
    idempotent(c, 'external_payment', async (privateKey) => {
      const con = await connection(c);
      const body = externalPaymentSchema.parse(parseRaw(c.get('rawBody')));
      const state = await deps.privateClient.recordExternalPayment(
        con.privateLocationId,
        c.req.param('externalBillId'),
        body,
        privateKey,
      );
      const result = {
        request_id: c.get('requestId'),
        restec_bill_id: `bil_${sha256(`${con.connectionId}:${c.req.param('externalBillId')}`).slice(0, 24)}`,
        ...state,
      };
      return deps.repository.saveExternalPayment(
        con.connectionId,
        c.req.param('externalBillId'),
        body,
        result as any,
        requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody')),
      );
    }),
  );
  api.get('/v1/locations/:locationId/tables', async (c) => {
    const con = await connection(c);
    return c.json({
      request_id: c.get('requestId'),
      data: await deps.repository.listTables(con.connectionId),
    });
  });
  api.post('/v1/test/scenarios', async (c) => {
    if (deps.config.RESTEC_ENV === 'production')
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    const body = z
      .object({
        location_id: z.string(),
        scenario: z.enum([
          'payment.completed',
          'payment.failed',
          'payment.refunded',
          'partial_payment.completed',
          'duplicate_event',
          'delayed_event',
          'out_of_order_event',
          'webhook_timeout',
          'webhook_429',
          'webhook_500',
          'amount_mismatch',
          'bill_already_paid',
        ]),
      })
      .strict()
      .parse(parseRaw(c.get('rawBody')));
    const con = await deps.repository.authorizeLocation(
      body.location_id,
      c.get('credential').partnerId,
      'sandbox',
    );
    if (!con)
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    return c.json(await deps.repository.createSandboxEvent(con.connectionId, body.scenario), 202);
  });
  app.route('/', api);
  app.post('/api/internal/events/paely/v1', async (c) => {
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    const timestamp = Number(c.req.header('X-Paely-Timestamp'));
    const signature = c.req.header('X-Paely-Signature') ?? '';
    const privateId = c.req.header('X-Paely-Event-Id') ?? '';
    if (
      !verifyTimestamp(timestamp, undefined, deps.config.RESTEC_TIMESTAMP_TOLERANCE_SECONDS) ||
      !verifyEventSignature({ secret: deps.eventSigningSecret, signature, timestamp, rawBody: raw })
    )
      throw new ApiError(401, 'invalid_credentials', 'The event signature is invalid.');
    const incoming = privateEvent.parse(parseRaw(raw));
    if (incoming.id !== privateId)
      throw new ApiError(400, 'invalid_request', 'The event identifier is inconsistent.');
    if (incoming.schema_version !== '2026-07-01')
      throw new ApiError(400, 'invalid_request', 'The event schema version is not supported.');
    const con = await deps.repository.getConnectionForPrivateEvent(incoming.data.connection_id);
    if (
      !con ||
      con.environment !== (deps.config.RESTEC_ENV === 'production' ? 'production' : 'sandbox')
    )
      throw new ApiError(404, 'resource_not_found', 'The event connection was not found.');
    if (incoming.data.location_id !== con.privateLocationId)
      throw new ApiError(403, 'access_denied', 'The event location is not authorized.');
    const publicEvent = eventSchema.parse({
      id: `evt_${sha256(incoming.id).slice(0, 24)}`,
      type: incoming.type,
      schema_version: '2026-07-01',
      created_at: new Date().toISOString(),
      data: {
        location_id: con.locationId,
        external_bill_id: incoming.data.external_bill_id,
        external_table_id: incoming.data.external_table_id,
        payment: {
          restec_payment_id: `pay_${sha256(incoming.data.payment.payment_id).slice(0, 20)}`,
          amount: incoming.data.payment.amount,
          currency: incoming.data.payment.currency,
          method: incoming.data.payment.method,
          status: incoming.data.payment.status,
        },
        bill: incoming.data.bill,
      },
    });
    const accepted = await deps.repository.acceptPrivateEvent({
      privateEventId: incoming.id,
      eventType: incoming.type,
      schemaVersion: incoming.schema_version,
      connectionId: con.connectionId,
      requestHash: sha256(raw),
      payload: incoming,
      publicEventId: publicEvent.id,
      publicPayload: publicEvent,
    });
    return c.json({ accepted: true, event_id: accepted.eventId }, accepted.duplicate ? 200 : 202);
  });
  app.post('/api/internal/jobs/dispatch-pos-events', async (c) => {
    if (c.req.header('Authorization') !== `Bearer ${deps.internalJobToken}`)
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    await deps.repository.releaseExpiredLeases();
    const claimed = await deps.repository.claimPosOutboxEvents(
      deps.config.RESTEC_DISPATCH_BATCH_SIZE,
      60,
    );
    let delivered = 0,
      retried = 0,
      deadLettered = 0;
    for (const event of claimed) {
      const attempt = event.attemptCount + 1;
      const started = Date.now();
      let outcome: 'delivered' | 'retry' | 'permanent_failure' = 'retry';
      let status: number | undefined;
      let errorCode: string | undefined;
      try {
        const connector = registry.resolve(
          event.connectorType,
          event.connectorVersion,
          event.connectorEnabled,
        );
        const context = {
          partnerId: 'system',
          connectionId: event.connectionId,
          locationId: event.payload.data.location_id,
          environment: deps.config.RESTEC_ENV,
          configuration: event.configuration,
        } as const;
        const payload = await connector.serializeEvent(event.payload, context);
        await assertSafeWebhookUrl(payload.destination, deps.config.RESTEC_ENV);
        const result = await connector.deliverEvent(payload, {
          ...context,
          eventId: event.publicEventId,
          attempt,
          timeoutMs: deps.config.RESTEC_POS_DELIVERY_TIMEOUT_MS,
        });
        outcome = result.outcome;
        status = result.status;
        errorCode = result.errorCode;
      } catch {
        outcome = 'retry';
        errorCode = 'delivery_error';
      }
      const deliveryAttempt = {
        eventId: event.id,
        attemptNumber: attempt,
        outcome,
        durationMs: Date.now() - started,
      };
      await deps.repository.recordDeliveryAttempt({
        ...deliveryAttempt,
        ...(status === undefined ? {} : { responseStatus: status }),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      if (outcome === 'delivered') {
        await deps.repository.markOutboxDelivered(event.id);
        delivered++;
      } else if (
        outcome === 'permanent_failure' ||
        attempt >= deps.config.RESTEC_MAX_DELIVERY_ATTEMPTS
      ) {
        await deps.repository.markOutboxDeadLetter(event.id, errorCode ?? 'delivery_failed');
        deadLettered++;
      } else {
        await deps.repository.scheduleOutboxRetry(
          event.id,
          new Date(Date.now() + retryDelaySeconds(attempt) * 1000),
          errorCode ?? 'delivery_failed',
        );
        retried++;
      }
    }
    return c.json(
      { accepted: true, claimed: claimed.length, delivered, retried, dead_lettered: deadLettered },
      202,
    );
  });
  app.post('/api/internal/jobs/reconcile', async (c) => {
    if (c.req.header('Authorization') !== `Bearer ${deps.internalJobToken}`)
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    const input = z
      .object({
        partner_id: z.string().startsWith('ptr_'),
        location_id: z.string().startsWith('loc_'),
        external_bill_id: z.string().min(1),
        action: z.enum(['compare', 'mark_manual_review']).default('compare'),
      })
      .strict()
      .parse(await c.req.json());
    const con = await deps.repository.authorizeLocation(
      input.location_id,
      input.partner_id,
      deps.config.RESTEC_ENV === 'production' ? 'production' : 'sandbox',
    );
    if (!con) throw new ApiError(404, 'resource_not_found', 'The requested bill was not found.');
    if (input.action === 'mark_manual_review') {
      await reconciliation.markManualReview(con, input.external_bill_id, 'reconciliation_job');
      return c.json({ accepted: true, status: 'review_required' }, 202);
    }
    return c.json(await reconciliation.compare(con, input.external_bill_id));
  });
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? `req_${randomUUID().replaceAll('-', '')}`;
    if (error instanceof ZodError)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'The request is invalid.',
            request_id: requestId,
            details: {
              issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            },
          },
        },
        400,
      );
    if (error instanceof ApiError)
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            request_id: requestId,
            details: error.details,
          },
        },
        error.status as any,
      );
    return c.json(
      {
        error: {
          code: 'internal_error',
          message: 'An internal error occurred.',
          request_id: requestId,
          details: {},
        },
      },
      500,
    );
  });
  return app;
}
