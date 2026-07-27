import { randomUUID } from 'node:crypto';
import { RepositoryError } from '@restec/database';
import type {
  AuditInput,
  AuthorizedLocation,
  CanonicalBillState,
  ClaimedPosOutboxEvent,
  DeliveryAttempt,
  Environment,
  IdempotencyRecord,
  PrivateEventInput,
  PaymentSessionRecord,
  CreatePaymentSessionInput,
  AttachPaymentSessionInput,
  CompletePaymentSessionCheckoutRefreshInput,
  PaymentSessionEventInput,
  MockPosReceipt,
  RestecRepository,
} from '@restec/database';
import {
  eventSchema,
  transitionPaymentSessionStatus,
  type CanonicalBillInput,
  type CanonicalExternalPaymentInput,
  type PaymentSessionStatus,
} from '@restec/contracts';
import { sha256 } from '@restec/security';
export class MemoryRepository implements RestecRepository {
  credentials = new Map<string, any>();
  connections = new Map<string, AuthorizedLocation>();
  requests = new Set<string>();
  idempotency = new Map<string, IdempotencyRecord>();
  bills = new Map<string, CanonicalBillState>();
  billRequests = new Map<string, { version: number; requestHash: string }>();
  payments = new Map<
    string,
    { externalBillId: string; requestHash: string; state: CanonicalBillState }
  >();
  tables = new Map<string, any>();
  events = new Map<string, string>();
  eventHashes = new Map<string, string>();
  outbox = new Map<string, ClaimedPosOutboxEvent>();
  attempts: DeliveryAttempt[] = [];
  audits: AuditInput[] = [];
  paymentSessions = new Map<string, PaymentSessionRecord>();
  paymentSessionCheckoutRefreshLeases = new Map<string, { lockToken: string; expiresAt: number }>();
  mockPosReceipts = new Map<string, MockPosReceipt>();
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
  async listTables(connectionId: string) {
    return [...this.tables.values()].filter((table) => table.connection_id === connectionId);
  }
  async getTableMapping(connectionId: string, externalTableId: string) {
    return (
      [...this.tables.values()].find(
        (table) =>
          table.connection_id === connectionId && table.external_table_id === externalTableId,
      ) ?? null
    );
  }
  async validateBillMutation(
    connectionId: string,
    externalBillId: string,
    version: number,
    requestHash: string,
  ) {
    const key = `${connectionId}:${externalBillId}`;
    const existing = this.billRequests.get(key);
    if (!existing) {
      if (version !== 1) throw new RepositoryError('bill_version_conflict');
      return { kind: 'proceed' } as const;
    }
    if (
      version < existing.version ||
      (version === existing.version && requestHash !== existing.requestHash)
    )
      throw new RepositoryError('bill_version_conflict');
    if (version === existing.version)
      return { kind: 'replay', state: this.bills.get(key)! } as const;
    return { kind: 'proceed' } as const;
  }
  async saveBillState(
    connectionId: string,
    externalBillId: string,
    input: CanonicalBillInput,
    state: CanonicalBillState,
    requestHash: string,
  ) {
    const key = `${connectionId}:${externalBillId}`;
    const existing = this.bills.get(key);
    if (existing && input.totals.grand_total < existing.amount_paid - existing.amount_refunded)
      throw new RepositoryError('amount_mismatch');
    this.bills.set(key, state);
    this.billRequests.set(key, { version: input.version, requestHash });
    return state;
  }
  async getBill(connectionId: string, externalBillId: string) {
    return this.bills.get(`${connectionId}:${externalBillId}`) ?? null;
  }
  async validateExternalPayment(
    connectionId: string,
    externalBillId: string,
    input: CanonicalExternalPaymentInput,
    requestHash: string,
  ) {
    const bill = this.bills.get(`${connectionId}:${externalBillId}`);
    if (!bill) throw new RepositoryError('resource_not_found');
    const key = `${connectionId}:${input.external_payment_id}`;
    const existing = this.payments.get(key);
    if (existing) {
      if (existing.externalBillId !== externalBillId || existing.requestHash !== requestHash)
        throw new RepositoryError('idempotency_conflict');
      return { kind: 'replay', state: existing.state } as const;
    }
    if (bill.currency !== input.currency) throw new RepositoryError('amount_mismatch');
    if (bill.payment_status === 'payment_in_progress')
      throw new RepositoryError('payment_in_progress');
    if (bill.amount_due === 0 || input.amount > bill.amount_due)
      throw new RepositoryError('bill_already_paid');
    return { kind: 'proceed' } as const;
  }
  async saveExternalPayment(
    connectionId: string,
    externalBillId: string,
    input: CanonicalExternalPaymentInput,
    state: CanonicalBillState,
    requestHash: string,
  ) {
    this.bills.set(`${connectionId}:${externalBillId}`, state);
    this.payments.set(`${connectionId}:${input.external_payment_id}`, {
      externalBillId,
      requestHash,
      state,
    });
    return state;
  }
  async acceptPrivateEvent(input: PrivateEventInput) {
    const old = this.events.get(input.privateEventId);
    if (old) {
      if (this.eventHashes.get(input.privateEventId) !== input.requestHash)
        throw new RepositoryError('replay_detected');
      return { eventId: old, duplicate: true };
    }
    this.events.set(input.privateEventId, input.publicEventId);
    this.eventHashes.set(input.privateEventId, input.requestHash);
    const connection = [...this.connections.values()].find(
      (v) => v.connectionId === input.connectionId || v.privateConnectionId === input.connectionId,
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
    const billKey = `${input.connectionId}:${input.publicPayload.data.external_bill_id}`;
    const bill = this.bills.get(billKey);
    if (bill) {
      this.bills.set(billKey, {
        ...bill,
        ...input.publicPayload.data.bill,
        updated_at: input.publicPayload.created_at,
      });
    }
    return { eventId: input.publicEventId, duplicate: false };
  }
  async getConnectionForPrivateEvent(id: string) {
    return [...this.connections.values()].find((v) => v.privateConnectionId === id) ?? null;
  }
  async findSandboxConnection(partnerId: string, externalBillId: string) {
    const candidates = [...this.connections.values()].filter(
      (connection) => connection.partnerId === partnerId && connection.environment === 'sandbox',
    );
    return (
      candidates.find((connection) =>
        this.bills.has(`${connection.connectionId}:${externalBillId}`),
      ) ?? (candidates.length === 1 ? candidates[0]! : null)
    );
  }
  async claimPosOutboxEvents(limit: number) {
    return [...this.outbox.values()]
      .filter(
        (event) => !(event as any).nextAttemptAt || (event as any).nextAttemptAt <= new Date(),
      )
      .slice(0, limit);
  }
  async recordDeliveryAttempt(input: DeliveryAttempt) {
    this.attempts.push(input);
  }
  async completeOutboxDelivery(input: DeliveryAttempt & { responseStatus: number }) {
    await this.recordDeliveryAttempt(input);
    await this.markOutboxDelivered(input.eventId);
  }
  async failOutboxDelivery(input: DeliveryAttempt & { nextAttemptAt?: Date; errorCode: string }) {
    await this.recordDeliveryAttempt(input);
    if (input.outcome === 'permanent_failure') await this.markOutboxDeadLetter(input.eventId);
    else await this.scheduleOutboxRetry(input.eventId, input.nextAttemptAt, input.errorCode);
  }
  async markOutboxDelivered(id: string) {
    const row = [...this.outbox.entries()].find(([, event]) => event.id === id);
    if (row) this.outbox.delete(row[0]);
  }
  async scheduleOutboxRetry(_id?: string, _next?: Date, _errorCode?: string) {
    const row = [...this.outbox.values()].find((event) => event.id === _id);
    if (row && _next) (row as any).nextAttemptAt = _next;
    void _errorCode;
  }
  async markOutboxDeadLetter(id: string, _errorCode?: string) {
    void _errorCode;
    const row = [...this.outbox.entries()].find(([, event]) => event.id === id);
    if (row) this.outbox.delete(row[0]);
  }
  async releaseExpiredLeases() {
    return 0;
  }
  async replayOutboxEvent() {}
  async createSandboxEvent(
    connectionId: string,
    scenario: string,
    externalBillId: string,
    amount?: number,
  ) {
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    const connection = this.connections.get(connectionId)!;
    const bill = this.bills.get(`${connectionId}:${externalBillId}`);
    if (!connection || !bill) throw new RepositoryError('resource_not_found');
    if (scenario === 'amount_mismatch') throw new RepositoryError('amount_mismatch');
    if (scenario === 'bill_already_paid') throw new RepositoryError('bill_already_paid');
    const grandTotal = bill.grand_total;
    const type =
      scenario === 'payment.refunded'
        ? 'payment.refunded'
        : scenario === 'payment.failed'
          ? 'payment.failed'
          : 'payment.completed';
    const currentPaid =
      type === 'payment.refunded' && bill.amount_paid === 0 ? grandTotal : bill.amount_paid;
    const paid =
      amount ??
      (scenario === 'partial_payment.completed'
        ? Math.max(1, Math.floor(bill.amount_due / 2))
        : type === 'payment.refunded'
          ? Math.max(1, currentPaid - bill.amount_refunded)
          : bill.amount_due);
    if (
      (type === 'payment.completed' && paid > bill.amount_due) ||
      (type === 'payment.refunded' && paid > currentPaid - bill.amount_refunded)
    )
      throw new RepositoryError('amount_mismatch');
    if (type === 'payment.completed' && bill.amount_due === 0)
      throw new RepositoryError('bill_already_paid');
    const nextPaid =
      type === 'payment.completed' ? Math.min(grandTotal, currentPaid + paid) : currentPaid;
    const nextRefunded =
      type === 'payment.refunded'
        ? Math.min(nextPaid, bill.amount_refunded + paid)
        : bill.amount_refunded;
    const nextDue = Math.max(0, grandTotal - nextPaid + nextRefunded);
    const privateEventId = `sandbox_${randomUUID().replaceAll('-', '')}`;
    const publicPayload = eventSchema.parse({
      id: eventId,
      type,
      schema_version: '2026-07-01',
      created_at: new Date(
        Date.now() - (scenario === 'out_of_order_event' ? 60_000 : 0),
      ).toISOString(),
      data: {
        location_id: connection.locationId,
        external_bill_id: externalBillId,
        external_table_id: bill?.external_table_id ?? 'EXT-01',
        payment: {
          restec_payment_id: `pay_${sha256(eventId).slice(0, 20)}`,
          amount: paid,
          currency: bill.currency,
          method: 'card',
          status:
            type === 'payment.failed'
              ? 'failed'
              : type === 'payment.refunded'
                ? 'refunded'
                : 'completed',
        },
        bill: {
          grand_total: grandTotal,
          amount_paid: nextPaid,
          amount_refunded: nextRefunded,
          amount_due: nextDue,
          payment_status:
            type === 'payment.failed'
              ? 'failed'
              : type === 'payment.refunded'
                ? nextRefunded === nextPaid
                  ? 'refunded'
                  : 'partially_refunded'
                : nextDue > 0
                  ? 'partially_paid'
                  : 'paid',
          version: bill.version,
        },
      },
    });
    const accepted = await this.acceptPrivateEvent({
      privateEventId,
      eventType: type,
      schemaVersion: '2026-07-01',
      connectionId,
      requestHash: sha256(JSON.stringify(publicPayload)),
      payload: { id: privateEventId, type, scenario },
      publicEventId: eventId,
      publicPayload,
    });
    const sandboxOutbox = this.outbox.get(eventId);
    if (sandboxOutbox && scenario === 'delayed_event')
      (sandboxOutbox as any).nextAttemptAt = new Date(Date.now() + 30_000);
    if (sandboxOutbox && ['webhook_timeout', 'webhook_429', 'webhook_500'].includes(scenario)) {
      sandboxOutbox.connectorType = 'mock_pos';
      sandboxOutbox.connectorVersion = '1.0.0';
      sandboxOutbox.configuration = {
        ...sandboxOutbox.configuration,
        failure_mode: scenario.replace('webhook_', ''),
      };
    }
    if (scenario === 'duplicate_event')
      await this.acceptPrivateEvent({
        privateEventId,
        eventType: type,
        schemaVersion: '2026-07-01',
        connectionId,
        requestHash: sha256(JSON.stringify(publicPayload)),
        payload: { id: privateEventId, type, scenario },
        publicEventId: eventId,
        publicPayload,
      });
    this.audits.push({
      actorType: 'sandbox',
      connectionId,
      action: 'sandbox.scenario.created',
      result: 'accepted',
      targetId: eventId,
      metadata: { scenario },
    });
    return { eventId: accepted.eventId };
  }
  async createAuditLog(input: AuditInput) {
    this.audits.push(input);
  }
  async reservePaymentSession(input: CreatePaymentSessionInput) {
    const existing = this.paymentSessions.get(input.publicPaymentSessionId);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint)
        throw new RepositoryError('idempotency_conflict');
      return { record: existing, created: false };
    }
    const now = new Date().toISOString();
    const record: PaymentSessionRecord = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.paymentSessions.set(record.publicPaymentSessionId, record);
    return { record, created: true };
  }
  async attachPaymentSession(input: AttachPaymentSessionInput) {
    const existing = this.paymentSessions.get(input.publicPaymentSessionId);
    if (!existing) throw new RepositoryError('resource_not_found');
    const record: PaymentSessionRecord = {
      ...existing,
      privatePaymentSessionReference: input.privatePaymentSessionReference,
      encryptedProviderCheckoutUrl: input.encryptedProviderCheckoutUrl,
      providerCheckoutHost: input.providerCheckoutHost,
      status: input.status,
      expiresAt: input.expiresAt,
      lastPrivateStatus: input.status,
      updatedAt: new Date().toISOString(),
    };
    this.paymentSessions.set(record.publicPaymentSessionId, record);
    return record;
  }
  async claimPaymentSessionCheckoutRefresh(
    publicPaymentSessionId: string,
    lockToken: string,
    leaseSeconds: number,
  ) {
    const record = this.paymentSessions.get(publicPaymentSessionId);
    const existingLease = this.paymentSessionCheckoutRefreshLeases.get(publicPaymentSessionId);
    if (
      !record ||
      record.status !== 'requires_customer_action' ||
      !record.privatePaymentSessionReference ||
      new Date(record.expiresAt).getTime() <= Date.now() ||
      (existingLease && existingLease.expiresAt > Date.now())
    )
      return null;
    this.paymentSessionCheckoutRefreshLeases.set(publicPaymentSessionId, {
      lockToken,
      expiresAt: Date.now() + leaseSeconds * 1000,
    });
    return record;
  }
  async completePaymentSessionCheckoutRefresh(input: CompletePaymentSessionCheckoutRefreshInput) {
    const record = this.paymentSessions.get(input.publicPaymentSessionId);
    const lease = this.paymentSessionCheckoutRefreshLeases.get(input.publicPaymentSessionId);
    if (
      !record ||
      record.status !== 'requires_customer_action' ||
      record.privatePaymentSessionReference !== input.privatePaymentSessionReference ||
      lease?.lockToken !== input.lockToken
    )
      return null;
    const refreshed: PaymentSessionRecord = {
      ...record,
      encryptedProviderCheckoutUrl: input.encryptedProviderCheckoutUrl,
      providerCheckoutHost: input.providerCheckoutHost,
      updatedAt: new Date().toISOString(),
    };
    this.paymentSessions.set(input.publicPaymentSessionId, refreshed);
    this.paymentSessionCheckoutRefreshLeases.delete(input.publicPaymentSessionId);
    return refreshed;
  }
  async releasePaymentSessionCheckoutRefresh(publicPaymentSessionId: string, lockToken: string) {
    const lease = this.paymentSessionCheckoutRefreshLeases.get(publicPaymentSessionId);
    if (lease?.lockToken === lockToken)
      this.paymentSessionCheckoutRefreshLeases.delete(publicPaymentSessionId);
  }
  async getPaymentSession(publicPaymentSessionId: string) {
    return this.paymentSessions.get(publicPaymentSessionId) ?? null;
  }
  async transitionPaymentSession(
    publicPaymentSessionId: string,
    requestedStatus: PaymentSessionStatus,
    occurredAt: string,
  ) {
    const existing = this.paymentSessions.get(publicPaymentSessionId);
    if (!existing) throw new RepositoryError('resource_not_found');
    const transition = transitionPaymentSessionStatus(existing.status, requestedStatus);
    if (transition.kind === 'noop') return { record: existing, changed: false };
    const record: PaymentSessionRecord = {
      ...existing,
      status: requestedStatus,
      updatedAt: occurredAt,
      ...(requestedStatus === 'paid' ? { paidAt: occurredAt } : {}),
      ...(requestedStatus === 'failed' ? { failedAt: occurredAt } : {}),
      ...(requestedStatus === 'cancelled' ? { cancelledAt: occurredAt } : {}),
    };
    this.paymentSessions.set(publicPaymentSessionId, record);
    return { record, changed: true };
  }
  async acceptPaymentSessionEvent(input: PaymentSessionEventInput) {
    const session = this.paymentSessions.get(input.publicPaymentSessionId);
    if (!session) {
      const old = this.events.get(input.privateEventId);
      if (old) {
        if (this.eventHashes.get(input.privateEventId) !== input.requestHash)
          throw new RepositoryError('replay_detected');
        return { eventId: old, duplicate: true };
      }
      this.events.set(input.privateEventId, input.publicEventId);
      this.eventHashes.set(input.privateEventId, input.requestHash);
      this.audits.push({
        actorType: 'service',
        connectionId: input.connectionId,
        action: 'payment_session.event_unmatched',
        result: 'review_required',
        targetType: 'payment_session',
        targetId: input.publicPaymentSessionId,
        metadata: { event_type: input.eventType },
      });
      return { eventId: input.publicEventId, duplicate: false };
    }
    transitionPaymentSessionStatus(session.status, input.requestedStatus);
    const accepted = await this.acceptPrivateEvent(input);
    await this.transitionPaymentSession(
      input.publicPaymentSessionId,
      input.requestedStatus,
      input.publicPayload.created_at,
    );
    return accepted;
  }
  async getMockPosWebhookContext(eventId: string) {
    const event = this.outbox.get(eventId);
    if (!event) return null;
    const secret = event.configuration.webhook_secret;
    return typeof secret === 'string'
      ? { connectionId: event.connectionId, signingSecret: secret }
      : null;
  }
  async acceptMockPosReceipt(input: MockPosReceipt) {
    const existing = this.mockPosReceipts.get(input.eventId);
    if (existing) {
      if (existing.requestHash !== input.requestHash) throw new RepositoryError('replay_detected');
      return { duplicate: true };
    }
    this.mockPosReceipts.set(input.eventId, input);
    return { duplicate: false };
  }
  async getLastMockPosReceipt() {
    return (
      [...this.mockPosReceipts.values()].sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      )[0] ?? null
    );
  }
  async getPaymentSessionCertificationEvidence(publicPaymentSessionId: string) {
    const session = this.paymentSessions.get(publicPaymentSessionId);
    if (!session) return null;
    const outbox = [...this.outbox.values()].find(
      (event) => event.payload.data.payment_session_id === publicPaymentSessionId,
    );
    const eventId =
      outbox?.publicEventId ??
      [...this.mockPosReceipts.values()].find((receipt) =>
        [...this.events.values()].includes(receipt.eventId),
      )?.eventId ??
      null;
    return {
      paymentSessionStatus: session.status,
      billPaymentStatus:
        this.bills.get(`${session.connectionId}:${session.externalBillId}`)?.payment_status ?? null,
      privateEventAccepted: [...this.events.values()].some(
        (id) => id === outbox?.publicEventId || id === eventId,
      ),
      publicEventId: outbox?.publicEventId ?? eventId,
      posOutboxStatus: outbox ? 'pending' : eventId ? 'delivered' : null,
      deliveryAttempts: outbox
        ? this.attempts.filter((attempt) => attempt.eventId === outbox.id).length
        : 0,
      mockPosAccepted: eventId ? this.mockPosReceipts.has(eventId) : false,
      deadLettered: false,
    };
  }
  async listPaymentSessionsForReconciliation(limit: number) {
    return [...this.paymentSessions.values()]
      .filter((session) =>
        ['creating', 'requires_customer_action', 'processing'].includes(session.status),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }
}
