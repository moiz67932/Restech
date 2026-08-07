import { randomUUID } from 'node:crypto';
import {
  paymentSessionStatusSchema,
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
  status: 'requires_customer_action';
  providerCheckoutUrl: string;
  amountMinor: number;
  currency: 'PKR';
  expiresAt: string;
}
export interface RefreshPrivatePaymentSessionExpectation {
  privatePaymentSessionId: string;
  amountMinor: number;
  currency: 'PKR';
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
export interface PrivateResponseDiagnostics {
  downstreamStatus: number;
  contentType: string | null;
  topLevelType: string;
  topLevelKeys: string[];
  nestedObjectKeys: Array<{ path: string; keys: string[] }>;
  schemaValidationIssues: Array<{
    path: string;
    code: string;
    expectedType: string;
    receivedType: string;
  }>;
  sessionStatusValue: string | null;
  checkoutUrlHost: string | null;
  requiredFieldsPresent: {
    privatePaymentSessionId: boolean;
    expiresAt: boolean;
  };
}
export interface PrivateDependencyDiagnostics {
  operation?: string | undefined;
  failureKind?: PrivateDependencyFailureKind | undefined;
  downstreamRequestId?: string | undefined;
  downstreamErrorCode?: string | undefined;
  providerRequestId?: string | undefined;
  attempts?: number | undefined;
  responseDiagnostics?: PrivateResponseDiagnostics | undefined;
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
  public readonly responseDiagnostics: PrivateResponseDiagnostics | undefined;
  public financiallyAmbiguous = false;

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
    this.responseDiagnostics = diagnostics.responseDiagnostics;
  }
}
interface PrivateSuccessMetadata {
  downstreamStatus: number;
  contentType: string | null;
  downstreamRequestId: string;
  providerRequestId?: string | undefined;
  attempts: number;
}
const valueType = (value: unknown): string =>
  value === undefined
    ? 'missing'
    : value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : typeof value;
