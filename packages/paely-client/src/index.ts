import { randomUUID } from 'node:crypto';
import {
  privatePaymentSessionResponseSchema,
  type CanonicalBillInput,
  type CanonicalExternalPaymentInput,
  type PaymentSessionMethod,
  type PaymentSessionStatus,
} from '@restec/contracts';
import { signRequest } from '@restec/security';

export interface PrivateClientConfig {
  baseUrl: string;
  bearerToken: string;
  serviceId: string;
  environment: 'sandbox' | 'production';
  signingSecret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}
export interface PrivateBillState {
  integration_bill_id: string;
  external_bill_id: string;
  external_table_id: string;
  sync_status: 'accepted';
  order_status: string;
  payment_status: string;
  table_session_status: string;
  currency: string;
  grand_total: number;
  amount_paid: number;
  amount_refunded: number;
  amount_due: number;
  version: number;
  reconciliation_status: string;
  updated_at: string;
  paely_order_id?: string;
}
export interface PublicBillState {
  external_bill_id: string;
  external_table_id: string;
  sync_status: 'accepted';
  order_status: string;
  payment_status: string;
  table_session_status: string;
  currency: string;
  grand_total: number;
  amount_paid: number;
  amount_refunded: number;
  amount_due: number;
  version: number;
  reconciliation_status: string;
  updated_at: string;
}
export interface CreatePrivatePaymentSessionInput {
  connectionId: string;
  amountMinor: number;
  currency: 'PKR';
  method: PaymentSessionMethod;
  customer?: { email?: string; mobile?: string };
  returnUrls: { success: string; cancel: string };
  restecPaymentSessionReference: string;
}
export interface PrivatePaymentSessionResult {
  privatePaymentSessionId: string;
  status: 'requires_customer_action' | 'processing';
  providerCheckoutUrl: string;
  amountMinor: number;
  currency: 'PKR';
  expiresAt: string;
}
export interface PrivatePaymentSessionState {
  privatePaymentSessionId: string;
  restecPaymentSessionReference?: string;
  status: PaymentSessionStatus;
  amountMinor: number;
  currency: 'PKR';
  expiresAt: string;
  paidAt?: string | null;
}
export type PrivateDependencyFailureKind = 'http' | 'network' | 'timeout' | 'invalid_response';
export interface PrivateDependencyDiagnostics {
  operation?: string | undefined;
  failureKind?: PrivateDependencyFailureKind | undefined;
  downstreamRequestId?: string | undefined;
  downstreamErrorCode?: string | undefined;
  providerRequestId?: string | undefined;
  attempts?: number | undefined;
}
export class PrivateDependencyError extends Error {
  public readonly dependency = 'paely_private_api';
  public readonly retryable: boolean;
  public readonly status: number;
  public readonly operation: string | undefined;
  public readonly failureKind: PrivateDependencyFailureKind | undefined;
  public readonly downstreamRequestId: string | undefined;
  public readonly downstreamErrorCode: string | undefined;
  public readonly providerRequestId: string | undefined;
  public readonly attempts: number | undefined;

  constructor(retryable: boolean, status: number, diagnostics: PrivateDependencyDiagnostics = {}) {
    super('Private dependency request failed');
    this.name = 'PrivateDependencyError';
    this.retryable = retryable;
    this.status = status;
    this.operation = diagnostics.operation;
    this.failureKind = diagnostics.failureKind;
    this.downstreamRequestId = diagnostics.downstreamRequestId;
    this.downstreamErrorCode = diagnostics.downstreamErrorCode;
    this.providerRequestId = diagnostics.providerRequestId;
    this.attempts = diagnostics.attempts;
  }
}
const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
const errorMetadata = async (response: Response) => {
  let downstreamErrorCode: string | undefined;
  let downstreamRequestId: string | undefined;
  try {
    const text = await response.text();
    if (text) {
      const body = JSON.parse(text) as {
        code?: unknown;
        request_id?: unknown;
        error?: { code?: unknown; request_id?: unknown };
      };
      const code = body.error?.code ?? body.code;
      const requestId = body.error?.request_id ?? body.request_id;
      if (typeof code === 'string') downstreamErrorCode = code;
      if (typeof requestId === 'string') downstreamRequestId = requestId;
    }
  } catch {
    // Error bodies are consumed but never exposed or logged.
  }
  return {
    ...(downstreamErrorCode ? { downstreamErrorCode } : {}),
    ...(downstreamRequestId ? { downstreamRequestId } : {}),
    ...(response.headers.get('x-vercel-id')
      ? { providerRequestId: response.headers.get('x-vercel-id')! }
      : {}),
  };
};
const failureKind = (error: unknown): PrivateDependencyFailureKind =>
  error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)
    ? 'timeout'
    : 'network';
