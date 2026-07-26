import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
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
  const verifyOnly = process.argv.includes('--verify');
  const cleanupOnly = process.argv.includes('--cleanup');
  const timeoutMs = Number(process.env.RESTEC_CERTIFICATION_TIMEOUT_SECONDS ?? 900) * 1000;

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

  const health = await fetch(new URL('/health', baseUrl));
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
  }

  let externalBillId = process.env.RESTEC_CERTIFICATION_EXTERNAL_BILL_ID ?? '';
  let paymentSessionId = process.env.RESTEC_CERTIFICATION_PAYMENT_SESSION_ID ?? '';
  let checkoutOrigin = baseUrl.origin;
  let initialStatus = 'unknown';

  if (!verifyOnly) {
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    externalBillId = `CERT-${suffix}`;
    const billPath = `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`;
    const billBody = certificationBillBody(externalTableId, 1);
    await signedRequest('PUT', billPath, billBody, `cert-bill-${suffix}`, 'bill_upsert');
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
    checkoutOrigin = checkout.origin;
    console.log(`Restec checkout URL: ${checkout.toString()}`);
    if (!process.argv.includes('--no-wait')) {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        await prompt.question(
          'Open that URL and manually complete the sandbox hosted checkout. Press Enter afterward.',
        );
      } finally {
        prompt.close();
      }
    }
  } else if (!paymentSessionId) {
    throw new Error('Set RESTEC_CERTIFICATION_PAYMENT_SESSION_ID for --verify mode.');
  } else {
    initialStatus = required('RESTEC_CERTIFICATION_INITIAL_STATUS');
    if (initialStatus !== 'requires_customer_action')
      throw new Error('--verify requires preserved evidence of the initial customer-action state.');
  }

  const statusPath = `/v1/locations/${encodeURIComponent(locationId)}/payment-sessions/${encodeURIComponent(paymentSessionId)}`;
  const deadline = Date.now() + timeoutMs;
  let finalStatus = 'unknown';
  while (Date.now() < deadline) {
    const response = await signedRequest('GET', statusPath);
    const status = (await response.json()) as {
      status: string;
      external_bill_id: string;
    };
    finalStatus = status.status;
    externalBillId ||= status.external_bill_id;
    if (finalStatus === 'paid') break;
    if (['failed', 'expired', 'refunded'].includes(finalStatus))
      throw new Error(`Certification stopped in terminal state ${finalStatus}.`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (finalStatus !== 'paid') throw new Error('Timed out waiting for authoritative paid state.');

  const jobToken = required('RESTEC_INTERNAL_JOB_TOKEN');
  const dispatch = await fetch(new URL('/api/internal/jobs/dispatch-pos-events', baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
  });
  if (!dispatch.ok) await failure('POS event dispatcher', dispatch);

  let evidence: any;
  while (Date.now() < deadline) {
    const response = await fetch(
      new URL(
        `/api/internal/test/payment-sessions/${encodeURIComponent(paymentSessionId)}/evidence`,
        baseUrl,
      ),
      { headers: { Authorization: `Bearer ${jobToken}` } },
    );
    if (!response.ok) await failure('certification evidence', response);
    evidence = await response.json();
    if (evidence.pos_outbox_status === 'delivered' && evidence.mock_pos_accepted) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const passed =
    initialStatus === 'requires_customer_action' &&
    finalStatus === 'paid' &&
    evidence?.private_event_accepted === true &&
    evidence?.bill_payment_status === 'paid' &&
    evidence?.pos_outbox_status === 'delivered' &&
    evidence?.mock_pos_accepted === true &&
    evidence?.dead_lettered === false;
  console.log(
    JSON.stringify(
      {
        result: passed ? 'PASS' : 'FAIL',
        bill_id: externalBillId,
        payment_session_id: paymentSessionId,
        checkout_origin: checkoutOrigin,
        initial_status: initialStatus,
        final_status: finalStatus,
        private_event_accepted: evidence?.private_event_accepted ?? false,
        bill_projection_paid: evidence?.bill_payment_status === 'paid',
        pos_outbox_delivered: evidence?.pos_outbox_status === 'delivered',
        dummy_pos_accepted: evidence?.mock_pos_accepted ?? false,
        webhook_signature_verified: evidence?.mock_pos_accepted ?? false,
        delivery_attempts: evidence?.delivery_attempts ?? null,
        dead_lettered: evidence?.dead_lettered ?? null,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
