import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { signRequest } from '@restec/security';

type SignedRequest = (
  method: 'PUT' | 'POST' | 'GET',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  operation?: string,
) => Promise<Response>;

function sanitizedDiagnosticError(value: unknown) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/\b(?:track|pps|sec|pk|sk|wh|token)_[A-Za-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

export class CertificationHttpError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId: string | undefined,
    public readonly retryable: boolean | undefined,
  ) {
    super(
      `${operation} failed with HTTP ${status} (` +
        [code, requestId].filter(Boolean).join(':') +
        ').',
    );
    this.name = 'CertificationHttpError';
  }
}

export const certificationBillBody = (
  externalTableId: string,
  version: number,
  cancelled = false,
) => ({
  external_table_id: externalTableId,
  version,
  currency: 'PKR' as const,
  status: cancelled ? ('cancelled' as const) : ('open' as const),
  order_status: cancelled ? ('cancelled' as const) : ('accepted' as const),
  items: [
    {
      external_item_id: 'CERT-ITEM-1',
      name: 'Sandbox certification item',
      quantity: 1,
      unit_amount: 10_000,
      total_amount: 10_000,
    },
  ],
  totals: {
    subtotal: 10_000,
    tax: 0,
    service_charge: 0,
    discount: 0,
    tip: 0,
    grand_total: 10_000,
  },
  occurred_at: new Date().toISOString(),
  metadata: {
    certification: true,
    ...(cancelled ? { cleanup_reason: 'payment_session_creation_failed' } : {}),
  },
});

export function assertCertificationTableAvailable(
  externalTableId: string,
  tables: Array<{ external_table_id?: unknown; active?: unknown }>,
) {
  const table = tables.find((candidate) => candidate.external_table_id === externalTableId);
  if (table?.active === true) return;
  const available = tables
    .filter(
      (candidate): candidate is { external_table_id: string; active?: unknown } =>
        candidate.active === true && typeof candidate.external_table_id === 'string',
    )
    .map((candidate) => candidate.external_table_id)
    .sort();
  const reason = table ? 'exists but is inactive' : 'is not mapped';
  throw new Error(
    `RESTEC_SANDBOX_EXTERNAL_TABLE_ID=${externalTableId} ${reason} for the sandbox location. ` +
      `Available active external table IDs: ${available.join(', ') || '(none)'}.`,
  );
}

export async function cleanupCertificationBill(input: {
  signedRequest: SignedRequest;
  billPath: string;
  externalBillId: string;
  externalTableId: string;
  currentVersion?: number;
}) {
  const nextVersion = (input.currentVersion ?? 1) + 1;
  const suffix = input.externalBillId.replace(/^CERT-/, '');
  const response = await input.signedRequest(
    'PUT',
    input.billPath,
    certificationBillBody(input.externalTableId, nextVersion, true),
    `cert-cleanup-${suffix}-v${nextVersion}`,
    'bill_cleanup',
  );
  const body = (await response.json()) as {
    request_id?: string;
    external_bill_id?: string;
    version?: number;
    order_status?: string;
  };
  return {
    request_id: body.request_id,
    external_bill_id: body.external_bill_id,
    version: body.version,
    order_status: body.order_status,
  };
}

const cleanupCommand = (externalBillId: string, currentVersion = 1) =>
  `$env:RESTEC_CERTIFICATION_EXTERNAL_BILL_ID='${externalBillId}'; ` +
  `$env:RESTEC_CERTIFICATION_BILL_VERSION='${currentVersion}'; ` +
  'npm run certify:real-payment-session -- --cleanup';

export const certificationStages = [
  'bill_created',
  'payment_session_created',
  'checkout_opened',
  'checkout_returned',
  'safepay_webhook_verified',
  'paely_paid',
  'paely_event_delivered',
  'restec_paid',
  'pos_event_delivered',
  'mock_pos_received',
  'certification_passed',
] as const;

export type CertificationStage = (typeof certificationStages)[number];

export interface PaelyCertificationEvidence {
  signature_valid?: boolean;
  verified?: boolean;
  processed?: boolean;
  webhook_signature_valid?: boolean;
  safepay_webhook_signature_valid?: boolean;
  webhook_verified?: boolean;
  safepay_webhook_verified?: boolean;
  webhook_processed?: boolean;
  safepay_webhook_processed?: boolean;
  webhook_processing_status?: string;
  webhook_processing_error?: string;
  paely_private_session_status?: string;
  payment_completed_outbox_exists?: boolean;
  payment_completed_outbox_count?: number;
  paely_outbox_delivery_status?: string;
  paely_outbox_dead_lettered?: boolean;
  restec_delivery_http_status?: number;
  dispatcher_status?: string;
  dispatcher_acceleration?: string;
}