export class PaelyClient {
  private readonly config: PrivateClientConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: PrivateClientConfig) {
    this.config = config;
    this.fetcher = config.fetch ?? fetch;
  }
  async upsertBill(
    locationId: string,
    externalBillId: string,
    body: CanonicalBillInput,
    idempotencyKey: string,
  ) {
    return (await this.upsertBillDetailed(locationId, externalBillId, body, idempotencyKey))
      .publicState;
  }
  async upsertBillDetailed(
    locationId: string,
    externalBillId: string,
    body: CanonicalBillInput,
    idempotencyKey: string,
  ): Promise<{ publicState: PublicBillState; privateBillReference: string }> {
    const data = (await this.rawRequest(
      'PUT',
      `/api/internal/integrations/restec/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`,
      body,
      idempotencyKey,
      'bill_upsert',
    )) as PrivateBillState;
    return { publicState: this.sanitizeBill(data), privateBillReference: data.integration_bill_id };
  }
  async getBill(locationId: string, externalBillId: string) {
    return this.request(
      'GET',
      `/api/internal/integrations/restec/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`,
      undefined,
      undefined,
      'bill_get',
    );
  }
  async recordExternalPayment(
    locationId: string,
    externalBillId: string,
    body: CanonicalExternalPaymentInput,
    idempotencyKey: string,
  ) {
    return this.request(
      'POST',
      `/api/internal/integrations/restec/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}/external-payments`,
      body,
      idempotencyKey,
      'external_payment',
    );
  }
  async upsertTableMapping(
    connectionId: string,
    externalTableId: string,
    body: {
      paely_table_id: string;
      external_table_name?: string;
      active?: boolean;
      metadata?: Record<string, unknown>;
    },
    idempotencyKey: string,
  ) {
    return this.rawRequest(
      'PUT',
      `/api/internal/integrations/restec/v1/connections/${encodeURIComponent(connectionId)}/table-mappings/${encodeURIComponent(externalTableId)}`,
      body,
      idempotencyKey,
      'table_mapping_upsert',
    );
  }
  async createPaymentSession(
    locationId: string,
    externalBillId: string,
    body: CreatePrivatePaymentSessionInput,
    idempotencyKey: string,
  ): Promise<PrivatePaymentSessionResult> {
    const data = await this.rawRequest(
      'POST',
      `/api/internal/integrations/restec/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}/payment-sessions`,
      body,
      idempotencyKey,
      'payment_session_create',
    );
    const parsed = privatePaymentSessionResponseSchema.safeParse(data);
    if (!parsed.success)
      throw new PrivateDependencyError(false, 502, {
        operation: 'payment_session_create',
        failureKind: 'invalid_response',
      });
    return parsed.data;
  }
  async getPaymentSession(privatePaymentSessionId: string): Promise<PrivatePaymentSessionState> {
    const data = (await this.rawRequest(
      'GET',
      `/api/internal/integrations/restec/v1/payment-sessions/${encodeURIComponent(privatePaymentSessionId)}`,
      undefined,
      undefined,
      'payment_session_get',
    )) as PrivatePaymentSessionState;
    if (
      !data ||
      typeof data.privatePaymentSessionId !== 'string' ||
      typeof data.status !== 'string' ||
      !Number.isSafeInteger(data.amountMinor) ||
      data.currency !== 'PKR'
    )
      throw new PrivateDependencyError(false, 502, {
        operation: 'payment_session_get',
        failureKind: 'invalid_response',
      });
    return data;
  }
  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    operation?: string,
  ): Promise<PublicBillState> {
    const data = (await this.rawRequest(
      method,
      path,
      body,
      idempotencyKey,
      operation,
    )) as PrivateBillState;
    return this.sanitizeBill(data);
  }
  private sanitizeBill(data: PrivateBillState): PublicBillState {
    return {
      external_bill_id: data.external_bill_id,
      external_table_id: data.external_table_id,
      sync_status: data.sync_status,
      order_status: data.order_status,
      payment_status: data.payment_status,
      table_session_status: data.table_session_status,
      currency: data.currency,
      grand_total: data.grand_total,
      amount_paid: data.amount_paid,
      amount_refunded: data.amount_refunded,
      amount_due: data.amount_due,
      version: data.version,
      reconciliation_status: data.reconciliation_status,
      updated_at: data.updated_at,
    };
  }
  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    operation?: string,
  ): Promise<unknown> {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    for (let attempt = 0; attempt < 3; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);
      const requestId = `req_${randomUUID().replaceAll('-', '')}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.bearerToken}`,
        'X-Restec-Service-Id': this.config.serviceId,
        'X-Restec-Environment': this.config.environment,
        'X-Restec-Timestamp': String(timestamp),
        'X-Restec-Signature': signRequest(
          this.config.signingSecret,
          timestamp,
          method,
          path,
          rawBody,
        ),
        'X-Request-Id': requestId,
        'Content-Type': 'application/json',
      };
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      try {
        const init: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        };
        if (body !== undefined) init.body = rawBody;
        const response = await this.fetcher(new URL(path, this.config.baseUrl), init);
        if (response.ok) {
          try {
            return await response.json();
          } catch {
            throw new PrivateDependencyError(false, 502, {
              operation,
              failureKind: 'invalid_response',
              downstreamRequestId: requestId,
              attempts: attempt + 1,
            });
          }
        }
        const metadata = await errorMetadata(response);
        const canRetry = retryable.has(response.status);
        if (!canRetry || attempt === 2)
          throw new PrivateDependencyError(canRetry, response.status, {
            operation,
            failureKind: 'http',
            downstreamRequestId: metadata.downstreamRequestId ?? requestId,
            ...(metadata.downstreamErrorCode
              ? { downstreamErrorCode: metadata.downstreamErrorCode }
              : {}),
            ...(metadata.providerRequestId
              ? { providerRequestId: metadata.providerRequestId }
              : {}),
            attempts: attempt + 1,
          });
      } catch (error) {
        if (error instanceof PrivateDependencyError) throw error;
        if (attempt === 2) {
          const kind = failureKind(error);
          throw new PrivateDependencyError(true, kind === 'timeout' ? 504 : 503, {
            operation,
            failureKind: kind,
            downstreamRequestId: requestId,
            attempts: attempt + 1,
          });
        }
      }
    }
    throw new PrivateDependencyError(true, 503, {
      operation,
      failureKind: 'network',
      attempts: 3,
    });
  }
}
export const derivePrivateIdempotencyKey = (
  partnerId: string,
  publicKey: string,
  operation: string,
) => `restec:${partnerId}:${publicKey}:${operation}`;
