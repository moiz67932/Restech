import { randomUUID } from 'node:crypto';
import type { CanonicalBillInput, CanonicalExternalPaymentInput } from '@restec/contracts';
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
export class PrivateDependencyError extends Error {
  constructor(
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super('Private dependency request failed');
  }
}
const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
export class PaelyClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: PrivateClientConfig) {
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
    )) as PrivateBillState;
    return { publicState: this.sanitizeBill(data), privateBillReference: data.integration_bill_id };
  }
  async getBill(locationId: string, externalBillId: string) {
    return this.request(
      'GET',
      `/api/internal/integrations/restec/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`,
      undefined,
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
    );
  }
  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<PublicBillState> {
    const data = (await this.rawRequest(method, path, body, idempotencyKey)) as PrivateBillState;
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
  ): Promise<unknown> {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    let lastStatus = 503;
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
        lastStatus = response.status;
        if (response.ok) return response.json();
        if (!retryable.has(response.status) || attempt === 2)
          throw new PrivateDependencyError(retryable.has(response.status), response.status);
      } catch (error) {
        if (error instanceof PrivateDependencyError) throw error;
        if (attempt === 2) throw new PrivateDependencyError(true, lastStatus);
      }
    }
    throw new PrivateDependencyError(true, lastStatus);
  }
}
export const derivePrivateIdempotencyKey = (
  partnerId: string,
  publicKey: string,
  operation: string,
) => `restec:${partnerId}:${publicKey}:${operation}`;