export interface RestecCertificationEvidence {
  private_payment_session_id?: string;
  payment_session_status?: string;
  paid_at?: string | null;
  bill_payment_status?: string | null;
  private_event_accepted?: boolean;
  payment_completed_inbox_count?: number;
  public_event_id?: string | null;
  pos_outbox_status?: string | null;
  payment_completed_pos_count?: number;
  delivery_attempts?: number;
  mock_pos_accepted?: boolean;
  matching_mock_pos_receipt_count?: number;
  dead_lettered?: boolean;
}

export interface OperatorWaiter {
  promise: Promise<void>;
  close: () => void;
}

export class CertificationCancelledError extends Error {
  constructor() {
    super('Certification cancelled.');
    this.name = 'CertificationCancelledError';
  }
}

export class CertificationStateError extends Error {
  constructor(public readonly code: string) {
    super(`Certification stopped: ${code}.`);
    this.name = 'CertificationStateError';
  }
}

export function createCertificationDeadline(
  timeoutMs: number,
  onTimeout: () => void,
  timers: {
    set: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
    clear: (timer: ReturnType<typeof setTimeout>) => void;
  } = { set: setTimeout, clear: clearTimeout },
) {
  const timer = timers.set(onTimeout, timeoutMs);
  timer.unref?.();
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      timers.clear(timer);
    },
  };
}

export function createCertificationCancellationHandler(
  controller: AbortController,
  report: (stage: string) => void = (stage) => console.log(JSON.stringify({ stage })),
) {
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    report('certification_cancelled');
    controller.abort();
  };
}

type PublicSessionStatus = {
  status: string;
  paid_at?: string | null;
  external_bill_id?: string;
};

export interface CertificationMonitorInput {
  initialStatus: string;
  timeoutMs: number;
  operator?: OperatorWaiter;
  signal?: AbortSignal;
  readRestecStatus: (attempt: number) => Promise<PublicSessionStatus>;
  readPaelyEvidence: (attempt: number) => Promise<PaelyCertificationEvidence>;
  readRestecEvidence: (attempt: number) => Promise<RestecCertificationEvidence>;
  dispatchPaely?: (attempt: number) => Promise<void>;
  dispatchRestec?: (attempt: number) => Promise<void>;
  reportStage?: (stage: CertificationStage, details?: Record<string, unknown>) => void;
  reportDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  reportPoll?: (diagnostic: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export function paelyCertificationDiagnosticsPath(evidence: RestecCertificationEvidence) {
  const privatePaymentSessionId = evidence.private_payment_session_id;
  if (!privatePaymentSessionId)
    throw new Error(
      'The deployed Restec evidence endpoint did not return private_payment_session_id. Deploy the Restec API before running certification.',
    );
  return `/api/internal/integrations/restec/v1/certification/payment-sessions/${encodeURIComponent(privatePaymentSessionId)}/diagnostics`;
}

const sanitizedPollingValue = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizedDiagnosticError(value);
  if (Array.isArray(value)) return value.map(sanitizedPollingValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizedPollingValue(entry),
      ]),
    );
  return value;
};

export async function reportPollingHttpResponse(
  source: string,
  attempt: number,
  response: Response,
  report: (diagnostic: Record<string, unknown>) => void,
) {
  const rawBody = await response.text();
  let body: unknown = rawBody;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Preserve non-JSON bodies as sanitized text.
    }
  } else body = null;
  report({
    event: 'restec.certification_poll_http_response',
    attempt,
    source,
    http_status: response.status,
    body: sanitizedPollingValue(body),
  });
}

const safepayWebhookVerified = (evidence: PaelyCertificationEvidence) => {
  const signatureValid =
    evidence.safepay_webhook_signature_valid ??
    evidence.webhook_signature_valid ??
    evidence.signature_valid;
  const verified =
    evidence.safepay_webhook_verified ?? evidence.webhook_verified ?? evidence.verified;
  const processed =
    evidence.safepay_webhook_processed ??
    evidence.webhook_processed ??
    evidence.processed ??
    evidence.webhook_processing_status === 'processed';
  return signatureValid === true && verified === true && processed === true;
};

