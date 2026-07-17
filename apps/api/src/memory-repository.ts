import { randomUUID } from 'node:crypto';
import type {
  AuditInput,
  AuthorizedLocation,
  CanonicalBillState,
  ClaimedPosOutboxEvent,
  DeliveryAttempt,
  Environment,
  IdempotencyRecord,
  PrivateEventInput,
  RestecRepository,
} from '@restec/database';
import type { CanonicalBillInput, CanonicalExternalPaymentInput } from '@restec/contracts';
export class MemoryRepository implements RestecRepository {
  credentials = new Map<string, any>();
  connections = new Map<string, AuthorizedLocation>();
  requests = new Set<string>();
  idempotency = new Map<string, IdempotencyRecord>();
  bills = new Map<string, CanonicalBillState>();
  events = new Map<string, string>();
  outbox = new Map<string, ClaimedPosOutboxEvent>();
  attempts: DeliveryAttempt[] = [];
  audits: AuditInput[] = [];
  async authenticateApiKey(key: string, environment: Environment) {
    const value = this.credentials.get(key);
    return value?.environment === environment ? value : null;
  }
  async recordApiKeyUsage() {}
  async reserveReplay(input: { requestId: string }) {
    if (this.requests.has(input.requestId)) return false;
    this.requests.add(input.requestId);
    return true;
  }
  async reserveIdempotency(
    partnerId: string,
    key: string,
    value: Omit<IdempotencyRecord, 'status'>,
  ) {
    const id = `${partnerId}:${key}`,
      old = this.idempotency.get(id);
    if (!old) {
      this.idempotency.set(id, { ...value, status: 'processing' });
      return { kind: 'new' } as const;
    }
    if (
      old.requestHash !== value.requestHash ||
      old.method !== value.method ||
      old.path !== value.path
    )
      return { kind: 'conflict' } as const;
    if (old.status === 'processing') return { kind: 'processing' } as const;
    if (old.status === 'failed') {
      this.idempotency.set(id, { ...old, status: 'processing' });
      return { kind: 'new' } as const;
    }
    return { kind: 'replay', result: old } as const;
  }
  async completeIdempotency(partnerId: string, key: string, status: number, body: unknown) {
    const value = this.idempotency.get(`${partnerId}:${key}`);
    if (value)
      this.idempotency.set(`${partnerId}:${key}`, {
        ...value,
        status: 'completed',
        responseStatus: status,
        responseBody: body,
      });
  }
  async releaseIdempotency(partnerId: string, key: string) {
    const id = `${partnerId}:${key}`;
    const value = this.idempotency.get(id);
    if (value) this.idempotency.set(id, { ...value, status: 'failed' });
  }
  async authorizeLocation(locationId: string, partnerId: string, environment: Environment) {
    return (
      [...this.connections.values()].find(
        (v) =>
          v.locationId === locationId && v.partnerId === partnerId && v.environment === environment,
      ) ?? null
    );
  }
  async listTables() {
    return [];
  }
  async getTableMapping() {
    return null;
  }
  async saveBillState(
    connectionId: string,
    externalBillId: string,
    _input: CanonicalBillInput,
    state: CanonicalBillState,
  ) {
    this.bills.set(`${connectionId}:${externalBillId}`, state);
    return state;
  }
  async getBill(connectionId: string, externalBillId: string) {
    return this.bills.get(`${connectionId}:${externalBillId}`) ?? null;
  }
  async saveExternalPayment(
    connectionId: string,
    externalBillId: string,
    _input: CanonicalExternalPaymentInput,
    state: CanonicalBillState,
  ) {
    this.bills.set(`${connectionId}:${externalBillId}`, state);
    return state;
  }
  async acceptPrivateEvent(input: PrivateEventInput) {
    const old = this.events.get(input.privateEventId);
    if (old) return { eventId: old, duplicate: true };
    this.events.set(input.privateEventId, input.publicEventId);
    const connection = [...this.connections.values()].find(
      (v) => v.privateConnectionId === input.connectionId,
    );
    this.outbox.set(input.publicEventId, {
      id: randomUUID(),
      publicEventId: input.publicEventId,
      connectionId: connection?.connectionId ?? input.connectionId,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion,
      payload: input.publicPayload,
      attemptCount: 0,
      configuration: connection?.configuration ?? {},
      connectorType: connection?.connectorType ?? 'mock_pos',
      connectorVersion: connection?.connectorVersion ?? '1.0.0',
      connectorEnabled: true,
    });
    return { eventId: input.publicEventId, duplicate: false };
  }
  async getConnectionForPrivateEvent(id: string) {
    return [...this.connections.values()].find((v) => v.privateConnectionId === id) ?? null;
  }
  async claimPosOutboxEvents(limit: number) {
    return [...this.outbox.values()].slice(0, limit);
  }
  async recordDeliveryAttempt(input: DeliveryAttempt) {
    this.attempts.push(input);
  }
  async markOutboxDelivered(id: string) {
    this.outbox.delete(id);
  }
  async scheduleOutboxRetry() {}
  async markOutboxDeadLetter(id: string) {
    this.outbox.delete(id);
  }
  async releaseExpiredLeases() {
    return 0;
  }
  async replayOutboxEvent() {}
  async createSandboxEvent(connectionId: string, scenario: string) {
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    this.audits.push({
      actorType: 'sandbox',
      connectionId,
      action: 'sandbox.scenario.created',
      result: 'accepted',
      targetId: eventId,
      metadata: { scenario },
    });
    return { eventId };
  }
  async createAuditLog(input: AuditInput) {
    this.audits.push(input);
  }
}
