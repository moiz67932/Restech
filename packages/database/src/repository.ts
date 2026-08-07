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
  | 'payment_capacity_conflict'
  | 'bill_financial_floor_conflict'
  | 'payment_outcome_ambiguous'
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
  | 'payment_status_mismatch'
  | 'table_active_bill_conflict'
  | 'bill_table_generation_conflict';
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
  scopes?: string[];
  locationScopes?: string[];
  credentialVersion?: number;
  graceEndsAt?: Date;
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
export interface CustomerTableView {
  status: 'active' | 'no_active_bill' | 'table_unavailable' | 'session_ended' | 'invalid_link';
  restaurant_name?: string;
  table_name?: string;
  bill?: Pick<
    CanonicalBillState,
    'order_status' | 'payment_status' | 'currency' | 'grand_total' | 'amount_paid' | 'amount_due'
  >;
}
export interface TableLifecycleSyncInput {
  connectionId: string;
  locationId: string;
  environment: Environment;
  externalTableId: string;
  externalBillId: string;
  version: number;
  terminal: boolean;
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
export type FinancialCorrectionType = 'refund' | 'void' | 'reversal' | 'chargeback' | 'dispute';
export type FinancialCorrectionStatus = 'completed' | 'ambiguous' | 'review_required';
export interface FinancialCorrection {
  correctionId: string;
  logicalIdentity: string;
  type: FinancialCorrectionType;
  status: FinancialCorrectionStatus;
  connectionId: string;
  externalBillId: string;
  originalPaymentId: string;
  amountMinor: number;
  currency: string;
  authority: 'provider';
  source: 'provider_event';
  occurredAt: string;
  reason?: string;
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
  partnerId: string;
  environment: Environment;
  eventType: string;
  schemaVersion: string;
  payload: CanonicalRestecEvent;
  attemptCount: number;
  configuration: Record<string, unknown>;
  connectorType: string;
  connectorVersion: string;
  connectorEnabled: boolean;
  /** Stable binding selected when the event entered the outbox. */
  signingSecretVersion: number;
  /** Decrypted only inside the delivery process; never serialize or log it. */
  webhookSigningSecret?: string;
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

export type ReconciliationCaseType =
  | 'payment_provider_ahead'
  | 'payment_restec_ahead'
  | 'payment_status_mismatch'
  | 'payment_amount_mismatch'
  | 'payment_currency_mismatch'
  | 'payment_identity_mismatch'
  | 'payment_missing_authoritative_event'
  | 'payment_late_success_capacity_conflict'
  | 'payment_ambiguous_outcome'
  | 'payment_session_stale_processing'
  | 'payment_session_expiry_pending_confirmation'
  | 'bill_projection_drift'
  | 'correction_missing_local_fact'
  | 'correction_projection_drift'
  | 'pos_event_dead_lettered'
  | 'pos_event_pending_too_long'
  | 'offboarding_pending_financial_work';
export type ReconciliationCaseSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReconciliationCaseStatus =
  | 'open'
  | 'auto_repair_pending'
  | 'manual_review_required'
  | 'in_progress'
  | 'resolved'
  | 'quarantined'
  | 'dismissed_with_evidence';
export interface ReconciliationCase {
  caseId: string;
  logicalIdentity: string;
  environment: Environment;
  partnerId: string;
  locationId: string;
  connectionId: string;
  subjectType: string;
  subjectId: string;
  caseType: ReconciliationCaseType;
  severity: ReconciliationCaseSeverity;
  status: ReconciliationCaseStatus;
  detectedAt: string;
  firstDetectedAt: string;
  lastCheckedAt: string;
  occurrenceCount: number;
  restecStateSnapshot: Record<string, unknown>;
  providerStateSnapshot?: Record<string, unknown>;
  posDeliveryStateSnapshot?: Record<string, unknown>;
  immutableFinancialEvidence?: Record<string, unknown>;
  differenceSummary: Record<string, unknown>;
  recommendedAction: string;
  automaticActionAllowed: boolean;
  assignedTo?: string;
  resolution?: string;
  resolutionEvidence?: Record<string, unknown>;
  resolvedAt?: string;
  createdBy: string;
  lastActionId?: string;
}
export interface ReconciliationAction {
  actionId: string;
  caseId: string;
  actionType: string;
  idempotencyIdentity: string;
  requestedBy: string;
  startedAt: string;
  completedAt?: string;
  result: string;
  error?: string;
  evidence?: Record<string, unknown>;
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
  privatePaymentSessionReference: string | undefined;
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
export type FinancialReservationState =
  | 'reserved'
  | 'ambiguous_pending_reconciliation'
  | 'completed'
  | 'failed_released'
  | 'expired_released'
  | 'cancelled_released';
export interface FinancialProjection {
  billTotalMinor: number;
  completedPaymentMinor: number;
  activeReservedMinor: number;
  ambiguousPendingMinor: number;
  refundedMinor: number;
  availableMinor: number;
}
export interface ReserveBillCapacityInput {
  connectionId: string;
  externalBillId: string;
  reservationIdentity: string;
  channel: 'external_payment' | 'digital_session';
  amountMinor: number;
  currency: string;
  requestHash: string;
  expiresAt?: string;
}
export interface FinancialReservationResult {
  state: FinancialReservationState;
  created: boolean;
  projection: FinancialProjection;
  completedState?: CanonicalBillState;
}
export interface ReserveBillMutationInput {
  connectionId: string;
  externalBillId: string;
  version: number;
  requestHash: string;
  newTotalMinor: number;
  currency: string;
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
  provisionTableQr(
    connectionId: string,
    externalTableId: string,
    tokenHash: string,
    environment: Environment,
  ): Promise<void>;
  resolveTableQr(
    tokenHash: string,
    environment: Environment,
  ): Promise<
    CustomerTableView & { tableSessionId?: string; connectionId?: string; locationId?: string }
  >;
  createCustomerVisit(
    tableSessionId: string,
    tokenHash: string,
    environment: Environment,
  ): Promise<void>;
  resolveCustomerVisit(tokenHash: string, environment: Environment): Promise<CustomerTableView>;
  syncTableLifecycle(input: TableLifecycleSyncInput): Promise<void>;
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
  reserveBillMutation(
    input: ReserveBillMutationInput,
  ): Promise<{ kind: 'proceed' } | { kind: 'replay'; state: CanonicalBillState }>;
  markBillMutationAmbiguous(
    connectionId: string,
    externalBillId: string,
    version: number,
    requestHash: string,
  ): Promise<void>;
  reserveBillCapacity(input: ReserveBillCapacityInput): Promise<FinancialReservationResult>;
  markFinancialReservationAmbiguous(
    connectionId: string,
    reservationIdentity: string,
    requestHash: string,
  ): Promise<void>;
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
  recordProviderCorrection(input: FinancialCorrection): Promise<{
    correction: FinancialCorrection;
    duplicate: boolean;
    bill: CanonicalBillState;
  }>;
  listFinancialCorrections(
    connectionId: string,
    externalBillId: string,
  ): Promise<FinancialCorrection[]>;
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
  upsertReconciliationCase?(
    input: Omit<
      ReconciliationCase,
      'caseId' | 'firstDetectedAt' | 'lastCheckedAt' | 'occurrenceCount'
    >,
  ): Promise<ReconciliationCase>;
  getReconciliationCase?(caseId: string): Promise<ReconciliationCase | null>;
  recordReconciliationAction?(input: ReconciliationAction): Promise<ReconciliationAction>;
  resolveReconciliationCase?(
    caseId: string,
    resolution: string,
    evidence: Record<string, unknown>,
  ): Promise<void>;
}