const paelyEventDelivered = (evidence: PaelyCertificationEvidence) => {
  const exists =
    evidence.payment_completed_outbox_count === 1 ||
    evidence.payment_completed_outbox_exists === true;
  const status = evidence.restec_delivery_http_status;
  return (
    exists &&
    evidence.paely_outbox_delivery_status === 'delivered' &&
    (status === undefined || status === 200 || status === 202)
  );
};

/** The single authoritative certification PASS predicate. */
export const isCertificationPass = (
  status: PublicSessionStatus,
  restec: RestecCertificationEvidence,
) =>
  status.status === 'paid' &&
  restec.payment_session_status === 'paid' &&
  restec.bill_payment_status === 'paid' &&
  restec.private_event_accepted === true &&
  restec.payment_completed_inbox_count === 1 &&
  restec.pos_outbox_status === 'delivered' &&
  restec.matching_mock_pos_receipt_count === 1 &&
  restec.dead_lettered === false;

const abortableSleep = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CertificationCancelledError());
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), milliseconds);
    const onAbort = () => finish(new CertificationCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const hasProgressed = (
  initialStatus: string,
  status: PublicSessionStatus,
  paely: PaelyCertificationEvidence,
) =>
  status.status !== initialStatus ||
  safepayWebhookVerified(paely) ||
  paely.paely_private_session_status === 'paid' ||
  paely.payment_completed_outbox_exists === true ||
  (paely.payment_completed_outbox_count ?? 0) > 0;

function timeoutDiagnostic(
  emitted: Set<CertificationStage>,
  status: PublicSessionStatus,
  paely: PaelyCertificationEvidence,
  restec: RestecCertificationEvidence,
) {
  const state = (stage: CertificationStage, details: Record<string, unknown> = {}) => ({
    status: emitted.has(stage) ? 'completed' : 'waiting',
    ...details,
  });
  return {
    event: 'restec.certification_timeout',
    result: 'FAIL',
    reason: 'bounded_timeout',
    stages: {
      bill_created: state('bill_created'),
      payment_session_created: state('payment_session_created'),
      checkout_opened: state('checkout_opened'),
      checkout_returned: state('checkout_returned'),
      safepay_webhook_verified: state('safepay_webhook_verified', {
        signature_valid:
          paely.safepay_webhook_signature_valid ??
          paely.webhook_signature_valid ??
          paely.signature_valid ??
          false,
        verified:
          paely.safepay_webhook_verified ?? paely.webhook_verified ?? paely.verified ?? false,
        processed:
          paely.safepay_webhook_processed ??
          paely.webhook_processed ??
          paely.processed ??
          paely.webhook_processing_status === 'processed',
        error: sanitizedDiagnosticError(paely.webhook_processing_error),
      }),
      paely_paid: state('paely_paid', {
        session_status: paely.paely_private_session_status ?? 'not_observed',
      }),
      paely_event_delivered: state('paely_event_delivered', {
        outbox_count: paely.payment_completed_outbox_count ?? null,
        delivery_status: paely.paely_outbox_delivery_status ?? 'not_observed',
        dead_lettered: paely.paely_outbox_dead_lettered ?? false,
      }),
      restec_paid: state('restec_paid', {
        session_status: status.status,
        paid_at_exists: Boolean(status.paid_at ?? restec.paid_at),
        inbox_count: restec.payment_completed_inbox_count ?? 0,
      }),
      pos_event_delivered: state('pos_event_delivered', {
        pos_event_count: restec.payment_completed_pos_count ?? 0,
        delivery_status: restec.pos_outbox_status ?? 'not_observed',
        dead_lettered: restec.dead_lettered ?? false,
      }),
      mock_pos_received: state('mock_pos_received', {
        receipt_count: restec.matching_mock_pos_receipt_count ?? 0,
      }),
      certification_passed: state('certification_passed'),
    },
  };
}

export async function monitorCertification(input: CertificationMonitorInput) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? abortableSleep;
  const reportStage = input.reportStage ?? (() => undefined);
  const reportDiagnostic = input.reportDiagnostic ?? console.error;
  const reportPoll = input.reportPoll ?? (() => undefined);
  const deadline = now() + input.timeoutMs;
  const progressed = deferred<void>();
  const emitted = new Set<CertificationStage>([
    'bill_created',
    'payment_session_created',
    'checkout_opened',
  ]);
  const reported = new Set<CertificationStage>(emitted);
  let status: PublicSessionStatus = { status: input.initialStatus };
  let paely: PaelyCertificationEvidence = {};
  let restec: RestecCertificationEvidence = {};
  let progressSettled = false;
  const pendingReports = new Map<CertificationStage, Record<string, unknown> | undefined>();

  const flushReports = (allowGaps = false) => {
    if (!emitted.has('checkout_returned')) return;
    for (const pendingStage of certificationStages) {
      if (reported.has(pendingStage)) continue;
      if (!emitted.has(pendingStage)) {
        if (allowGaps) continue;
        break;
      }
      reportStage(pendingStage, pendingReports.get(pendingStage));
      reported.add(pendingStage);
      pendingReports.delete(pendingStage);
    }
  };
  const emit = (stage: CertificationStage, details?: Record<string, unknown>) => {
    if (emitted.has(stage)) return;
    emitted.add(stage);
    pendingReports.set(stage, details);
    flushReports(stage === 'certification_passed');
  };
  const markProgress = () => {
    if (progressSettled) return;
    progressSettled = true;
    progressed.resolve();
  };

  const poll = async () => {
    let attempt = 0;
    try {
      do {
        if (input.signal?.aborted) throw new CertificationCancelledError();
        const pollAttempt = attempt + 1;
        [status, paely, restec] = await Promise.all([
          input.readRestecStatus(pollAttempt),
          input.readPaelyEvidence(pollAttempt),
          input.readRestecEvidence(pollAttempt),
        ]);
        const pollDiagnostic = {
          event: 'restec.certification_poll_evidence',
          attempt: pollAttempt,
          public_session: sanitizedPollingValue(status),
          paely_evidence: sanitizedPollingValue(paely),
          restec_evidence: sanitizedPollingValue(restec),
        };
        reportPoll(pollDiagnostic);
        if (hasProgressed(input.initialStatus, status, paely)) markProgress();

        if (safepayWebhookVerified(paely)) emit('safepay_webhook_verified');
        if (paely.paely_private_session_status === 'paid') emit('paely_paid');
        if (paely.paely_outbox_dead_lettered === true)
          throw new CertificationStateError('paely_payment_completed_dead_letter');
        if ((paely.payment_completed_outbox_count ?? 0) > 1)
          throw new CertificationStateError('paely_payment_completed_count_mismatch');
        if (paelyEventDelivered(paely)) emit('paely_event_delivered');

        const inboxCount = restec.payment_completed_inbox_count ?? 0;
        const posCount = restec.payment_completed_pos_count ?? 0;
        const receiptCount = restec.matching_mock_pos_receipt_count ?? 0;
        if (inboxCount > 1) throw new CertificationStateError('duplicate_payment_completed_inbox');
        if (posCount > 1)
          throw new CertificationStateError('duplicate_payment_completed_pos_event');
        if (receiptCount > 1) throw new CertificationStateError('duplicate_mock_pos_receipt');
        if (restec.dead_lettered === true || restec.pos_outbox_status === 'dead_letter')
          throw new CertificationStateError('restec_pos_dead_letter');

        const paidAt = status.paid_at ?? restec.paid_at;
        if (status.status === 'paid' && restec.payment_session_status === 'paid' && Boolean(paidAt))
          emit('restec_paid', { paid_at_exists: true });
        if (posCount === 1 && restec.pos_outbox_status === 'delivered') emit('pos_event_delivered');
        if (receiptCount === 1 && restec.mock_pos_accepted === true) emit('mock_pos_received');

        if (
          (paely.paely_private_session_status === 'paid' ||
            paely.payment_completed_outbox_exists === true ||
            (paely.payment_completed_outbox_count ?? 0) > 0) &&
          !paelyEventDelivered(paely) &&
          input.dispatchPaely
        )
          await input.dispatchPaely(pollAttempt);
        if (inboxCount === 1 && restec.pos_outbox_status !== 'delivered' && input.dispatchRestec)
          await input.dispatchRestec(pollAttempt);

        if (isCertificationPass(status, restec)) {
          markProgress();
          return { status, paely, restec };
        }
        if (['failed', 'expired', 'refunded'].includes(status.status))
          throw new CertificationStateError(`restec_terminal_${status.status}`);
        if (now() >= deadline) break;
        const delay = Math.min(5_000, 250 * 2 ** Math.min(attempt++, 5));
        await sleep(Math.min(delay, Math.max(0, deadline - now())), input.signal);
      } while (now() <= deadline);

      reportDiagnostic(timeoutDiagnostic(emitted, status, paely, restec));
      throw new CertificationStateError('timeout');
    } catch (error) {
      if (!progressSettled) {
        progressSettled = true;
        progressed.reject(error);
      }
      throw error;
    }
  };

  const monitoring = poll();
  try {
    const returnedBy = input.operator
      ? await Promise.race([
          input.operator.promise.then(() => 'operator' as const),
          progressed.promise.then(() => 'automatic' as const),
        ])
      : await progressed.promise.then(() => 'automatic' as const);
    emit('checkout_returned', { detected_by: returnedBy });
  } catch (error) {
    try {
      await monitoring;
    } catch {
      // The progress race and monitor carry the same failure; observe both promises once.
    }
    throw error;
  } finally {
    input.operator?.close();
  }

  const result = await monitoring;
  emit('certification_passed', {
    result: 'PASS',
    public_session: result.status,
    paely_evidence: result.paely,
    restec_evidence: result.restec,
  });
  return result;
}

