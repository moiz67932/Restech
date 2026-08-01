import type {
  CanonicalBillInput,
  CanonicalExternalPaymentInput,
  CanonicalRestecEvent,
  PaymentSessionMethod,
  PaymentSessionStatus,
} from '@restec/contracts';

export type Environment = 'sandbox' | 'production';
export type RepositoryErrorCode =
  | 'resource_not_found'
  | 'replay_detected'
  | 'idempotency_conflict'
  | 'bill_version_conflict'
  | 'payment_in_progress'
  | 'bill_already_paid'
  | 'amount_mismatch'
  | 'invalid_status_transition'
  | 'paely_connection_mapping_not_found'
  | 'paely_location_mapping_not_found'
  | 'connection_reference_mismatch'
  | 'location_reference_mismatch'
  | 'payment_session_reference_mismatch'
  | 'external_bill_reference_mismatch'
  | 'payment_method_mismatch'
  | 'payment_status_mismatch';
export class RepositoryError extends Error {
  public readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode) {
    super(code);
    this.code = code;
  }
}
export interface AuthenticatedPartner {
  partnerId: string;
  environment: Environment;
  signingSecret: string;
  status: 'active' | 'overlap';
  keyPrefix: string;
  expiresAt?: Date;
}
export interface AuthorizedLocation {
  connectionId: string;
  partnerId: string;
  locationId: string;
  environment: Environment;
  connectorType: string;
  connectorVersion: string;
  connectorEnabled: boolean;
  privateLocationId: string;
  privateConnectionId: string;
  configuration: Record<string, unknown>;
}
export interface PrivateLocationMapping {
  locationId: string;
  environment: Environment;
}
export interface PublicTable {
  table_id: string;
  external_table_id: string;
  name: string;
  active: boolean;
}
export interface TableMapping extends PublicTable {
  connection_id: string;
}
export interface CanonicalBillState {
  request_id: string;
  restec_bill_id: string;
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
export interface IdempotencyRecord {
  requestHash: string;
  method: string;
  path: string;
  status: 'processing' | 'completed' | 'failed';
  responseStatus?: number;
  responseBody?: unknown;
}
export type IdempotencyReservation =
  | { kind: 'new' }
  | { kind: 'replay'; result: IdempotencyRecord }
  | { kind: 'conflict' }
  | { kind: 'processing' };
export interface PrivateEventInput {
  privateEventId: string;
  eventType: string;
  schemaVersion: string;
  connectionId: string;
  requestHash: string;
  payload: unknown;
  publicEventId: string;
  publicPayload: CanonicalRestecEvent;
}
export interface ClaimedPosOutboxEvent {
  id: string;
  publicEventId: string;
  connectionId: string;
  eventType: string;
  schemaVersion: string;
  payload: CanonicalRestecEvent;
  attemptCount: number;
  configuration: Record<string, unknown>;
  connectorType: string;
  connectorVersion: string;
  connectorEnabled: boolean;
}
export interface DeliveryAttempt {
  eventId: string;
  attemptNumber: number;
  responseStatus?: number;
  outcome: 'delivered' | 'retry' | 'permanent_failure';
  errorCode?: string;
  durationMs: number;
}
export interface AuditInput {
  actorType: string;
  actorId?: string;
  partnerId?: string;
  connectionId?: string;
  requestId?: string;
  action: string;
  result: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}
export interface PaymentSessionRecord {
  id: string;
  publicPaymentSessionId: string;
  environment: Environment;
  partnerId: string;
  connectionId: string;
  locationId: string;
  externalBillId: string;
  privateLocationReference: string;
  privateConnectionReference: string;
  privatePaymentSessionReference?: string;
  encryptedProviderCheckoutUrl?: string;
  providerCheckoutHost?: string;
  method: PaymentSessionMethod;
  amountMinor: number;
  currency: 'PKR';
  status: PaymentSessionStatus;
  expiresAt: string;
  paidAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastPublicErrorCode?: string;
  lastPrivateStatus?: string;
}
export type CreatePaymentSessionInput = Omit<
  PaymentSessionRecord,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'privatePaymentSessionReference'
  | 'encryptedProviderCheckoutUrl'
  | 'providerCheckoutHost'
  | 'paidAt'
  | 'failedAt'
  | 'cancelledAt'
  | 'lastPublicErrorCode'
  | 'lastPrivateStatus'
>;
export interface AttachPaymentSessionInput {
  publicPaymentSessionId: string;
  privatePaymentSessionReference: string;
  encryptedProviderCheckoutUrl: string;
  providerCheckoutHost: string;
  status: 'requires_customer_action' | 'processing';
  expiresAt: string;
}
export interface CompletePaymentSessionCheckoutRefreshInput {
  publicPaymentSessionId: string;
  privatePaymentSessionReference: string;
  lockToken: string;
  encryptedProviderCheckoutUrl: string;
  providerCheckoutHost: string;
}
export interface PaymentSessionEventInput extends PrivateEventInput {
  publicPaymentSessionId: string;
  requestedStatus: PaymentSessionStatus;
}
export interface MockPosReceipt {
  eventId: string;
  connectionId: string;
  requestHash: string;
  eventType: string;
  receivedAt: string;
}
export interface PaymentSessionCertificationEvidence {
  paymentSessionStatus: PaymentSessionStatus;
  paidAt: string | null;
  billPaymentStatus: string | null;
  privateEventAccepted: boolean;
  paymentCompletedInboxCount: number;
  publicEventId: string | null;
  posOutboxStatus: string | null;
  paymentCompletedPosCount: number;
  deliveryAttempts: number;
  mockPosAccepted: boolean;
  matchingMockPosReceiptCount: number;
  deadLettered: boolean;
}
export interface RestecRepository {
  authenticateApiKey(
    apiKey: string,
    environment: Environment,
  ): Promise<AuthenticatedPartner | null>;
  recordApiKeyUsage(partnerId: string, keyPrefix: string): Promise<void>;
  reserveReplay(input: {
    requestId: string;
    partnerId: string;
    requestHash: string;
    environment: Environment;
    timestamp: number;
  }): Promise<boolean>;
  reserveIdempotency(
    partnerId: string,
    key: string,
    value: Omit<IdempotencyRecord, 'status'>,
  ): Promise<IdempotencyReservation>;
  completeIdempotency(partnerId: string, key: string, status: number, body: unknown): Promise<void>;
  releaseIdempotency(partnerId: string, key: string): Promise<void>;
  authorizeLocation(
    locationId: string,
    partnerId: string,
    environment: Environment,
  ): Promise<AuthorizedLocation | null>;
  listTables(connectionId: string): Promise<PublicTable[]>;
  getTableMapping(connectionId: string, externalTableId: string): Promise<TableMapping | null>;
  validateBillMutation(
    connectionId: string,
    externalBillId: string,
    version: number,
    requestHash: string,
  ): Promise<{ kind: 'proceed' } | { kind: 'replay'; state: CanonicalBillState }>;
  saveBillState(
    connectionId: string,
    externalBillId: string,
    input: CanonicalBillInput,
    state: CanonicalBillState,
    requestHash: string,
    privateReference: string,
  ): Promise<CanonicalBillState>;
  getBill(connectionId: string, externalBillId: string): Promise<CanonicalBillState | null>;
  validateExternalPayment(
    connectionId: string,
    externalBillId: string,
    input: CanonicalExternalPaymentInput,
    requestHash: string,
  ): Promise<{ kind: 'proceed' } | { kind: 'replay'; state: CanonicalBillState }>;
  saveExternalPayment(
    connectionId: string,
    externalBillId: string,
    input: CanonicalExternalPaymentInput,
    state: CanonicalBillState,
    requestHash: string,
  ): Promise<CanonicalBillState>;
  acceptPrivateEvent(input: PrivateEventInput): Promise<{ eventId: string; duplicate: boolean }>;
  getConnectionForPrivateEvent(privateConnectionId: string): Promise<AuthorizedLocation | null>;
  getLocationForPrivateEvent(privateLocationId: string): Promise<PrivateLocationMapping | null>;
  findSandboxConnection(
    partnerId: string,
    externalBillId: string,
  ): Promise<AuthorizedLocation | null>;
  claimPosOutboxEvents(limit: number, leaseSeconds: number): Promise<ClaimedPosOutboxEvent[]>;
  recordDeliveryAttempt(input: DeliveryAttempt): Promise<void>;
  completeOutboxDelivery(input: DeliveryAttempt & { responseStatus: number }): Promise<void>;
  failOutboxDelivery(
    input: DeliveryAttempt & { nextAttemptAt?: Date; errorCode: string },
  ): Promise<void>;
  markOutboxDelivered(eventId: string): Promise<void>;
  scheduleOutboxRetry(eventId: string, nextAttemptAt: Date, errorCode: string): Promise<void>;
  markOutboxDeadLetter(eventId: string, errorCode: string): Promise<void>;
  releaseExpiredLeases(): Promise<number>;
  replayOutboxEvent(eventId: string): Promise<void>;
  createSandboxEvent(
    connectionId: string,
    scenario: string,
    externalBillId: string,
    amount?: number,
  ): Promise<{ eventId: string }>;
  createAuditLog(input: AuditInput): Promise<void>;
  reservePaymentSession(
    input: CreatePaymentSessionInput,
  ): Promise<{ record: PaymentSessionRecord; created: boolean }>;
  attachPaymentSession(input: AttachPaymentSessionInput): Promise<PaymentSessionRecord>;
  claimPaymentSessionCheckoutRefresh(
    publicPaymentSessionId: string,
    lockToken: string,
    leaseSeconds: number,
  ): Promise<PaymentSessionRecord | null>;
  completePaymentSessionCheckoutRefresh(
    input: CompletePaymentSessionCheckoutRefreshInput,
  ): Promise<PaymentSessionRecord | null>;
  releasePaymentSessionCheckoutRefresh(
    publicPaymentSessionId: string,
    lockToken: string,
  ): Promise<void>;
  getPaymentSession(publicPaymentSessionId: string): Promise<PaymentSessionRecord | null>;
  transitionPaymentSession(
    publicPaymentSessionId: string,
    requestedStatus: PaymentSessionStatus,
    occurredAt: string,
  ): Promise<{ record: PaymentSessionRecord; changed: boolean }>;
  acceptPaymentSessionEvent(
    input: PaymentSessionEventInput,
  ): Promise<{ eventId: string; duplicate: boolean }>;
  getMockPosWebhookContext(
    eventId: string,
  ): Promise<{ connectionId: string; signingSecret: string } | null>;
  acceptMockPosReceipt(input: MockPosReceipt): Promise<{ duplicate: boolean }>;
  getLastMockPosReceipt(): Promise<MockPosReceipt | null>;
  getPaymentSessionCertificationEvidence(
    publicPaymentSessionId: string,
  ): Promise<PaymentSessionCertificationEvidence | null>;
  listPaymentSessionsForReconciliation(limit: number): Promise<PaymentSessionRecord[]>;
}
