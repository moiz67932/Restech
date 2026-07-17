import type {
  CanonicalBillInput,
  CanonicalExternalPaymentInput,
  CanonicalRestecEvent,
} from '@restec/contracts';

export type Environment = 'sandbox' | 'production';
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
export interface PublicTable {
  restec_table_id: string;
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
  saveBillState(
    connectionId: string,
    externalBillId: string,
    input: CanonicalBillInput,
    state: CanonicalBillState,
    requestHash: string,
    privateReference: string,
  ): Promise<CanonicalBillState>;
  getBill(connectionId: string, externalBillId: string): Promise<CanonicalBillState | null>;
  saveExternalPayment(
    connectionId: string,
    externalBillId: string,
    input: CanonicalExternalPaymentInput,
    state: CanonicalBillState,
    requestHash: string,
  ): Promise<CanonicalBillState>;
  acceptPrivateEvent(input: PrivateEventInput): Promise<{ eventId: string; duplicate: boolean }>;
  getConnectionForPrivateEvent(privateConnectionId: string): Promise<AuthorizedLocation | null>;
  claimPosOutboxEvents(limit: number, leaseSeconds: number): Promise<ClaimedPosOutboxEvent[]>;
  recordDeliveryAttempt(input: DeliveryAttempt): Promise<void>;
  markOutboxDelivered(eventId: string): Promise<void>;
  scheduleOutboxRetry(eventId: string, nextAttemptAt: Date, errorCode: string): Promise<void>;
  markOutboxDeadLetter(eventId: string, errorCode: string): Promise<void>;
  releaseExpiredLeases(): Promise<number>;
  replayOutboxEvent(eventId: string): Promise<void>;
  createSandboxEvent(connectionId: string, scenario: string): Promise<{ eventId: string }>;
  createAuditLog(input: AuditInput): Promise<void>;
}
