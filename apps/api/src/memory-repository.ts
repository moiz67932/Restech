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
  ReserveBillCapacityInput,
  FinancialReservationResult,
  ReserveBillMutationInput,
  RestecRepository,
  CustomerTableView,
  TableLifecycleSyncInput,
  FinancialCorrection,
  ReconciliationCase,
  ReconciliationAction,
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
  tableQrTokens = new Map<
    string,
    {
      connectionId: string;
      externalTableId: string;
      environment: 'sandbox' | 'production';
      active: boolean;
    }
  >();
  tableSessions = new Map<
    string,
    {
      id: string;
      connectionId: string;
      locationId: string;
      externalTableId: string;
      externalBillId: string;
      environment: 'sandbox' | 'production';
      active: boolean;
      terminal: boolean;
    }
  >();
  customerVisits = new Map<
    string,
    { tableSessionId: string; environment: 'sandbox' | 'production' }
  >();
  events = new Map<string, string>();
  eventHashes = new Map<string, string>();
  outbox = new Map<string, ClaimedPosOutboxEvent>();
  archivedOutbox = new Map<
    string,
    { event: ClaimedPosOutboxEvent; status: 'delivered' | 'dead_letter' }
  >();
  attempts: DeliveryAttempt[] = [];
  audits: AuditInput[] = [];
  reconciliationCases = new Map<string, ReconciliationCase>();
  reconciliationActions = new Map<string, ReconciliationAction>();
  paymentSessions = new Map<string, PaymentSessionRecord>();
  financialReservations = new Map<
    string,
    ReserveBillCapacityInput & {
      state:
        | 'reserved'
        | 'ambiguous_pending_reconciliation'
        | 'completed'
        | 'failed_released'
        | 'expired_released'
        | 'cancelled_released';
      completedState?: CanonicalBillState;
    }
  >();
  pendingBillMutations = new Map<
    string,
    ReserveBillMutationInput & { state: 'reserved' | 'ambiguous_pending_reconciliation' }
  >();
  paymentSessionCheckoutRefreshLeases = new Map<string, { lockToken: string; expiresAt: number }>();
  mockPosReceipts = new Map<string, MockPosReceipt>();
  financialCorrections = new Map<string, FinancialCorrection>();
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
  async provisionTableQr(
    connectionId: string,
    externalTableId: string,
    tokenHash: string,
    environment: 'sandbox' | 'production',
  ) {
    const table = await this.getTableMapping(connectionId, externalTableId);
    if (!table) throw new RepositoryError('resource_not_found');
    for (const [hash, value] of this.tableQrTokens) {
      if (value.connectionId === connectionId && value.externalTableId === externalTableId)
        this.tableQrTokens.delete(hash);
    }
    this.tableQrTokens.set(tokenHash, { connectionId, externalTableId, environment, active: true });
  }
  private customerView(session: {
    connectionId: string;
    externalTableId: string;
    externalBillId: string;
    active: boolean;
    terminal: boolean;
  }): CustomerTableView {
    const table = [...this.tables.values()].find(
      (v) =>
        v.connection_id === session.connectionId && v.external_table_id === session.externalTableId,
    );
    const connection = this.connections.get(session.connectionId);
    if (!table?.active || connection?.connectorEnabled === false)
      return { status: 'table_unavailable' };
    const bill = this.bills.get(`${session.connectionId}:${session.externalBillId}`);
    if (!bill) return { status: 'session_ended', table_name: table.name };
    if (!session.active || session.terminal)
      return { status: 'session_ended', table_name: table.name };
    return {
      status: 'active',
      table_name: table.name,
      bill: {
        order_status: bill.order_status,
        payment_status: bill.payment_status,
        currency: bill.currency,
        grand_total: bill.grand_total,
        amount_paid: bill.amount_paid,
        amount_due: bill.amount_due,
      },
    };
  }
  async resolveTableQr(
    tokenHash: string,
    environment: 'sandbox' | 'production',
  ): Promise<
    CustomerTableView & { tableSessionId?: string; connectionId?: string; locationId?: string }
  > {
    const token = this.tableQrTokens.get(tokenHash);
    if (!token || !token.active || token.environment !== environment)
      return { status: 'invalid_link' } as const;
    const table = await this.getTableMapping(token.connectionId, token.externalTableId);
    if (!table?.active || this.connections.get(token.connectionId)?.connectorEnabled === false)
      return { status: 'table_unavailable' } as const;
    const session = [...this.tableSessions.values()].find(
      (v) =>
        v.connectionId === token.connectionId &&
        v.externalTableId === token.externalTableId &&
        v.active,
    );
    if (!session)
      return { status: 'no_active_bill', table_name: table.name, connectionId: token.connectionId };
    return {
      ...this.customerView(session),
      tableSessionId: session.id,
      connectionId: token.connectionId,
      locationId: session.locationId,
    };
  }
  async createCustomerVisit(
    tableSessionId: string,
    tokenHash: string,
    environment: 'sandbox' | 'production',
  ) {
    const session = this.tableSessions.get(tableSessionId);
    if (!session || !session.active || session.environment !== environment)
      throw new RepositoryError('resource_not_found');
    this.customerVisits.set(tokenHash, { tableSessionId, environment });
  }
  async resolveCustomerVisit(
    tokenHash: string,
    environment: 'sandbox' | 'production',
  ): Promise<CustomerTableView> {
    const visit = this.customerVisits.get(tokenHash);
    if (!visit || visit.environment !== environment) return { status: 'invalid_link' } as const;
    const session = this.tableSessions.get(visit.tableSessionId);
    return session ? this.customerView(session) : ({ status: 'session_ended' } as const);
  }
  async syncTableLifecycle(input: TableLifecycleSyncInput) {
    const all = [...this.tableSessions.values()];
    const prior = all.find(
      (v) => v.connectionId === input.connectionId && v.externalBillId === input.externalBillId,
    );
    if (prior?.terminal && !input.terminal)
      throw new RepositoryError('bill_table_generation_conflict');
    if (input.terminal) {
      if (
        [...this.financialReservations.values()].some(
          (value) =>
            value.connectionId === input.connectionId &&
            value.externalBillId === input.externalBillId &&
            ['reserved', 'ambiguous_pending_reconciliation'].includes(value.state),
        )
      )
        throw new RepositoryError('payment_in_progress');
      if (prior) this.tableSessions.set(prior.id, { ...prior, active: false, terminal: true });
      return;
    }
    const occupied = all.find(
      (v) =>
        v.connectionId === input.connectionId &&
        v.externalTableId === input.externalTableId &&
        v.active &&
        v.externalBillId !== input.externalBillId,
    );
    if (occupied) throw new RepositoryError('table_active_bill_conflict');
    if (prior && prior.externalTableId !== input.externalTableId)
      this.tableSessions.set(prior.id, { ...prior, active: false });
    const current = [...this.tableSessions.values()].find(
      (v) =>
        v.connectionId === input.connectionId &&
        v.externalTableId === input.externalTableId &&
        v.externalBillId === input.externalBillId &&
        v.active,
    );
    if (!current) {
      const id = randomUUID();
      this.tableSessions.set(id, {
        id,
        connectionId: input.connectionId,
        locationId: input.locationId,
        externalTableId: input.externalTableId,
        externalBillId: input.externalBillId,
        environment: input.environment,
        active: true,
        terminal: false,
      });
    }
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
    const pending = this.pendingBillMutations.get(key);
    if (
      existing &&
      (!pending ||
        pending.version !== input.version ||
        pending.requestHash !== requestHash ||
        input.totals.grand_total <
          this.projection(connectionId, externalBillId).billTotalMinor -
            this.projection(connectionId, externalBillId).availableMinor)
    )
      throw new RepositoryError('bill_financial_floor_conflict');
    this.bills.set(key, state);
    this.billRequests.set(key, { version: input.version, requestHash });
    this.pendingBillMutations.delete(key);
    return state;
  }
  async getBill(connectionId: string, externalBillId: string) {
    return this.bills.get(`${connectionId}:${externalBillId}`) ?? null;
  }
  private projection(connectionId: string, externalBillId: string) {
    const bill = this.bills.get(`${connectionId}:${externalBillId}`);
    if (!bill) throw new RepositoryError('resource_not_found');
    const reservations = [...this.financialReservations.values()].filter(
      (value) => value.connectionId === connectionId && value.externalBillId === externalBillId,
    );
    const activeReservedMinor = reservations
      .filter((value) => value.state === 'reserved')
      .reduce((sum, value) => sum + value.amountMinor, 0);
    const ambiguousPendingMinor = reservations
      .filter((value) => value.state === 'ambiguous_pending_reconciliation')
      .reduce((sum, value) => sum + value.amountMinor, 0);
    const completedReservationMinor = reservations
      .filter((value) => value.state === 'completed')
      .reduce((sum, value) => sum + value.amountMinor, 0);
    const completedPaymentMinor = Math.max(0, bill.amount_paid, completedReservationMinor);
    const refundedMinor = Math.max(0, bill.amount_refunded);
    const pending = this.pendingBillMutations.get(`${connectionId}:${externalBillId}`);
    const billTotalMinor = pending
      ? Math.min(bill.grand_total, pending.newTotalMinor)
      : bill.grand_total;
    return {
      billTotalMinor,
      completedPaymentMinor,
      activeReservedMinor,
      ambiguousPendingMinor,
      refundedMinor,
      availableMinor: Math.max(
        0,
        billTotalMinor -
          completedPaymentMinor +
          refundedMinor -
          activeReservedMinor -
          ambiguousPendingMinor,
      ),
    };
  }
  async reserveBillMutation(input: ReserveBillMutationInput) {
    const key = `${input.connectionId}:${input.externalBillId}`;
    const bill = this.bills.get(key);
    if (!bill) {
      if (input.version !== 1) throw new RepositoryError('bill_version_conflict');
      return { kind: 'proceed' } as const;
    }
    if (input.currency !== bill.currency) throw new RepositoryError('amount_mismatch');
    const current = this.billRequests.get(key)!;
    if (
      input.version < current.version ||
      (input.version === current.version && input.requestHash !== current.requestHash)
    )
      throw new RepositoryError('bill_version_conflict');
    if (input.version === current.version) return { kind: 'replay', state: bill } as const;
    const pending = this.pendingBillMutations.get(key);
    if (pending) {
      if (pending.version !== input.version || pending.requestHash !== input.requestHash)
        throw new RepositoryError('bill_version_conflict');
      return { kind: 'proceed' } as const;
    }
    const projection = this.projection(input.connectionId, input.externalBillId);
    const protectedMinor =
      projection.completedPaymentMinor -
      projection.refundedMinor +
      projection.activeReservedMinor +
      projection.ambiguousPendingMinor;
    if (input.newTotalMinor < protectedMinor)
      throw new RepositoryError('bill_financial_floor_conflict');
    this.pendingBillMutations.set(key, { ...input, state: 'reserved' });
    return { kind: 'proceed' } as const;
  }
  async markBillMutationAmbiguous(
    connectionId: string,
    externalBillId: string,
    version: number,
    requestHash: string,
  ) {
    const key = `${connectionId}:${externalBillId}`;
    const pending = this.pendingBillMutations.get(key);
    if (pending && pending.version === version && pending.requestHash === requestHash)
      this.pendingBillMutations.set(key, {
        ...pending,
        state: 'ambiguous_pending_reconciliation',
      });
  }
  async reserveBillCapacity(input: ReserveBillCapacityInput): Promise<FinancialReservationResult> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
      throw new RepositoryError('amount_mismatch');
    const bill = this.bills.get(`${input.connectionId}:${input.externalBillId}`);
    if (!bill) throw new RepositoryError('resource_not_found');
    if (bill.currency !== input.currency) throw new RepositoryError('amount_mismatch');
    const key = `${input.connectionId}:${input.reservationIdentity}`;
    const existing = this.financialReservations.get(key);
    if (existing) {
      if (
        existing.externalBillId !== input.externalBillId ||
        existing.requestHash !== input.requestHash ||
        existing.amountMinor !== input.amountMinor ||
        existing.currency !== input.currency ||
        existing.channel !== input.channel
      )
        throw new RepositoryError('idempotency_conflict');
      return {
        state: existing.state,
        created: false,
        projection: this.projection(input.connectionId, input.externalBillId),
        ...(existing.completedState ? { completedState: existing.completedState } : {}),
      };
    }
    if (
      input.channel === 'digital_session' &&
      [...this.financialReservations.values()].some(
        (value) =>
          value.connectionId === input.connectionId &&
          value.externalBillId === input.externalBillId &&
          value.channel === 'digital_session' &&
          ['reserved', 'ambiguous_pending_reconciliation'].includes(value.state),
      )
    )
      throw new RepositoryError('payment_in_progress');
    const projection = this.projection(input.connectionId, input.externalBillId);
    if (input.amountMinor > projection.availableMinor)
      throw new RepositoryError('payment_capacity_conflict');
    this.financialReservations.set(key, { ...input, state: 'reserved' });
    return {
      state: 'reserved',
      created: true,
      projection: this.projection(input.connectionId, input.externalBillId),
    };
  }
  async markFinancialReservationAmbiguous(
    connectionId: string,
    reservationIdentity: string,
    requestHash: string,
  ) {
    const key = `${connectionId}:${reservationIdentity}`;
    const existing = this.financialReservations.get(key);
    if (!existing || existing.requestHash !== requestHash)
      throw new RepositoryError('idempotency_conflict');
    if (existing.state === 'reserved')
      this.financialReservations.set(key, {
        ...existing,
        state: 'ambiguous_pending_reconciliation',
      });
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
    const reservationKey = `${connectionId}:external_payment:${input.external_payment_id}`;
    const reservation = this.financialReservations.get(reservationKey);
    if (!reservation || reservation.requestHash !== requestHash)
      throw new RepositoryError('payment_capacity_conflict');
    this.financialReservations.set(reservationKey, {
      ...reservation,
      state: 'completed',
      completedState: state,
    });
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
    const correction = input.publicPayload.data.correction;
    if (correction) {
      const recorded = await this.recordProviderCorrection({
        correctionId: correction.correction_id,
        logicalIdentity: `${input.connectionId}:${input.publicPayload.data.external_bill_id}:${correction.original_payment_id}:${correction.type}:${correction.amount}:${correction.currency}`,
        type: correction.type,
        status: correction.status,
        connectionId: input.connectionId,
        externalBillId: input.publicPayload.data.external_bill_id,
        originalPaymentId: correction.original_payment_id,
        amountMinor: correction.amount,
        currency: correction.currency,
        authority: 'provider',
        source: 'provider_event',
        occurredAt: input.publicPayload.created_at,
      });
      if (!recorded.duplicate) {
        input.publicPayload = {
          ...input.publicPayload,
          data: { ...input.publicPayload.data, bill: recorded.bill as any },
        };
      }
    }
    const connection = [...this.connections.values()].find(
      (v) => v.connectionId === input.connectionId || v.privateConnectionId === input.connectionId,
    );
    this.outbox.set(input.publicEventId, {
      id: randomUUID(),
      publicEventId: input.publicEventId,
      connectionId: connection?.connectionId ?? input.connectionId,
      partnerId: connection?.partnerId ?? 'ptr_system',
      environment: connection?.environment ?? 'sandbox',
      eventType: input.eventType,
      schemaVersion: input.schemaVersion,
      payload: input.publicPayload,
      attemptCount: 0,
      configuration: connection?.configuration ?? {},
      connectorType: connection?.connectorType ?? 'mock_pos',
      connectorVersion: connection?.connectorVersion ?? '1.0.0',
      connectorEnabled: true,
      signingSecretVersion: 1,
      ...(typeof connection?.configuration.webhook_secret === 'string'
        ? { webhookSigningSecret: connection.configuration.webhook_secret }
        : {}),
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
  async recordProviderCorrection(input: FinancialCorrection) {
    const existing = this.financialCorrections.get(input.logicalIdentity);
    const billKey = `${input.connectionId}:${input.externalBillId}`;
    const bill = this.bills.get(billKey);
    if (!bill) throw new RepositoryError('resource_not_found');
    if (existing) return { correction: existing, duplicate: true, bill };
    if (
      bill.currency !== input.currency ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0
    )
      throw new RepositoryError('amount_mismatch');
    const prior = [...this.financialCorrections.values()]
      .filter(
        (value) =>
          value.connectionId === input.connectionId &&
          value.externalBillId === input.externalBillId &&
          value.type === 'refund' &&
          value.status === 'completed',
      )
      .reduce((sum, value) => sum + value.amountMinor, 0);
    const completed = input.status === 'completed' && prior + input.amountMinor <= bill.amount_paid;
    const correction: FinancialCorrection = {
      ...input,
      status: completed ? 'completed' : 'review_required',
    };
    this.financialCorrections.set(input.logicalIdentity, correction);
    const nextRefunded =
      prior +
      (correction.status === 'completed' && correction.type === 'refund'
        ? correction.amountMinor
        : 0);
    const nextBill: CanonicalBillState =
      correction.status === 'completed' && correction.type === 'refund'
        ? {
            ...bill,
            amount_refunded: nextRefunded,
            amount_due: Math.max(0, bill.grand_total - bill.amount_paid),
            payment_status: nextRefunded >= bill.amount_paid ? 'refunded' : 'partially_refunded',
            updated_at: input.occurredAt,
          }
        : bill;
    if (nextBill !== bill) this.bills.set(billKey, nextBill);
    await this.createAuditLog({
      actorType: 'provider',
      connectionId: input.connectionId,
      action:
        correction.status === 'completed'
          ? 'financial_correction.completed'
          : 'financial_correction.review_required',
      result: correction.status,
      targetType: 'financial_correction',
      targetId: input.correctionId,
      metadata: {
        type: input.type,
        amount_minor: input.amountMinor,
        currency: input.currency,
        original_payment_id: input.originalPaymentId,
        authority: input.authority,
      },
    });
    return { correction, duplicate: false, bill: nextBill };
  }
  async listFinancialCorrections(connectionId: string, externalBillId: string) {
    return [...this.financialCorrections.values()].filter(
      (value) => value.connectionId === connectionId && value.externalBillId === externalBillId,
    );
  }
  async getConnectionForPrivateEvent(id: string) {
    return [...this.connections.values()].find((v) => v.privateConnectionId === id) ?? null;
  }
  async getLocationForPrivateEvent(id: string) {
    const connection = [...this.connections.values()].find((v) => v.privateLocationId === id);
    return connection
      ? { locationId: connection.locationId, environment: connection.environment }
      : null;
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
    if (row) {
      this.outbox.delete(row[0]);
      this.archivedOutbox.set(row[0], { event: row[1], status: 'delivered' });
    }
  }
  async scheduleOutboxRetry(_id?: string, _next?: Date, _errorCode?: string) {
    const row = [...this.outbox.values()].find((event) => event.id === _id);
    if (row && _next) (row as any).nextAttemptAt = _next;
    void _errorCode;
  }
  async markOutboxDeadLetter(id: string, _errorCode?: string) {
    void _errorCode;
    const row = [...this.outbox.entries()].find(([, event]) => event.id === id);
    if (row) {
      this.outbox.delete(row[0]);
      this.archivedOutbox.set(row[0], { event: row[1], status: 'dead_letter' });
    }
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
    const nextDue = Math.max(0, grandTotal - nextPaid);
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
    const priorEvent = this.events.get(input.privateEventId);
    if (priorEvent) {
      if (this.eventHashes.get(input.privateEventId) !== input.requestHash)
        throw new RepositoryError('replay_detected');
      return { eventId: priorEvent, duplicate: true };
    }
    const session = this.paymentSessions.get(input.publicPaymentSessionId);
    if (!session) {
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
    const payload = input.payload as {
      data: {
        connection_id: string;
        location_id: string;
        external_bill_id: string;
        payment: { amount: number; currency: string; method: string };
        payment_session: { private_payment_session_id: string; status: string };
      };
    };
    const connection = [...this.connections.values()].find(
      (value) => value.privateConnectionId === payload.data.connection_id,
    );
    if (!connection) throw new RepositoryError('paely_connection_mapping_not_found');
    const locationConnection = [...this.connections.values()].find(
      (value) => value.privateLocationId === payload.data.location_id,
    );
    const location = locationConnection
      ? { locationId: locationConnection.locationId, environment: locationConnection.environment }
      : null;
    if (!location) throw new RepositoryError('paely_location_mapping_not_found');
    if (
      connection.connectionId !== session.connectionId ||
      session.privateConnectionReference !== payload.data.connection_id
    )
      throw new RepositoryError('connection_reference_mismatch');
    if (
      location.locationId !== session.locationId ||
      session.privateLocationReference !== payload.data.location_id
    )
      throw new RepositoryError('location_reference_mismatch');
    if (
      session.privatePaymentSessionReference !==
      payload.data.payment_session.private_payment_session_id
    )
      throw new RepositoryError('payment_session_reference_mismatch');
    if (session.externalBillId !== payload.data.external_bill_id)
      throw new RepositoryError('external_bill_reference_mismatch');
    if (
      session.amountMinor !== payload.data.payment.amount ||
      session.currency !== payload.data.payment.currency
    )
      throw new RepositoryError('amount_mismatch');
    if (session.method !== payload.data.payment.method)
      throw new RepositoryError('payment_method_mismatch');
    if (payload.data.payment_session.status !== input.requestedStatus)
      throw new RepositoryError('payment_status_mismatch');
    const bill = this.bills.get(`${session.connectionId}:${session.externalBillId}`);
    if (!bill || bill.external_table_id !== input.publicPayload.data.external_table_id)
      throw new RepositoryError('resource_not_found');
    const reservationKey = `${session.connectionId}:payment_session:${session.publicPaymentSessionId}`;
    const reservation = this.financialReservations.get(reservationKey);
    if (session.status === input.requestedStatus) {
      const matching = [
        ...this.outbox.values(),
        ...[...this.archivedOutbox.values()].map(({ event }) => event),
      ].find(
        (event) =>
          event.eventType === input.eventType &&
          event.payload.data.payment_session_id === session.publicPaymentSessionId,
      );
      if (matching) {
        this.events.set(input.privateEventId, matching.publicEventId);
        this.eventHashes.set(input.privateEventId, input.requestHash);
        return { eventId: matching.publicEventId, duplicate: true };
      }
    }
    if (reservation?.state === 'completed' && input.requestedStatus === 'paid') {
      const existingEvent = [...this.outbox.values()].find(
        (event) =>
          event.eventType === 'payment.completed' &&
          event.payload.data.payment_session_id === session.publicPaymentSessionId,
      );
      this.events.set(input.privateEventId, existingEvent?.publicEventId ?? input.publicEventId);
      this.eventHashes.set(input.privateEventId, input.requestHash);
      return {
        eventId: existingEvent?.publicEventId ?? input.publicEventId,
        duplicate: true,
      };
    }
    transitionPaymentSessionStatus(session.status, input.requestedStatus);
    if (reservation) {
      if (input.requestedStatus === 'paid')
        if (
          ['failed_released', 'expired_released', 'cancelled_released'].includes(
            reservation.state,
          ) &&
          reservation.amountMinor >
            this.projection(session.connectionId, session.externalBillId).availableMinor
        )
          throw new RepositoryError('payment_capacity_conflict');
    }
    if (input.publicPayload.data.correction) {
      const correction = input.publicPayload.data.correction;
      const recorded = await this.recordProviderCorrection({
        correctionId: correction.correction_id,
        logicalIdentity: `${input.connectionId}:${input.publicPayload.data.external_bill_id}:${correction.original_payment_id}:${correction.type}:${correction.amount}:${correction.currency}`,
        type: correction.type,
        status: correction.status,
        connectionId: input.connectionId,
        externalBillId: input.publicPayload.data.external_bill_id,
        originalPaymentId: correction.original_payment_id,
        amountMinor: correction.amount,
        currency: correction.currency,
        authority: 'provider',
        source: 'provider_event',
        occurredAt: input.publicPayload.created_at,
      });
      input.publicPayload = {
        ...input.publicPayload,
        data: { ...input.publicPayload.data, bill: recorded.bill as any },
      };
    }
    const transition = this.transitionPaymentSession(
      input.publicPaymentSessionId,
      input.requestedStatus,
      input.publicPayload.created_at,
    );
    if (reservation) {
      const releaseState =
        input.requestedStatus === 'failed'
          ? 'failed_released'
          : input.requestedStatus === 'expired'
            ? 'expired_released'
            : input.requestedStatus === 'cancelled'
              ? 'cancelled_released'
              : undefined;
      if (input.requestedStatus === 'paid')
        this.financialReservations.set(reservationKey, {
          ...reservation,
          state: 'completed',
          completedState: input.publicPayload.data.bill as CanonicalBillState,
        });
      else if (releaseState)
        this.financialReservations.set(reservationKey, { ...reservation, state: releaseState });
    }
    const accepted = this.acceptPrivateEvent(input);
    await transition;
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
    const matchingOutbox = [
      ...[...this.outbox.values()].map((event) => ({ event, status: 'pending' as const })),
      ...this.archivedOutbox.values(),
    ].filter(
      ({ event }) =>
        event.eventType === 'payment.completed' &&
        event.payload.data.payment_session_id === publicPaymentSessionId,
    );
    const outbox = matchingOutbox[0];
    const eventId = outbox?.event.publicEventId ?? null;
    const matchingEventIds = new Set(matchingOutbox.map(({ event }) => event.publicEventId));
    const inboxCount = [...this.events.values()].filter((id) => matchingEventIds.has(id)).length;
    const receiptCount = [...this.mockPosReceipts.values()].filter(
      (receipt) =>
        matchingEventIds.has(receipt.eventId) && receipt.eventType === 'payment.completed',
    ).length;
    return {
      privatePaymentSessionReference: session.privatePaymentSessionReference,
      paymentSessionStatus: session.status,
      paidAt: session.paidAt ?? null,
      billPaymentStatus:
        this.bills.get(`${session.connectionId}:${session.externalBillId}`)?.payment_status ?? null,
      privateEventAccepted: inboxCount > 0,
      paymentCompletedInboxCount: inboxCount,
      publicEventId: eventId,
      posOutboxStatus: outbox?.status ?? null,
      paymentCompletedPosCount: matchingOutbox.length,
      deliveryAttempts: outbox
        ? this.attempts.filter((attempt) => attempt.eventId === outbox.event.id).length
        : 0,
      mockPosAccepted: receiptCount > 0,
      matchingMockPosReceiptCount: receiptCount,
      deadLettered: matchingOutbox.some(({ status }) => status === 'dead_letter'),
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
  async upsertReconciliationCase(
    input: Omit<
      ReconciliationCase,
      'caseId' | 'firstDetectedAt' | 'lastCheckedAt' | 'occurrenceCount'
    >,
  ) {
    const now = new Date().toISOString();
    const existing = [...this.reconciliationCases.values()].find(
      (item) =>
        item.logicalIdentity === input.logicalIdentity &&
        !['resolved', 'dismissed_with_evidence'].includes(item.status),
    );
    if (existing) {
      const updated = {
        ...existing,
        ...input,
        lastCheckedAt: now,
        occurrenceCount: existing.occurrenceCount + 1,
      };
      this.reconciliationCases.set(existing.caseId, updated);
      return updated;
    }
    const created: ReconciliationCase = {
      ...input,
      caseId: `rc_${sha256(input.logicalIdentity).slice(0, 24)}`,
      firstDetectedAt: now,
      lastCheckedAt: now,
      occurrenceCount: 1,
    };
    this.reconciliationCases.set(created.caseId, created);
    return created;
  }
  async getReconciliationCase(caseId: string) {
    return this.reconciliationCases.get(caseId) ?? null;
  }
  async recordReconciliationAction(input: ReconciliationAction) {
    const existing = [...this.reconciliationActions.values()].find(
      (action) => action.idempotencyIdentity === input.idempotencyIdentity,
    );
    if (existing) return existing;
    this.reconciliationActions.set(input.actionId, input);
    const current = this.reconciliationCases.get(input.caseId);
    if (current)
      this.reconciliationCases.set(input.caseId, { ...current, lastActionId: input.actionId });
    return input;
  }
  async resolveReconciliationCase(
    caseId: string,
    resolution: string,
    evidence: Record<string, unknown>,
  ) {
    const current = this.reconciliationCases.get(caseId);
    if (!current || ['resolved', 'dismissed_with_evidence'].includes(current.status)) return;
    this.reconciliationCases.set(caseId, {
      ...current,
      status: 'resolved',
      resolution,
      resolutionEvidence: evidence,
      resolvedAt: new Date().toISOString(),
    });
  }
}
