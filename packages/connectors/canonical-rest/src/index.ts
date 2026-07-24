import { billSchema, eventSchema, externalPaymentSchema } from '@restec/contracts';
import type { PosConnector } from '@restec/connector-sdk';
import { signEvent } from '@restec/security';
export const canonicalRestConnector: PosConnector = {
  id: 'canonical_rest',
  displayName: 'Restec Canonical REST',
  version: '1.0.0',
  async verifyInboundRequest() {},
  async normalizeBill(input) {
    return billSchema.parse(input);
  },
  async normalizeExternalPayment(input) {
    return externalPaymentSchema.parse(input);
  },
  async serializeEvent(input, ctx) {
    const event = eventSchema.parse(input);
    const body = JSON.stringify(event);
    const destination = String(ctx.configuration.webhook_url ?? '');
    return { body, destination };
  },
  async deliverEvent(payload, ctx) {
    const secret = String(ctx.configuration.webhook_secret ?? '');
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await fetch(payload.destination, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(ctx.timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Restec-Event-Id': ctx.eventId,
          'X-Restec-Timestamp': String(timestamp),
          'X-Restec-Signature': signEvent(secret, timestamp, payload.body),
          'X-Restec-Environment': ctx.environment === 'production' ? 'production' : 'sandbox',
          'X-Restec-Delivery-Attempt': String(ctx.attempt),
        },
        body: payload.body,
      });
      if ([200, 201, 202, 204].includes(response.status))
        return { outcome: 'delivered', status: response.status };
      if ([408, 425, 429, 500, 502, 503, 504].includes(response.status))
        return { outcome: 'retry', status: response.status, errorCode: `http_${response.status}` };
      return {
        outcome: 'permanent_failure',
        status: response.status,
        errorCode: `http_${response.status}`,
      };
    } catch {
      return { outcome: 'retry', errorCode: 'network_error' };
    }
  },
  async healthCheck() {
    return { status: 'healthy', checkedAt: new Date().toISOString() };
  },
};