export async function createPaymentSessionWithCleanup(input: {
  signedRequest: SignedRequest;
  createPath: string;
  createBody: unknown;
  paymentIdempotencyKey: string;
  billPath: string;
  externalBillId: string;
  externalTableId: string;
  expectedCheckoutOrigin: string;
  report?: (message: string) => void;
}) {
  const report = input.report ?? console.error;
  try {
    const response = await input.signedRequest(
      'POST',
      input.createPath,
      input.createBody,
      input.paymentIdempotencyKey,
      'payment_session_create',
    );
    const session = (await response.json()) as {
      payment_session_id?: string;
      checkout_url?: string;
      status?: string;
    };
    if (
      session.status !== 'requires_customer_action' ||
      typeof session.payment_session_id !== 'string' ||
      typeof session.checkout_url !== 'string'
    )
      throw new Error('The payment-session response was incomplete or in an unexpected state.');
    const checkout = new URL(session.checkout_url);
    if (checkout.origin !== input.expectedCheckoutOrigin)
      throw new Error('The API did not return a Restec-origin checkout URL.');
    return {
      paymentSessionId: session.payment_session_id,
      checkout,
      status: session.status,
    };
  } catch (error) {
    if (error instanceof CertificationHttpError) {
      report(
        JSON.stringify({
          event: 'restec.certification_request_failure',
          operation: error.operation,
          dependency: 'restec_public_api',
          http_status: error.status,
          error_code: error.code,
          request_id: error.requestId ?? null,
          retryable: error.retryable ?? null,
        }),
      );
    }
    try {
      const cleanup = await cleanupCertificationBill({
        signedRequest: input.signedRequest,
        billPath: input.billPath,
        externalBillId: input.externalBillId,
        externalTableId: input.externalTableId,
      });
      report(
        JSON.stringify({
          event: 'restec.certification_bill_cleanup',
          result: 'cancelled',
          ...cleanup,
        }),
      );
    } catch (cleanupError) {
      report(
        `Automatic certification bill cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
      report(`Run this exact cleanup command after resolving the dependency:`);
      report(cleanupCommand(input.externalBillId));
    }
    throw error;
  }
}

export async function main() {
  if (process.env.RUN_REAL_PAYMENT_SESSION_CERTIFICATION !== 'true')
    throw new Error(
      'Refusing remote calls. Set RUN_REAL_PAYMENT_SESSION_CERTIFICATION=true explicitly.',
    );
  if (process.env.RESTEC_ENV !== 'sandbox')
    throw new Error('Real payment-session certification is sandbox-only.');

  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const baseUrl = new URL(required('RESTEC_PUBLIC_BASE_URL'));
  if (baseUrl.protocol !== 'https:') throw new Error('The sandbox API base URL must use HTTPS.');
  const apiKey = required('RESTEC_SANDBOX_TEST_API_KEY');
  const signingSecret = required('RESTEC_SANDBOX_REQUEST_SIGNING_SECRET');
  const locationId = required('RESTEC_SANDBOX_LOCATION_ID');
  const verifyExistingArgument = process.argv.find((argument) =>
    argument.startsWith('--verify-existing-session-id='),
  );
  const verifyExistingSessionId = verifyExistingArgument?.slice(
    '--verify-existing-session-id='.length,
  );
  if (verifyExistingArgument && !/^rps_test_[A-Za-z0-9]+$/.test(verifyExistingSessionId ?? ''))
    throw new Error('--verify-existing-session-id must contain a valid rps_test_ session ID.');
  const verifyOnly = process.argv.includes('--verify') || Boolean(verifyExistingSessionId);
  const cleanupOnly = process.argv.includes('--cleanup');
  const timeoutMs = Number(process.env.RESTEC_CERTIFICATION_TIMEOUT_SECONDS ?? 900) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('RESTEC_CERTIFICATION_TIMEOUT_SECONDS must be a positive number.');

  const failure = async (operation: string, response: Response): Promise<never> => {
    let code = 'unknown_error';
    let requestId: string | undefined;
    let retryable: boolean | undefined;
    try {
      const body = (await response.json()) as {
        error?: {
          code?: string;
          request_id?: string;
          details?: { retryable?: boolean };
        };
      };
      code = body.error?.code ?? code;
      requestId = body.error?.request_id;
      retryable = body.error?.details?.retryable;
    } catch {
      // Keep remote response bodies out of certification output.
    }
    throw new CertificationHttpError(operation, response.status, code, requestId, retryable);
  };

  const abortController = new AbortController();
  let overallTimedOut = false;
  const overallDeadline = createCertificationDeadline(timeoutMs, () => {
    overallTimedOut = true;
    console.error(
      JSON.stringify({
        event: 'restec.certification_failure',
        result: 'FAIL',
        reason: 'overall_timeout',
        timeout_seconds: timeoutMs / 1000,
      }),
    );
    abortController.abort();
  });

  async function signedFetch(
    method: 'PUT' | 'POST' | 'GET',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Environment': 'sandbox',
      'X-Restec-Timestamp': String(timestamp),
      'X-Restec-Signature': signRequest(signingSecret, timestamp, method, path, raw),
      'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      signal: abortController.signal,
      ...(body === undefined ? {} : { body: raw }),
    });
    return response;
  }

  async function signedRequest(
    method: 'PUT' | 'POST' | 'GET',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    operation = path,
  ) {
    const response = await signedFetch(method, path, body, idempotencyKey);
    if (!response.ok) await failure(operation, response);
    return response;
  }

  const health = await fetch(new URL('/health', baseUrl), { signal: abortController.signal });
  if (!health.ok) await failure('health', health);
  const healthBody = (await health.json()) as { status?: string; environment?: string };
  if (healthBody.status !== 'ok' || healthBody.environment !== 'sandbox')
    throw new Error('The deployed Restec API is not reporting sandbox health.');

  const externalTableId = process.env.RESTEC_SANDBOX_EXTERNAL_TABLE_ID ?? 'EXT-01';
  if (cleanupOnly) {
    const cleanupExternalBillId = required('RESTEC_CERTIFICATION_EXTERNAL_BILL_ID');
    const currentVersion = Number(process.env.RESTEC_CERTIFICATION_BILL_VERSION ?? 1);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1)
      throw new Error('RESTEC_CERTIFICATION_BILL_VERSION must be a positive integer.');
    const cleanupBillPath =
      `/v1/locations/${encodeURIComponent(locationId)}/bills/` +
      encodeURIComponent(cleanupExternalBillId);
    const cleanup = await cleanupCertificationBill({
      signedRequest,
      billPath: cleanupBillPath,
      externalBillId: cleanupExternalBillId,
      externalTableId,
      currentVersion,
    });
    console.log(
      JSON.stringify(
        {
          event: 'restec.certification_bill_cleanup',
          result: 'cancelled',
          ...cleanup,
        },
        null,
        2,
      ),
    );
    overallDeadline.close();
    process.exitCode = 0;
    return;
  }

  if (!verifyOnly) {
    const preflightPath =
      `/v1/locations/${encodeURIComponent(locationId)}/payment-sessions/` +
      `rps_test_preflight${randomUUID().replaceAll('-', '')}`;
    const preflight = await signedFetch('GET', preflightPath);
    let preflightCode = 'unknown_error';
    try {
      const body = (await preflight.json()) as { error?: { code?: string } };
      preflightCode = body.error?.code ?? preflightCode;
    } catch {
      // Keep remote response bodies out of certification output.
    }
    if (preflight.status !== 404 || preflightCode !== 'payment_session_not_found') {
      if (preflight.status === 404 && preflightCode === 'resource_not_found')
        throw new Error(
          'The deployed Restec API has payment sessions disabled; certification stopped before creating a bill.',
        );
      throw new Error(
        `Payment-session preflight failed with HTTP ${preflight.status} (${preflightCode}).`,
      );
    }

    const tablesPath = `/v1/locations/${encodeURIComponent(locationId)}/tables`;
    const tablesResponse = await signedRequest(
      'GET',
      tablesPath,
      undefined,
      undefined,
      'table_list',
    );
    const tablesBody = (await tablesResponse.json()) as {
      data?: Array<{ external_table_id?: unknown; active?: unknown }>;
    };
    assertCertificationTableAvailable(externalTableId, tablesBody.data ?? []);
  }

  let externalBillId = process.env.RESTEC_CERTIFICATION_EXTERNAL_BILL_ID ?? '';
  let paymentSessionId =
    verifyExistingSessionId ?? process.env.RESTEC_CERTIFICATION_PAYMENT_SESSION_ID ?? '';
  let initialStatus = 'unknown';
  let operator: OperatorWaiter | undefined;
  const reportStage = (stage: CertificationStage, details: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ stage, ...details }));

  if (!verifyOnly) {
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    externalBillId = `CERT-${suffix}`;
    const billPath = `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`;
    const billBody = certificationBillBody(externalTableId, 1);
    await signedRequest('PUT', billPath, billBody, `cert-bill-${suffix}`, 'bill_upsert');
    reportStage('bill_created', { bill_id: externalBillId });
    const createPath = `${billPath}/payment-sessions`;
    const created = await createPaymentSessionWithCleanup({
      signedRequest,
      createPath,
      createBody: {
        amount_minor: 10_000,
        currency: 'PKR',
        method: 'card',
        customer: { email: 'sandbox@example.com', mobile: '03000000000' },
        return_context: { pos_reference: `cert-${suffix}` },
      },
      paymentIdempotencyKey: `cert-payment-${suffix}`,
      billPath,
      externalBillId,
      externalTableId,
      expectedCheckoutOrigin: baseUrl.origin,
    });
    paymentSessionId = created.paymentSessionId;
    initialStatus = created.status;
    const checkout = created.checkout;
    reportStage('payment_session_created', { payment_session_id: paymentSessionId });
    console.log(
      `Open this Restec sandbox checkout URL and manually complete payment:\n${checkout.toString()}`,
    );
    reportStage('checkout_opened');
    if (!process.argv.includes('--no-wait')) {
      const prompt = createInterface({ input: stdin, output: stdout });
      let closed = false;
      operator = {
        promise: new Promise<void>((resolve) => {
          prompt.question(
            'Press Enter after checkout returns; automatic detection is also active.\n',
            () => resolve(),
          );
        }),
        close: () => {
          if (closed) return;
          closed = true;
          prompt.close();
          stdin.pause();
        },
      };
    }
  } else if (!paymentSessionId) {
    throw new Error('Set RESTEC_CERTIFICATION_PAYMENT_SESSION_ID for --verify mode.');
  } else {
    initialStatus = verifyExistingSessionId
      ? 'requires_customer_action'
      : required('RESTEC_CERTIFICATION_INITIAL_STATUS');
    if (initialStatus !== 'requires_customer_action')
      throw new Error('--verify requires preserved evidence of the initial customer-action state.');
    reportStage('bill_created', { source: 'preserved_evidence' });
    reportStage('payment_session_created', {
      payment_session_id: paymentSessionId,
      source: 'preserved_evidence',
    });
    reportStage('checkout_opened', { source: 'preserved_evidence' });
  }

  const statusPath = `/v1/locations/${encodeURIComponent(locationId)}/payment-sessions/${encodeURIComponent(paymentSessionId)}`;
  const jobToken = required('RESTEC_INTERNAL_JOB_TOKEN');
  const evidenceUrl = new URL(
    `/api/internal/test/payment-sessions/${encodeURIComponent(paymentSessionId)}/evidence`,
    baseUrl,
  );
  const paelyBaseValue = process.env.PAELY_CERTIFICATION_DIAGNOSTICS_BASE_URL;
  const paelyToken = process.env.PAELY_CERTIFICATION_DIAGNOSTICS_TOKEN;
  const paelyBase = paelyBaseValue ? new URL(paelyBaseValue) : undefined;
  if (paelyBase && paelyBase.protocol !== 'https:')
    throw new Error('The Paely certification base URL must use HTTPS.');
  const paelyDispatchPath =
    process.env.PAELY_CERTIFICATION_DISPATCH_PATH ??
    '/api/internal/integrations/restec/v1/outbox/dispatch';
  if (!paelyDispatchPath.startsWith('/') || paelyDispatchPath.startsWith('//'))
    throw new Error('PAELY_CERTIFICATION_DISPATCH_PATH must be an absolute path.');
  const paelyDispatchUrl = paelyBase ? new URL(paelyDispatchPath, paelyBase) : undefined;

  const reportPollingResponse = (diagnostic: Record<string, unknown>) =>
    console.log(JSON.stringify(diagnostic));
  const traceResponse = async (source: string, attempt: number, response: Response) =>
    reportPollingHttpResponse(source, attempt, response.clone(), reportPollingResponse);

  const readRestecEvidence = async (attempt = 0) => {
    const response = await fetch(evidenceUrl, {
      headers: { Authorization: `Bearer ${jobToken}` },
    });
    await traceResponse('restec_evidence', attempt, response);
    if (!response.ok) await failure('certification evidence', response);
    return (await response.json()) as RestecCertificationEvidence;
  };
  const initialRestecEvidence = await readRestecEvidence(0);
  const paelyDiagnosticsUrl = paelyBase
    ? new URL(paelyCertificationDiagnosticsPath(initialRestecEvidence), paelyBase)
    : undefined;

  const readPaelyEvidence = async (attempt = 0) => {
    if (!paelyDiagnosticsUrl || !paelyToken)
      return {
        dispatcher_status: 'credentials_not_configured',
        dispatcher_acceleration: 'manual_dispatcher_acceleration_unavailable',
      };
    const response = await fetch(paelyDiagnosticsUrl, {
      headers: { Authorization: `Bearer ${paelyToken}` },
      signal: abortController.signal,
    });
    await traceResponse('paely_evidence', attempt, response);
    if (!response.ok) return { dispatcher_status: `diagnostics_http_${response.status}` };
    return (await response.json()) as PaelyCertificationEvidence;
  };
  const dispatchRestec = async (attempt = 0) => {
    const response = await fetch(new URL('/api/internal/jobs/dispatch-pos-events', baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
      signal: abortController.signal,
    });
    await traceResponse('restec_dispatcher', attempt, response);
    if (!response.ok) await failure('POS event dispatcher', response);
  };
  const dispatchPaely =
    paelyDispatchUrl && paelyToken
      ? async (attempt = 0) => {
          const response = await fetch(paelyDispatchUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${paelyToken}`,
              'Content-Type': 'application/json',
            },
            signal: abortController.signal,
          });
          await traceResponse('paely_dispatcher', attempt, response);
          if (!response.ok)
            throw new CertificationHttpError(
              'Paely integration outbox dispatcher',
              response.status,
              'dispatcher_rejected',
              undefined,
              response.status >= 500,
            );
        }
      : undefined;

  const onSigint = createCertificationCancellationHandler(abortController);
  process.once('SIGINT', onSigint);
  try {
    try {
      await monitorCertification({
        initialStatus,
        timeoutMs,
        operator,
        signal: abortController.signal,
        readRestecStatus: async (attempt) => {
          const response = await signedRequest('GET', statusPath);
          await traceResponse('restec_public_session', attempt, response);
          const status = (await response.json()) as PublicSessionStatus;
          externalBillId ||= status.external_bill_id ?? '';
          return status;
        },
        readPaelyEvidence,
        readRestecEvidence,
        dispatchPaely: verifyExistingSessionId ? undefined : dispatchPaely,
        dispatchRestec: verifyExistingSessionId ? undefined : dispatchRestec,
        reportStage,
        reportDiagnostic: (diagnostic) => console.error(JSON.stringify(diagnostic, null, 2)),
        reportPoll: reportPollingResponse,
      });
      process.exitCode = 0;
      abortController.abort();
    } catch (error) {
      if (overallTimedOut) throw new CertificationStateError('overall_timeout');
      if (abortController.signal.aborted) throw new CertificationCancelledError();
      throw error;
    }
  } finally {
    operator?.close();
    overallDeadline.close();
    process.removeListener('SIGINT', onSigint);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    if (error instanceof CertificationCancelledError) {
      process.exitCode = 130;
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