const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const safeKey = (value: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : '[redacted_key]';
const safeKeys = (value: Record<string, unknown>): string[] =>
  Object.keys(value).slice(0, 50).map(safeKey).sort();
const valueAtPath = (value: unknown, path: Array<string | number>): unknown => {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    const record = objectRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
};
const expectedTypeForIssue = (issue: Record<string, unknown>): string => {
  if (typeof issue.expected === 'string') return issue.expected;
  if (issue.code === 'invalid_enum_value' && Array.isArray(issue.options)) return 'enum';
  if (issue.code === 'unrecognized_keys') return 'strict object without additional fields';
  if (issue.code === 'invalid_string' && issue.validation === 'datetime') return 'ISO datetime';
  if (issue.code === 'invalid_string' && issue.validation === 'url') return 'absolute URL';
  if (issue.code === 'too_small' || issue.code === 'too_big')
    return typeof issue.type === 'string' ? issue.type : 'value within bounds';
  return 'valid contract value';
};
const issueSummary = (
  value: unknown,
  issues: readonly unknown[],
): PrivateResponseDiagnostics['schemaValidationIssues'] =>
  issues.map((rawIssue) => {
    const issue = objectRecord(rawIssue) ?? {};
    const path = Array.isArray(issue.path)
      ? issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
      : [];
    return {
      path: path.length
        ? path
            .map((segment) => (typeof segment === 'string' ? safeKey(segment) : segment))
            .join('.')
        : '$',
      code: typeof issue.code === 'string' ? issue.code : 'invalid_value',
      expectedType: expectedTypeForIssue(issue),
      receivedType: valueType(valueAtPath(value, path)),
    };
  });
const nestedObjectKeySummary = (value: unknown): PrivateResponseDiagnostics['nestedObjectKeys'] => {
  const root = objectRecord(value);
  if (!root) return [];
  const result: PrivateResponseDiagnostics['nestedObjectKeys'] = [];
  const visit = (record: Record<string, unknown>, parentPath: string, depth: number) => {
    for (const [key, value] of Object.entries(record).slice(0, 50)) {
      const nested = objectRecord(value);
      if (!nested) continue;
      const path = parentPath ? `${parentPath}.${safeKey(key)}` : safeKey(key);
      result.push({ path, keys: safeKeys(nested) });
      if (depth < 2) visit(nested, path, depth + 1);
    }
  };
  visit(root, '', 1);
  return result.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 50);
};
const checkoutUrlHost = (value: unknown): string | null => {
  const root = objectRecord(value);
  if (!root) return null;
  const records = [
    root,
    ...Object.values(root)
      .map(objectRecord)
      .filter((entry) => entry !== null),
  ];
  for (const record of records) {
    for (const key of [
      'providerCheckoutUrl',
      'provider_checkout_url',
      'checkoutUrl',
      'checkout_url',
    ]) {
      const candidate = record[key];
      if (typeof candidate !== 'string') continue;
      try {
        return new URL(candidate).hostname.toLowerCase();
      } catch {
        return 'invalid_url';
      }
    }
  }
  return null;
};
const responseDiagnostics = (
  value: unknown,
  metadata: Pick<PrivateSuccessMetadata, 'downstreamStatus' | 'contentType'>,
  issues: readonly unknown[],
): PrivateResponseDiagnostics => {
  const root = objectRecord(value);
  return {
    downstreamStatus: metadata.downstreamStatus,
    contentType: metadata.contentType?.replace(/[^\x20-\x7e]/g, '').slice(0, 128) ?? null,
    topLevelType: valueType(value),
    topLevelKeys: root ? safeKeys(root) : [],
    nestedObjectKeys: nestedObjectKeySummary(value),
    schemaValidationIssues: issueSummary(value, issues),
    sessionStatusValue:
      typeof root?.status === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(root.status)
        ? root.status
        : null,
    checkoutUrlHost: checkoutUrlHost(value),
    requiredFieldsPresent: {
      privatePaymentSessionId:
        typeof root?.privatePaymentSessionId === 'string' &&
        root.privatePaymentSessionId.length > 0,
      expiresAt: typeof root?.expiresAt === 'string' && root.expiresAt.length > 0,
    },
  };
};
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
    const response = await this.rawRequestDetailed(
      'POST',
      `/api/internal/integrations/restec/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}/payment-sessions`,
      body,
      idempotencyKey,
      'payment_session_create',
    );
    return this.validatePaymentSessionResponse(response, 'payment_session_create', {
      amountMinor: body.amountMinor,
      currency: body.currency,
      requireHttps: false,
    });
  }
  async refreshPaymentSession(
    expected: RefreshPrivatePaymentSessionExpectation,
  ): Promise<PrivatePaymentSessionResult> {
    const response = await this.rawRequestDetailed(
      'POST',
      `/api/internal/integrations/restec/v1/payment-sessions/${encodeURIComponent(expected.privatePaymentSessionId)}/refresh`,
      {},
      undefined,
      'payment_session_refresh',
    );
    return this.validatePaymentSessionResponse(response, 'payment_session_refresh', {
      ...expected,
      requireHttps: true,
    });
  }
  private validatePaymentSessionResponse(
    response: { data: unknown; metadata: PrivateSuccessMetadata },
    operation: 'payment_session_create' | 'payment_session_refresh',
    expected: {
      privatePaymentSessionId?: string;
      amountMinor: number;
      currency: 'PKR';
      requireHttps: boolean;
    },
  ): PrivatePaymentSessionResult {
    const parsed = privatePaymentSessionResponseSchema.safeParse(response.data);
    if (!parsed.success)
      this.throwInvalidPaymentSessionResponse(response, operation, parsed.error.issues);
    const semanticIssues: Array<Record<string, unknown>> = [];
    if (
      expected.privatePaymentSessionId &&
      parsed.data.privatePaymentSessionId !== expected.privatePaymentSessionId
    )
      semanticIssues.push({
        path: ['privatePaymentSessionId'],
        code: 'identity_mismatch',
        expected: 'stored private payment-session identity',
      });
    if (parsed.data.amountMinor !== expected.amountMinor)
      semanticIssues.push({
        path: ['amountMinor'],
        code: 'request_value_mismatch',
        expected: 'request amount integer',
      });
    if (parsed.data.currency !== expected.currency)
      semanticIssues.push({
        path: ['currency'],
        code: 'request_value_mismatch',
        expected: 'request currency literal',
      });
    if (new Date(parsed.data.expiresAt).getTime() <= Date.now())
      semanticIssues.push({
        path: ['expiresAt'],
        code: 'not_in_future',
        expected: 'future ISO datetime',
      });
    if (expected.requireHttps && new URL(parsed.data.providerCheckoutUrl).protocol !== 'https:')
      semanticIssues.push({
        path: ['providerCheckoutUrl'],
        code: 'invalid_protocol',
        expected: 'HTTPS URL',
      });
    if (semanticIssues.length)
      this.throwInvalidPaymentSessionResponse(response, operation, semanticIssues);
    return parsed.data;
  }
  private throwInvalidPaymentSessionResponse(
    response: { data: unknown; metadata: PrivateSuccessMetadata },
    operation: 'payment_session_create' | 'payment_session_refresh',
    issues: readonly unknown[],
  ): never {
    throw new PrivateDependencyError(false, 502, {
      operation,
      failureKind: 'invalid_response',
      downstreamRequestId: response.metadata.downstreamRequestId,
      ...(response.metadata.providerRequestId
        ? { providerRequestId: response.metadata.providerRequestId }
        : {}),
      attempts: response.metadata.attempts,
      responseDiagnostics: responseDiagnostics(response.data, response.metadata, issues),
    });
  }
  async getPaymentSession(privatePaymentSessionId: string): Promise<PrivatePaymentSessionState> {
    const data = (await this.rawRequest(
      'GET',
      `/api/internal/integrations/restec/v1/payment-sessions/${encodeURIComponent(privatePaymentSessionId)}`,
      undefined,
      undefined,
      'payment_session_get',
    )) as PrivatePaymentSessionState;
    const parsedStatus = paymentSessionStatusSchema.safeParse(data?.status);
    if (
      !data ||
      typeof data.privatePaymentSessionId !== 'string' ||
      data.privatePaymentSessionId !== privatePaymentSessionId ||
      !parsedStatus.success ||
      !Number.isSafeInteger(data.amountMinor) ||
      data.amountMinor <= 0 ||
      data.currency !== 'PKR' ||
      typeof data.expiresAt !== 'string' ||
      !Number.isFinite(new Date(data.expiresAt).getTime())
    )
      throw new PrivateDependencyError(false, 502, {
        operation: 'payment_session_get',
        failureKind: 'invalid_response',
      });
    return { ...data, status: parsedStatus.data };
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
    return (await this.rawRequestDetailed(method, path, body, idempotencyKey, operation)).data;
  }
  private async rawRequestDetailed(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    operation?: string,
  ): Promise<{ data: unknown; metadata: PrivateSuccessMetadata }> {
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
            return {
              data: await response.json(),
              metadata: {
                downstreamStatus: response.status,
                contentType: response.headers.get('content-type'),
                downstreamRequestId: requestId,
                ...(response.headers.get('x-vercel-id')
                  ? { providerRequestId: response.headers.get('x-vercel-id')! }
                  : {}),
                attempts: attempt + 1,
              },
            };
          } catch {
            throw new PrivateDependencyError(false, 502, {
              operation,
              failureKind: 'invalid_response',
              downstreamRequestId: requestId,
              ...(response.headers.get('x-vercel-id')
                ? { providerRequestId: response.headers.get('x-vercel-id')! }
                : {}),
              attempts: attempt + 1,
              responseDiagnostics: responseDiagnostics(
                undefined,
                {
                  downstreamStatus: response.status,
                  contentType: response.headers.get('content-type'),
                },
                [
                  {
                    path: [],
                    code: 'invalid_json',
                    expected: 'JSON response body',
                  },
                ],
              ),
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
