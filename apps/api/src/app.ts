import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ZodError, z } from 'zod';
import {
  billSchema,
  eventSchema,
  externalPaymentSchema,
  paymentSessionRequestSchema,
  paymentSessionStatusSchema,
} from '@restec/contracts';
import { derivePrivateIdempotencyKey, type PaelyClient } from '@restec/paely-client';
import { PrivateDependencyError } from '@restec/paely-client';
import {
  decryptSecret,
  encryptSecret,
  sha256,
  verifyEventSignature,
  verifyTimestamp,
} from '@restec/security';
import { ConnectorRegistry } from '@restec/connector-registry';
import { assertSafeWebhookUrl, retryDelaySeconds } from '@restec/webhook-delivery';
import type { RateLimiter } from '@restec/rate-limiting';
import { RepositoryError } from '@restec/database';
import { ReconciliationService } from './reconciliation.js';
import type { Config } from './config.js';
import { publicAuth, requestHash } from './auth.js';
import { ApiError, type Repository } from './types.js';
import {
  allowedCheckoutHosts,
  assertResolvedCheckoutDestination,
  containsCardholderData,
  paymentSessionId,
  paymentSessionResponse,
  paymentStatusFromEvent,
  type CheckoutLookup,
} from './payment-sessions.js';
const parseRaw = (raw: Uint8Array) => JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
const privateEvent = z
  .object({
    id: z.string().min(1),
    type: z.enum([
      'payment.completed',
      'payment.failed',
      'payment.expired',
      'payment.refunded',
      'payment.partially_refunded',
    ]),
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
      payment_session: z
        .object({
          private_payment_session_id: z.string().min(1).max(256),
          restec_payment_session_reference: z.string().regex(/^rps_(?:test|live)_[A-Za-z0-9]+$/),
          status: paymentSessionStatusSchema,
        })
        .strict()
        .optional(),
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
  checkoutLookup?: CheckoutLookup;
}) {
  const registry = deps.connectorRegistry ?? new ConnectorRegistry();
  const reconciliation = new ReconciliationService(deps.repository, deps.privateClient);
  const deploymentEnvironment = deps.config.RESTEC_ENV === 'production' ? 'production' : 'sandbox';
  const checkoutHosts = allowedCheckoutHosts(deps.config.RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS);
  const paymentSessionsAvailable = () => {
    if (!deps.config.RESTEC_PAYMENT_SESSIONS_ENABLED)
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
  };
  const requirePublicEnvironment = (c: any) => {
    if (c.req.header('X-Restec-Environment') !== deploymentEnvironment)
      throw new ApiError(401, 'invalid_credentials', 'The supplied credentials are invalid.');
  };
  const jobAuthorized = (authorization?: string) =>
    authorization === `Bearer ${deps.internalJobToken}` ||
    Boolean(deps.config.CRON_SECRET && authorization === `Bearer ${deps.config.CRON_SECRET}`);
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({ status: 'ok', environment: deps.config.RESTEC_ENV, version: '1.0.0' }),
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
  const idempotent = async (
    c: any,
    operation: string,
    work: (key: string) => Promise<unknown>,
    successStatus = 200,
  ) => {
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
      await deps.repository.completeIdempotency(
        c.get('credential').partnerId,
        key,
        successStatus,
        result,
      );
      return c.json(result as any, successStatus as any);
    } catch (error) {
      await deps.repository.releaseIdempotency(c.get('credential').partnerId, key);
      throw error;
    }
  };
  api.put('/v1/locations/:locationId/bills/:externalBillId', async (c) =>
    idempotent(c, 'bill_upsert', async (privateKey) => {
      const con = await connection(c);
      const body = billSchema.parse(parseRaw(c.get('rawBody')));
      const table = await deps.repository.getTableMapping(con.connectionId, body.external_table_id);
      if (!table || !table.active)
        throw new ApiError(404, 'resource_not_found', 'The requested table was not found.');
      const hash = requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody'));
      const preflight = await deps.repository.validateBillMutation(
        con.connectionId,
        c.req.param('externalBillId'),
        body.version,
        hash,
      );
      if (preflight.kind === 'replay')
        return { ...preflight.state, request_id: c.get('requestId') };
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
        hash,
        privateResult.privateBillReference,
      );
    }),
  );
  api.get('/v1/locations/:locationId/bills/:externalBillId', async (c) => {
    const con = await connection(c);
    const value = await deps.repository.getBill(con.connectionId, c.req.param('externalBillId'));
    if (!value) throw new ApiError(404, 'resource_not_found', 'The requested bill was not found.');
    return c.json({ ...value, request_id: c.get('requestId') } as any);
  });
  api.post('/v1/locations/:locationId/bills/:externalBillId/external-payments', async (c) =>
    idempotent(c, 'external_payment', async (privateKey) => {
      const con = await connection(c);
      const body = externalPaymentSchema.parse(parseRaw(c.get('rawBody')));
      const hash = requestHash(c.req.method, new URL(c.req.url).pathname, c.get('rawBody'));
      const preflight = await deps.repository.validateExternalPayment(
        con.connectionId,
        c.req.param('externalBillId'),
        body,
        hash,
      );
      if (preflight.kind === 'replay')
        return { ...preflight.state, request_id: c.get('requestId') };
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
        hash,
      );
    }),
  );
  api.post('/v1/locations/:locationId/bills/:externalBillId/payment-sessions', async (c) => {
    paymentSessionsAvailable();
    requirePublicEnvironment(c);
    return idempotent(
      c,
      'payment_session',
      async (privateKey) => {
        const rawInput = parseRaw(c.get('rawBody'));
        if (containsCardholderData(rawInput))
          throw new ApiError(
            400,
            'invalid_request',
            'Cardholder data must be entered only on the secure hosted payment page.',
          );
        const body = paymentSessionRequestSchema.parse(rawInput);
        const con = await connection(c);
        const externalBillId = c.req.param('externalBillId');
        const bill = await deps.repository.getBill(con.connectionId, externalBillId);
        if (!bill)
          throw new ApiError(404, 'resource_not_found', 'The requested bill was not found.');
        if (
          ['completed', 'cancelled'].includes(bill.order_status) ||
          !['unpaid', 'partially_paid', 'failed'].includes(bill.payment_status) ||
          bill.amount_due <= 0
        )
          throw new ApiError(409, 'bill_not_payable', 'The requested bill is not payable.');
        if (bill.reconciliation_status !== 'matched')
          throw new ApiError(
            409,
            'bill_not_payable',
            'The bill must be reconciled before a payment session can be created.',
          );
        if (body.amount_minor > bill.amount_due)
          throw new ApiError(
            422,
            'amount_exceeds_balance',
            'The payment amount exceeds the known bill balance.',
          );
        if (body.currency !== bill.currency)
          throw new ApiError(
            422,
            'currency_not_supported',
            'The requested currency is not supported for this bill.',
          );
        const idempotencyKey = c.req.header('Idempotency-Key')!;
        if (idempotencyKey.length > 200)
          throw new ApiError(400, 'invalid_request', 'The idempotency key is invalid.');
        const publicId = paymentSessionId(
          deploymentEnvironment,
          con.partnerId,
          con.locationId,
          externalBillId,
          idempotencyKey,
        );
        const requestFingerprint = requestHash(
          c.req.method,
          new URL(c.req.url).pathname,
          c.get('rawBody'),
        );
        const reserved = await deps.repository.reservePaymentSession({
          publicPaymentSessionId: publicId,
          environment: deploymentEnvironment,
          partnerId: con.partnerId,
          connectionId: con.connectionId,
          locationId: con.locationId,
          externalBillId,
          privateLocationReference: con.privateLocationId,
          privateConnectionReference: con.privateConnectionId,
          method: body.method,
          amountMinor: body.amount_minor,
          currency: body.currency,
          status: 'creating',
          expiresAt: new Date(
            Date.now() + deps.config.RESTEC_PAYMENT_SESSION_TTL_SECONDS * 1000,
          ).toISOString(),
          idempotencyKey,
          requestFingerprint,
        });
        if (reserved.record.status !== 'creating' && reserved.record.encryptedProviderCheckoutUrl)
          return paymentSessionResponse(
            reserved.record,
            deps.config.RESTEC_CHECKOUT_PUBLIC_BASE_URL,
          );
        const checkoutBase = deps.config.RESTEC_CHECKOUT_PUBLIC_BASE_URL!;
        const privateResult = await deps.privateClient.createPaymentSession(
          con.privateLocationId,
          externalBillId,
          {
            connectionId: con.privateConnectionId,
            amountMinor: body.amount_minor,
            currency: body.currency,
            method: body.method,
            ...(body.customer
              ? {
                  customer: {
                    ...(body.customer.email ? { email: body.customer.email } : {}),
                    ...(body.customer.mobile ? { mobile: body.customer.mobile } : {}),
                  },
                }
              : {}),
            returnUrls: {
              success: new URL(`/s/${publicId}/return`, checkoutBase).toString(),
              cancel: new URL(`/s/${publicId}/cancel`, checkoutBase).toString(),
            },
            restecPaymentSessionReference: publicId,
          },
          privateKey,
        );
        if (
          privateResult.status !== 'requires_customer_action' ||
          privateResult.amountMinor !== body.amount_minor ||
          privateResult.currency !== body.currency ||
          new Date(privateResult.expiresAt).getTime() <= Date.now()
        )
          throw new PrivateDependencyError(false, 502);
        let destination: URL;
        try {
          destination = await assertResolvedCheckoutDestination(
            privateResult.providerCheckoutUrl,
            checkoutHosts,
            deps.checkoutLookup,
          );
        } catch {
          throw new ApiError(
            502,
            'invalid_checkout_destination',
            'The hosted payment destination is unavailable.',
          );
        }
        const attached = await deps.repository.attachPaymentSession({
          publicPaymentSessionId: publicId,
          privatePaymentSessionReference: privateResult.privatePaymentSessionId,
          encryptedProviderCheckoutUrl: encryptSecret(
            privateResult.providerCheckoutUrl,
            deps.config.RESTEC_SECRET_ENCRYPTION_KEY,
          ),
          providerCheckoutHost: destination.hostname.toLowerCase(),
          status: privateResult.status,
          expiresAt: privateResult.expiresAt,
        });
        await deps.repository.createAuditLog({
          actorType: 'partner',
          actorId: con.partnerId,
          partnerId: con.partnerId,
          connectionId: con.connectionId,
          requestId: c.get('requestId'),
          action: 'payment_session.created',
          result: 'requires_customer_action',
          targetType: 'payment_session',
          targetId: publicId,
          metadata: { environment: deploymentEnvironment },
        });
        return paymentSessionResponse(attached, checkoutBase);
      },
      201,
    );
  });
  api.get('/v1/locations/:locationId/payment-sessions/:paymentSessionId', async (c) => {
    paymentSessionsAvailable();
    requirePublicEnvironment(c);
    const con = await connection(c);
    const publicId = c.req.param('paymentSessionId');
    if (!/^rps_(?:test|live)_[A-Za-z0-9]+$/.test(publicId))
      throw new ApiError(
        404,
        'payment_session_not_found',
        'The requested payment session was not found.',
      );
    const session = await deps.repository.getPaymentSession(publicId);
    if (
      !session ||
      session.connectionId !== con.connectionId ||
      session.locationId !== con.locationId ||
      session.environment !== deploymentEnvironment
    )
      throw new ApiError(
        404,
        'payment_session_not_found',
        'The requested payment session was not found.',
      );
    return c.json(paymentSessionResponse(session));
  });
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
    return idempotent(
      c,
      'sandbox_scenario',
      async () => {
        const body = z
          .object({
            location_id: z.string().startsWith('loc_').optional(),
            external_bill_id: z.string().min(1).max(128),
            amount: z.number().int().positive().optional(),
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
        const con = body.location_id
          ? await deps.repository.authorizeLocation(
              body.location_id,
              c.get('credential').partnerId,
              'sandbox',
            )
          : await deps.repository.findSandboxConnection(
              c.get('credential').partnerId,
              body.external_bill_id,
            );
        if (!con)
          throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
        return deps.repository.createSandboxEvent(
          con.connectionId,
          body.scenario,
          body.external_bill_id,
          body.amount,
        );
      },
      202,
    );
  });
  app.route('/', api);
  const browserPaymentSession = async (publicId: string) => {
    paymentSessionsAvailable();
    if (!/^rps_(?:test|live)_[A-Za-z0-9]+$/.test(publicId))
      throw new ApiError(
        404,
        'payment_session_not_found',
        'The requested payment session was not found.',
      );
    const session = await deps.repository.getPaymentSession(publicId);
    if (!session || session.environment !== deploymentEnvironment)
      throw new ApiError(
        404,
        'payment_session_not_found',
        'The requested payment session was not found.',
      );
    const con = await deps.repository.authorizeLocation(
      session.locationId,
      session.partnerId,
      deploymentEnvironment,
    );
    if (!con || con.connectionId !== session.connectionId)
      throw new ApiError(
        404,
        'payment_session_not_found',
        'The requested payment session was not found.',
      );
    return session;
  };
  app.get('/s/:paymentSessionId', async (c) => {
    const session = await browserPaymentSession(c.req.param('paymentSessionId'));
    c.header('Cache-Control', 'no-store, max-age=0');
    c.header('Pragma', 'no-cache');
    c.header('Referrer-Policy', 'no-referrer');
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      if (['requires_customer_action', 'processing'].includes(session.status))
        await deps.repository.transitionPaymentSession(
          session.publicPaymentSessionId,
          'expired',
          new Date().toISOString(),
        );
      throw new ApiError(410, 'payment_session_expired', 'The payment session has expired.');
    }
    if (!['requires_customer_action', 'processing'].includes(session.status))
      throw new ApiError(
        409,
        'payment_session_already_completed',
        'The payment session is no longer available for customer action.',
      );
    if (!session.encryptedProviderCheckoutUrl || !session.providerCheckoutHost)
      throw new ApiError(
        503,
        'dependency_unavailable',
        'The hosted payment page is temporarily unavailable.',
      );
    let destination: URL;
    try {
      destination = await assertResolvedCheckoutDestination(
        decryptSecret(
          session.encryptedProviderCheckoutUrl,
          deps.config.RESTEC_SECRET_ENCRYPTION_KEY,
        ),
        checkoutHosts,
        deps.checkoutLookup,
      );
      if (destination.hostname.toLowerCase() !== session.providerCheckoutHost)
        throw new Error('host_mismatch');
    } catch {
      throw new ApiError(
        502,
        'invalid_checkout_destination',
        'The hosted payment destination is unavailable.',
      );
    }
    await deps.repository.createAuditLog({
      actorType: 'customer',
      partnerId: session.partnerId,
      connectionId: session.connectionId,
      action: 'payment_session.checkout_redirected',
      result: 'accepted',
      targetType: 'payment_session',
      targetId: session.publicPaymentSessionId,
      metadata: { environment: deploymentEnvironment },
    });
    return c.redirect(destination.toString(), 303);
  });
  app.get('/s/:paymentSessionId/return', async (c) => {
    const session = await browserPaymentSession(c.req.param('paymentSessionId'));
    c.header('Cache-Control', 'no-store, max-age=0');
    c.header('Referrer-Policy', 'no-referrer');
    const status = session.status === 'paid' ? 'paid' : 'confirmation_pending';
    const message =
      status === 'paid'
        ? 'Payment confirmed and synchronized through Restec.'
        : 'Payment confirmation may still be processing. Your POS will be updated after confirmation.';
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="${deps.config.RESTEC_PAYMENT_SESSION_RETURN_POLL_SECONDS}"><title>Restec payment status</title></head><body><main><h1>Payment status</h1><p>${message}</p><p>Status: ${status}</p></main></body></html>`,
    );
  });
  app.get('/s/:paymentSessionId/cancel', async (c) => {
    const session = await browserPaymentSession(c.req.param('paymentSessionId'));
    c.header('Cache-Control', 'no-store, max-age=0');
    c.header('Referrer-Policy', 'no-referrer');
    if (session.status === 'requires_customer_action')
      await deps.repository.transitionPaymentSession(
        session.publicPaymentSessionId,
        'cancelled',
        new Date().toISOString(),
      );
    return c.html(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Restec payment status</title></head><body><main><h1>Payment not completed</h1><p>No payment confirmation has been received. A later verified payment confirmation will still be synchronized through Restec.</p></main></body></html>',
    );
  });
  app.post('/api/test/mock-pos-webhook', async (c) => {
    if (deps.config.RESTEC_ENV !== 'sandbox')
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    if (c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
      throw new ApiError(400, 'invalid_request', 'Content-Type must be application/json.');
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    if (raw.byteLength > 1_048_576)
      throw new ApiError(413, 'payload_too_large', 'The request payload is too large.');
    const eventId = c.req.header('X-Restec-Event-Id') ?? '';
    const timestamp = Number(c.req.header('X-Restec-Timestamp'));
    const context = await deps.repository.getMockPosWebhookContext(eventId);
    if (
      !context ||
      c.req.header('X-Restec-Environment') !== 'sandbox' ||
      !verifyTimestamp(timestamp, undefined, deps.config.RESTEC_TIMESTAMP_TOLERANCE_SECONDS) ||
      !verifyEventSignature({
        secret: context.signingSecret,
        signature: c.req.header('X-Restec-Signature') ?? '',
        timestamp,
        rawBody: raw,
      })
    )
      throw new ApiError(401, 'invalid_credentials', 'The event signature is invalid.');
    const event = eventSchema.parse(parseRaw(raw));
    if (event.id !== eventId)
      throw new ApiError(400, 'invalid_request', 'The event identifier is inconsistent.');
    await deps.repository.acceptMockPosReceipt({
      eventId,
      connectionId: context.connectionId,
      requestHash: sha256(raw),
      eventType: event.type,
      receivedAt: new Date().toISOString(),
    });
    return c.body(null, 204);
  });
  app.get('/api/internal/test/mock-pos-webhook/last', async (c) => {
    if (deps.config.RESTEC_ENV !== 'sandbox' || !jobAuthorized(c.req.header('Authorization')))
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    const receipt = await deps.repository.getLastMockPosReceipt();
    return c.json(
      receipt
        ? {
            event_id: receipt.eventId,
            event_type: receipt.eventType,
            received_at: receipt.receivedAt,
            signature_verified: true,
          }
        : { event_id: null },
    );
  });
  app.get('/api/internal/test/payment-sessions/:paymentSessionId/evidence', async (c) => {
    if (deps.config.RESTEC_ENV !== 'sandbox' || !jobAuthorized(c.req.header('Authorization')))
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    const evidence = await deps.repository.getPaymentSessionCertificationEvidence(
      c.req.param('paymentSessionId'),
    );
    if (!evidence)
      throw new ApiError(
        404,
        'payment_session_not_found',
        'The requested payment session was not found.',
      );
    return c.json({
      payment_session_id: c.req.param('paymentSessionId'),
      payment_session_status: evidence.paymentSessionStatus,
      bill_payment_status: evidence.billPaymentStatus,
      private_event_accepted: evidence.privateEventAccepted,
      public_event_id: evidence.publicEventId,
      pos_outbox_status: evidence.posOutboxStatus,
      delivery_attempts: evidence.deliveryAttempts,
      mock_pos_accepted: evidence.mockPosAccepted,
      dead_lettered: evidence.deadLettered,
    });
  });
  app.post('/api/internal/events/paely/v1', async (c) => {
    if (c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
      throw new ApiError(400, 'invalid_request', 'Content-Type must be application/json.');
    const declaredLength = Number(c.req.header('Content-Length') ?? 0);
    if (declaredLength > 1_048_576)
      throw new ApiError(413, 'payload_too_large', 'The request payload is too large.');
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    if (raw.byteLength > 1_048_576)
      throw new ApiError(413, 'payload_too_large', 'The request payload is too large.');
    const timestamp = Number(c.req.header('X-Paely-Timestamp'));
    const signature = c.req.header('X-Paely-Signature') ?? '';
    const privateId = c.req.header('X-Paely-Event-Id') ?? '';
    const deliveryAttempt = Number(c.req.header('X-Paely-Delivery-Attempt'));
    if (
      !verifyTimestamp(timestamp, undefined, deps.config.RESTEC_TIMESTAMP_TOLERANCE_SECONDS) ||
      !verifyEventSignature({
        secret: deps.eventSigningSecret,
        signature,
        timestamp,
        rawBody: raw,
      }) ||
      !Number.isSafeInteger(deliveryAttempt) ||
      deliveryAttempt < 1
    )
      throw new ApiError(401, 'invalid_credentials', 'The event signature is invalid.');
    const incoming = privateEvent.parse(parseRaw(raw));
    if (
      incoming.data.payment_session &&
      (c.req.header('X-Paely-Service-Id') !== deps.config.PAELY_EVENT_SERVICE_ID ||
        c.req.header('X-Paely-Environment') !== deploymentEnvironment)
    )
      throw new ApiError(401, 'invalid_credentials', 'The event identity is invalid.');
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
      created_at: incoming.created_at,
      data: {
        location_id: con.locationId,
        external_bill_id: incoming.data.external_bill_id,
        external_table_id: incoming.data.external_table_id,
        ...(incoming.data.payment_session
          ? {
              payment_session_id: incoming.data.payment_session.restec_payment_session_reference,
            }
          : {}),
        payment: {
          restec_payment_id: `pay_${sha256(incoming.data.payment.payment_id).slice(0, 20)}`,
          amount: incoming.data.payment.amount,
          currency: incoming.data.payment.currency,
          method: [
            'card',
            'wallet',
            'cash',
            'card_terminal',
            'wallet_terminal',
            'voucher',
            'other',
          ].includes(incoming.data.payment.method)
            ? incoming.data.payment.method
            : 'other',
          status:
            incoming.type === 'payment.completed'
              ? 'completed'
              : ['payment.refunded', 'payment.partially_refunded'].includes(incoming.type)
                ? 'refunded'
                : 'failed',
        },
        bill: incoming.data.bill,
      },
    });
    const eventInput = {
      privateEventId: incoming.id,
      eventType: incoming.type,
      schemaVersion: incoming.schema_version,
      connectionId: con.connectionId,
      requestHash: sha256(raw),
      payload: incoming,
      publicEventId: publicEvent.id,
      publicPayload: publicEvent,
    };
    const accepted = incoming.data.payment_session
      ? await deps.repository.acceptPaymentSessionEvent({
          ...eventInput,
          publicPaymentSessionId: incoming.data.payment_session.restec_payment_session_reference,
          requestedStatus: paymentStatusFromEvent(incoming.type),
        })
      : await deps.repository.acceptPrivateEvent(eventInput);
    return c.json({ accepted: true, event_id: accepted.eventId }, accepted.duplicate ? 200 : 202);
  });
  app.post('/api/internal/jobs/dispatch-pos-events', async (c) => {
    if (!jobAuthorized(c.req.header('Authorization')))
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
      let phase = 'connector';
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
        phase = 'serialization';
        const payload = await connector.serializeEvent(event.payload, context);
        phase = 'destination';
        await assertSafeWebhookUrl(payload.destination, deps.config.RESTEC_ENV);
        phase = 'delivery';
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
        errorCode = `${phase}_error`;
      }
      const deliveryAttempt = {
        eventId: event.id,
        attemptNumber: attempt,
        outcome,
        durationMs: Date.now() - started,
      };
      if (outcome === 'delivered') {
        await deps.repository.completeOutboxDelivery({
          ...deliveryAttempt,
          outcome,
          responseStatus: status!,
        });
        delivered++;
      } else if (
        outcome === 'permanent_failure' ||
        attempt >= deps.config.RESTEC_MAX_DELIVERY_ATTEMPTS
      ) {
        await deps.repository.failOutboxDelivery({
          ...deliveryAttempt,
          outcome: 'permanent_failure',
          ...(status === undefined ? {} : { responseStatus: status }),
          errorCode: errorCode ?? 'delivery_failed',
        });
        deadLettered++;
      } else {
        await deps.repository.failOutboxDelivery({
          ...deliveryAttempt,
          outcome: 'retry',
          ...(status === undefined ? {} : { responseStatus: status }),
          errorCode: errorCode ?? 'delivery_failed',
          nextAttemptAt: new Date(Date.now() + retryDelaySeconds(attempt) * 1000),
        });
        retried++;
      }
    }
    return c.json(
      { accepted: true, claimed: claimed.length, delivered, retried, dead_lettered: deadLettered },
      202,
    );
  });
  app.post('/api/internal/jobs/reconcile', async (c) => {
    if (!jobAuthorized(c.req.header('Authorization')))
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    const input = z
      .object({
        partner_id: z.string().startsWith('ptr_'),
        location_id: z.string().startsWith('loc_'),
        external_bill_id: z.string().min(1),
        action: z
          .enum(['compare', 'refresh_private_bill', 'mark_manual_review', 'requeue_pos_event'])
          .default('compare'),
        event_id: z.string().startsWith('evt_').optional(),
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
    if (input.action === 'requeue_pos_event') {
      if (!input.event_id)
        throw new ApiError(400, 'invalid_request', 'An event ID is required for replay.');
      await reconciliation.requeueEvent(input.event_id, 'reconciliation_job');
      return c.json({ accepted: true, status: 'pending', event_id: input.event_id }, 202);
    }
    const result = await reconciliation.compare(con, input.external_bill_id);
    await deps.repository.createAuditLog({
      actorType: 'service',
      actorId: 'reconciliation_job',
      partnerId: con.partnerId,
      connectionId: con.connectionId,
      action:
        input.action === 'refresh_private_bill'
          ? 'reconciliation.private_bill_refreshed'
          : 'reconciliation.compared',
      result: result.status,
      targetType: 'bill',
      targetId: input.external_bill_id,
      metadata: { difference_count: result.differences.length },
    });
    return c.json(result);
  });
  app.post('/api/internal/jobs/reconcile-payment-sessions', async (c) => {
    if (!jobAuthorized(c.req.header('Authorization')))
      throw new ApiError(404, 'resource_not_found', 'The requested resource was not found.');
    if (!deps.config.RESTEC_PAYMENT_SESSIONS_ENABLED)
      return c.json({ accepted: true, feature_enabled: false, examined: 0 }, 202);
    const body = z
      .object({ limit: z.number().int().min(1).max(100).default(25) })
      .strict()
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      {
        accepted: true,
        feature_enabled: true,
        ...(await reconciliation.reconcilePaymentSessions(body.limit)),
      },
      202,
    );
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
    if (error instanceof RepositoryError) {
      const status =
        error.code === 'resource_not_found' ? 404 : error.code === 'amount_mismatch' ? 422 : 409;
      const messages: Record<string, string> = {
        resource_not_found: 'The requested resource was not found.',
        replay_detected: 'A conflicting event or request was detected.',
        idempotency_conflict: 'The idempotency key conflicts with an earlier operation.',
        bill_version_conflict: 'The supplied bill version conflicts with the current version.',
        payment_in_progress: 'A payment is currently in progress.',
        bill_already_paid: 'The bill is already paid or the amount exceeds the amount due.',
        amount_mismatch: 'The amount or currency does not match the bill.',
        invalid_status_transition: 'The requested payment state transition is not allowed.',
      };
      return c.json(
        {
          error: {
            code: error.code,
            message: messages[error.code],
            request_id: requestId,
            details: {},
          },
        },
        status as any,
      );
    }
    if (error instanceof PrivateDependencyError) {
      const status =
        error.status === 504 ? 504 : [408, 425, 429, 503].includes(error.status) ? 503 : 502;
      return c.json(
        {
          error: {
            code: 'dependency_unavailable',
            message: 'The requested operation could not be completed at this time.',
            request_id: requestId,
            details: { retryable: error.retryable },
          },
        },
        status,
      );
    }
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
