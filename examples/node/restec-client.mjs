import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export function signRequest(secret, timestamp, method, path, rawBody = '') {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${method.toUpperCase()}.${path}.`)
    .update(rawBody)
    .digest('hex');
  return `v1=${digest}`;
}

export function signWebhook(secret, timestamp, rawBody) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWebhook({ secret, rawBody, headers, now = Math.floor(Date.now() / 1000) }) {
  // Pass X-Restec-Event-Id, X-Restec-Timestamp, X-Restec-Signature, and
  // X-Restec-Environment using the lowercase keys produced by Node HTTP servers.
  const timestamp = Number(headers['x-restec-timestamp']);
  const signature = headers['x-restec-signature'] ?? '';
  const headerEventId = headers['x-restec-event-id'];
  const headerEnvironment = headers['x-restec-environment'];
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) return false;
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (
    body.event_id !== headerEventId ||
    body.environment !== headerEnvironment ||
    body.event_version !== '1.0'
  )
    return false;
  return constantTimeEqual(signature, signWebhook(secret, timestamp, rawBody));
}

export class RestecProblem extends Error {
  constructor(status, problem) {
    super(problem.detail ?? `Restec request failed with ${status}`);
    this.status = status;
    this.code = problem.code;
    this.requestId = problem.request_id;
    this.retryable = problem.retryable === true;
    this.retryAfterSeconds = problem.retry_after_seconds;
    this.fieldErrors = problem.field_errors ?? [];
  }
}

export class RestecClient {
  constructor({ baseUrl, apiCredential, requestSigningSecret, environment = 'sandbox' }) {
    this.baseUrl = new URL(baseUrl);
    this.apiCredential = apiCredential;
    this.requestSigningSecret = requestSigningSecret;
    this.environment = environment;
  }

  async request(method, path, value, { idempotencyKey, includeEnvironment = false } = {}) {
    const rawBody = value === undefined ? '' : JSON.stringify(value);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiCredential}`,
        'Content-Type': 'application/json',
        'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
        'X-Restec-Timestamp': String(timestamp),
        'X-Restec-Signature': signRequest(
          this.requestSigningSecret,
          timestamp,
          method,
          path,
          rawBody,
        ),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(includeEnvironment ? { 'X-Restec-Environment': this.environment } : {}),
      },
      ...(value === undefined ? {} : { body: rawBody }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({ detail: 'Invalid error response' }));
      const error = new RestecProblem(response.status, problem);
      if (response.headers.has('Retry-After'))
        error.retryAfterSeconds = Number(response.headers.get('Retry-After'));
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  }

  upsertBill(locationId, externalBillId, revision, idempotencyKey) {
    return this.request(
      'PUT',
      `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`,
      revision,
      { idempotencyKey },
    );
  }

  getBill(locationId, externalBillId) {
    return this.request(
      'GET',
      `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`,
    );
  }

  recordPayment(locationId, externalBillId, payment, idempotencyKey) {
    return this.request(
      'POST',
      `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}/external-payments`,
      payment,
      { idempotencyKey },
    );
  }

  createPaymentSession(locationId, externalBillId, input, idempotencyKey) {
    return this.request(
      'POST',
      `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}/payment-sessions`,
      input,
      { idempotencyKey, includeEnvironment: true },
    );
  }

  getPaymentSession(locationId, paymentSessionId) {
    return this.request(
      'GET',
      `/v1/locations/${encodeURIComponent(locationId)}/payment-sessions/${encodeURIComponent(paymentSessionId)}`,
      undefined,
      { includeEnvironment: true },
    );
  }
}

export async function safelyRetry(work, { maxWindowMs = 15 * 60_000 } = {}) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      attempt++;
      const retryable =
        error instanceof RestecProblem
          ? error.retryable || [429, 502, 503, 504].includes(error.status)
          : true;
      if (!retryable || Date.now() - started >= maxWindowMs) throw error;
      const seconds =
        error instanceof RestecProblem && Number.isFinite(error.retryAfterSeconds)
          ? error.retryAfterSeconds
          : Math.min(60, 2 ** Math.min(attempt - 1, 6));
      await new Promise((resolve) =>
        setTimeout(resolve, seconds * 1000 * (0.8 + Math.random() * 0.4)),
      );
    }
  }
}

export async function acceptWebhook({ secret, rawBody, headers, eventStore, applyEvent }) {
  if (!verifyWebhook({ secret, rawBody, headers })) return { status: 401 };
  const event = JSON.parse(rawBody);
  const stored = await eventStore.insertUnique(event.event_id, rawBody);
  if (stored === 'conflict') return { status: 409 };
  if (stored === 'inserted') await applyEvent(event);
  return { status: 204 };
}
