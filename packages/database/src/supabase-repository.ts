import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptSecret, hashApiKey, secureEqual, sha256 } from '@restec/security';
import { RepositoryError } from './repository.js';
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
} from './repository.js';
import {
  eventSchema,
  type CanonicalBillInput,
  type CanonicalExternalPaymentInput,
  type PaymentSessionStatus,
} from '@restec/contracts';

export interface SupabaseRepositoryConfig {
  apiKeyHashSecret: string;
  secretEncryptionKey: string;
}
const apiKeyParts = (key: string) => {
  const match = /^rst_(?:test|live)_([a-f0-9]{12})[A-Za-z0-9_-]+$/.exec(key);
  return match?.[1] ?? null;
};
const publicRepositoryCodes = new Set([
  'resource_not_found',
  'replay_detected',
  'idempotency_conflict',
  'bill_version_conflict',
  'payment_in_progress',
  'bill_already_paid',
  'amount_mismatch',
  'invalid_status_transition',
  'paely_connection_mapping_not_found',
  'paely_location_mapping_not_found',
  'connection_reference_mismatch',
  'location_reference_mismatch',
  'payment_session_reference_mismatch',
  'external_bill_reference_mismatch',
  'payment_method_mismatch',
  'payment_status_mismatch',
]);
const dbError = (error: { message: string } | null) => {
  if (error) {
    const code = [...publicRepositoryCodes].find((value) => error.message.includes(value));
    if (code) throw new RepositoryError(code as any);
    throw new Error('Database operation failed');
  }
};
const paymentSessionRow = (data: any): PaymentSessionRecord => ({
  id: data.id,
  publicPaymentSessionId: data.public_payment_session_id,
  environment: data.environment,
  partnerId: data.partner_id,
  connectionId: data.connection_id,
  locationId: data.location_id,
  externalBillId: data.external_bill_id,
  privateLocationReference: data.private_location_reference,
  privateConnectionReference: data.private_connection_reference,
  ...(data.private_payment_session_reference
    ? { privatePaymentSessionReference: data.private_payment_session_reference }
    : {}),
  ...(data.encrypted_provider_checkout_url
    ? { encryptedProviderCheckoutUrl: data.encrypted_provider_checkout_url }
    : {}),
  ...(data.provider_checkout_host ? { providerCheckoutHost: data.provider_checkout_host } : {}),
  method: data.method,
  amountMinor: Number(data.amount_minor),
  currency: data.currency,
  status: data.status,
  expiresAt: data.expires_at,
  ...(data.paid_at ? { paidAt: data.paid_at } : {}),
  ...(data.failed_at ? { failedAt: data.failed_at } : {}),
  ...(data.cancelled_at ? { cancelledAt: data.cancelled_at } : {}),
  idempotencyKey: data.idempotency_key,
  requestFingerprint: data.request_fingerprint,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  ...(data.last_public_error_code ? { lastPublicErrorCode: data.last_public_error_code } : {}),
  ...(data.last_private_status ? { lastPrivateStatus: data.last_private_status } : {}),
});
export class SupabaseRepository implements RestecRepository {
  private readonly db: SupabaseClient;
  private readonly config: SupabaseRepositoryConfig;

  constructor(db: SupabaseClient, config: SupabaseRepositoryConfig) {
    this.db = db;
    this.config = config;
  }
  async authenticateApiKey(apiKey: string, environment: Environment) {
    const prefix = apiKeyParts(apiKey);
    if (!prefix) return null;
    const { data, error } = await this.db
      .from('api_keys')
      .select(
        'partner_id,environment,key_prefix,key_hash,status,expires_at,encrypted_signing_secret',
      )
      .eq('key_prefix', prefix)
      .eq('environment', environment)
      .in('status', ['active', 'overlap'])
      .maybeSingle();
    dbError(error);
    if (
      !data ||
      (data.expires_at && new Date(data.expires_at) <= new Date()) ||
      !secureEqual(hashApiKey(apiKey, this.config.apiKeyHashSecret), data.key_hash) ||
      !data.encrypted_signing_secret
    )
      return null;
    const authenticated = {
      partnerId: data.partner_id,
      environment: data.environment as Environment,
      signingSecret: decryptSecret(data.encrypted_signing_secret, this.config.secretEncryptionKey),
      status: data.status,
      keyPrefix: data.key_prefix,
    };
    return data.expires_at
      ? { ...authenticated, expiresAt: new Date(data.expires_at) }
      : authenticated;
  }
  async recordApiKeyUsage(partnerId: string, keyPrefix: string) {
    const { error } = await this.db
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('partner_id', partnerId)
      .eq('key_prefix', keyPrefix);
    dbError(error);
  }
  async reserveReplay(input: {
    requestId: string;
    partnerId: string;
    requestHash: string;
    environment: Environment;
    timestamp: number;
  }) {
    const { error } = await this.db.from('replay_records').insert({
      request_id: input.requestId,
      partner_id: input.partnerId,
      request_hash: input.requestHash,
      environment: input.environment,
      signed_timestamp: input.timestamp,
    });
    if (error?.code === '23505') return false;
    dbError(error);
    return true;
  }
  async reserveIdempotency(
    partnerId: string,
    key: string,
    value: Omit<IdempotencyRecord, 'status'>,
  ) {
    const row = {
      partner_id: partnerId,
      idempotency_key: key,
      request_hash: value.requestHash,
      method: value.method,
      path: value.path,
      status: 'processing',
    };
    const { error } = await this.db.from('idempotency_records').insert(row);
    if (!error) return { kind: 'new' } as const;
    if (error.code !== '23505') dbError(error);
    const { data, error: readError } = await this.db
      .from('idempotency_records')
      .select('request_hash,method,path,status,response_status,response_body')
      .eq('partner_id', partnerId)
      .eq('idempotency_key', key)
      .single();
    dbError(readError);
    if (!data) throw new Error('Database operation failed');
    if (
      data.request_hash !== value.requestHash ||
      data.method !== value.method ||
      data.path !== value.path
    )
      return { kind: 'conflict' } as const;
    if (data.status === 'processing') return { kind: 'processing' } as const;
    if (data.status === 'failed') {
      const { error: retryError } = await this.db
        .from('idempotency_records')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('partner_id', partnerId)
        .eq('idempotency_key', key)
        .eq('status', 'failed');
      dbError(retryError);
      return { kind: 'new' } as const;
    }
    return {
      kind: 'replay',
      result: {
        requestHash: data.request_hash,
        method: data.method,
        path: data.path,
        status: 'completed',
        responseStatus: data.response_status,
        responseBody: data.response_body,
      },
    } as const;
  }
  async completeIdempotency(partnerId: string, key: string, status: number, body: unknown) {
    const { error } = await this.db
      .from('idempotency_records')
      .update({
        status: 'completed',
        response_status: status,
        response_body: body,
        updated_at: new Date().toISOString(),
      })
      .eq('partner_id', partnerId)
      .eq('idempotency_key', key);
    dbError(error);
  }
  async releaseIdempotency(partnerId: string, key: string) {
    const { error } = await this.db
      .from('idempotency_records')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('partner_id', partnerId)
      .eq('idempotency_key', key)
      .eq('status', 'processing');
    dbError(error);
  }
  async authorizeLocation(
    locationId: string,
    partnerId: string,
    environment: Environment,
  ): Promise<AuthorizedLocation | null> {
    const { data, error } = await this.db
      .from('pos_connections')
      .select(
        'id,partner_id,location_id,environment,connector_type,connector_version,status,private_connection_reference,encrypted_configuration,locations!inner(private_location_reference,restaurant_id,restaurants!inner(partner_id))',
      )
      .eq('location_id', locationId)
      .eq('partner_id', partnerId)
      .eq('environment', environment)
      .eq('status', 'active')
      .order('connector_type')
      .limit(1)
      .maybeSingle();
    dbError(error);
    if (!data) return null;
    const location = Array.isArray(data.locations) ? data.locations[0] : data.locations;
    const restaurant =
      location &&
      (Array.isArray(location.restaurants) ? location.restaurants[0] : location.restaurants);
    if (!location || restaurant?.partner_id !== partnerId) return null;
    let configuration: Record<string, unknown> = {};
    try {
      configuration = JSON.parse(
        decryptSecret(data.encrypted_configuration, this.config.secretEncryptionKey),
      );
    } catch {
      return null;
    }
    return {
      connectionId: data.id,
      partnerId: data.partner_id,
      locationId: data.location_id,
      environment: data.environment,
      connectorType: data.connector_type,
      connectorVersion: data.connector_version,
      connectorEnabled: data.status === 'active',
      privateLocationId: location.private_location_reference,
      privateConnectionId: data.private_connection_reference,
      configuration,
    };
  }
  async listTables(connectionId: string) {
    const { data, error } = await this.db
      .from('table_mappings')
      .select('external_table_id,restec_table_id,active,pos_tables!inner(name)')
      .eq('connection_id', connectionId)
      .order('external_table_id');
    dbError(error);
    return (data ?? []).map((v: any) => ({
      table_id: v.restec_table_id,
      external_table_id: v.external_table_id,
      name: (Array.isArray(v.pos_tables) ? v.pos_tables[0] : v.pos_tables).name,
      active: v.active,
    }));
  }
  async getTableMapping(connectionId: string, externalTableId: string) {
    const rows = await this.listTables(connectionId);
    const row = rows.find((v) => v.external_table_id === externalTableId);
    return row ? { ...row, connection_id: connectionId } : null;
  }
  async validateBillMutation(
    connectionId: string,
    externalBillId: string,
    version: number,
    requestHash: string,
  ) {
    const { data, error } = await this.db
      .from('bill_mappings')
      .select('current_version,last_request_hash,public_state')
      .eq('connection_id', connectionId)
      .eq('external_bill_id', externalBillId)
      .maybeSingle();
    dbError(error);
    if (!data) {
      if (version !== 1) throw new RepositoryError('bill_version_conflict');
      return { kind: 'proceed' } as const;
    }
    if (
      version < data.current_version ||
      (version === data.current_version && requestHash !== data.last_request_hash)
    )
      throw new RepositoryError('bill_version_conflict');
    if (version === data.current_version)
      return { kind: 'replay', state: data.public_state as CanonicalBillState } as const;
    return { kind: 'proceed' } as const;
  }
  async saveBillState(
    connectionId: string,
    externalBillId: string,
    input: CanonicalBillInput,
    state: CanonicalBillState,
    requestHash: string,
    privateReference: string,
  ) {
    const { data, error } = await this.db.rpc('persist_restec_bill_state', {
      p_connection_id: connectionId,
      p_external_bill_id: externalBillId,
      p_public_bill_id: state.restec_bill_id,
      p_private_reference: privateReference,
      p_version: input.version,
      p_request_hash: requestHash,
      p_public_state: state,
    });
    dbError(error);
    return data as CanonicalBillState;
  }
  async getBill(connectionId: string, externalBillId: string) {
    const { data, error } = await this.db
      .from('bill_mappings')
      .select('public_state')
      .eq('connection_id', connectionId)
      .eq('external_bill_id', externalBillId)
      .maybeSingle();
    dbError(error);
    return (data?.public_state as CanonicalBillState) ?? null;
  }
  async validateExternalPayment(
    connectionId: string,
    externalBillId: string,
    input: CanonicalExternalPaymentInput,
    requestHash: string,
  ) {
    const { data: bill, error } = await this.db
      .from('bill_mappings')
      .select('id,public_state')
      .eq('connection_id', connectionId)
      .eq('external_bill_id', externalBillId)
      .maybeSingle();
    dbError(error);
    if (!bill) throw new RepositoryError('resource_not_found');
    const { data: payment, error: paymentError } = await this.db
      .from('external_payments')
      .select('bill_mapping_id,request_hash,public_state')
      .eq('connection_id', connectionId)
      .eq('external_payment_id', input.external_payment_id)
      .maybeSingle();
    dbError(paymentError);
    if (payment) {
      if (payment.bill_mapping_id !== bill.id || payment.request_hash !== requestHash)
        throw new RepositoryError('idempotency_conflict');
      return {
        kind: 'replay',
        state: (payment.public_state ?? bill.public_state) as CanonicalBillState,
      } as const;
    }
    const state = bill.public_state as CanonicalBillState;
    if (state.currency !== input.currency) throw new RepositoryError('amount_mismatch');
    if (state.payment_status === 'payment_in_progress')
      throw new RepositoryError('payment_in_progress');
    if (state.amount_due === 0 || input.amount > state.amount_due)
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
    const publicPaymentId = `pay_${sha256(`${connectionId}:${input.external_payment_id}`).slice(0, 24)}`;
    const { data, error } = await this.db.rpc('persist_restec_external_payment', {
      p_connection_id: connectionId,
      p_external_bill_id: externalBillId,
      p_external_payment_id: input.external_payment_id,
      p_public_payment_id: publicPaymentId,
      p_request_hash: requestHash,
      p_amount: input.amount,
      p_currency: input.currency,
      p_public_state: state,
    });
    dbError(error);
    return data as CanonicalBillState;
  }
  async acceptPrivateEvent(input: PrivateEventInput) {
    const { data, error } = await this.db.rpc('accept_private_event', {
      p_private_event_id: input.privateEventId,
      p_event_type: input.eventType,
      p_schema_version: input.schemaVersion,
      p_connection_id: input.connectionId,
      p_request_hash: input.requestHash,
      p_payload: input.payload,
      p_public_event_id: input.publicEventId,
      p_public_payload: input.publicPayload,
    });
    dbError(error);
    const row = data?.[0];
    return {
      eventId: row?.event_id ?? input.publicEventId,
      duplicate: row?.accepted === false,
    };
  }
  async getConnectionForPrivateEvent(privateConnectionId: string) {
    const { data, error } = await this.db
      .from('pos_connections')
      .select('location_id,partner_id,environment')
      .eq('private_connection_reference', privateConnectionId)
      .eq('status', 'active')
      .maybeSingle();
    dbError(error);
    return data
      ? this.authorizeLocation(data.location_id, data.partner_id, data.environment)
      : null;
  }
  async getLocationForPrivateEvent(privateLocationId: string) {
    const { data, error } = await this.db
      .from('locations')
      .select('id,environment')
      .eq('private_location_reference', privateLocationId)
      .maybeSingle();
    dbError(error);
    return data ? { locationId: data.id, environment: data.environment } : null;
  }
  async findSandboxConnection(partnerId: string, externalBillId: string) {
    const { data: bill } = await this.db
      .from('bill_mappings')
      .select('connection_id,pos_connections!inner(partner_id,environment)')
      .eq('external_bill_id', externalBillId)
      .eq('pos_connections.partner_id', partnerId)
      .eq('pos_connections.environment', 'sandbox')
      .limit(1)
      .maybeSingle();
    if (bill) return this.authorizeConnection(bill.connection_id);
    const { data, error } = await this.db
      .from('pos_connections')
      .select('id')
      .eq('partner_id', partnerId)
      .eq('environment', 'sandbox')
      .eq('status', 'active')
      .limit(2);
    dbError(error);
    return data?.length === 1 ? this.authorizeConnection(data[0]!.id) : null;
  }
  async claimPosOutboxEvents(
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedPosOutboxEvent[]> {
    const { data, error } = await this.db.rpc('claim_pos_outbox', {
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    dbError(error);
    const result: ClaimedPosOutboxEvent[] = [];
    for (const row of data ?? []) {
      const connection = await this.authorizeConnection(row.connection_id);
      if (connection) {
        const { data: sandbox } = await this.db
          .from('sandbox_scenarios')
          .select('scenario')
          .eq('public_event_id', row.public_event_id)
          .maybeSingle();
        const failureMode = sandbox?.scenario?.startsWith('webhook_')
          ? sandbox.scenario.replace('webhook_', '')
          : undefined;
        result.push({
          id: row.id,
          publicEventId: row.public_event_id,
          connectionId: row.connection_id,
          eventType: row.event_type,
          schemaVersion: row.schema_version,
          payload: row.payload,
          attemptCount: row.attempt_count,
          configuration: failureMode
            ? { ...connection.configuration, failure_mode: failureMode }
            : connection.configuration,
          connectorType: failureMode ? 'mock_pos' : connection.connectorType,
          connectorVersion: failureMode ? '1.0.0' : connection.connectorVersion,
          connectorEnabled: connection.connectorEnabled,
        });
      }
    }
    return result;
  }
  private async authorizeConnection(id: string) {
    const { data, error } = await this.db
      .from('pos_connections')
      .select('location_id,partner_id,environment')
      .eq('id', id)
      .maybeSingle();
    dbError(error);
    return data
      ? this.authorizeLocation(data.location_id, data.partner_id, data.environment)
      : null;
  }
  async recordDeliveryAttempt(input: DeliveryAttempt) {
    const { error } = await this.db.from('webhook_delivery_attempts').insert({
      outbox_event_id: input.eventId,
      attempt_number: input.attemptNumber,
      response_status: input.responseStatus,
      outcome: input.outcome,
      error_code: input.errorCode,
      duration_ms: input.durationMs,
    });
    if (error?.code !== '23505') dbError(error);
    const { error: updateError } = await this.db
      .from('pos_outbox_events')
      .update({ attempt_count: input.attemptNumber })
      .eq('id', input.eventId);
    dbError(updateError);
  }
  async completeOutboxDelivery(input: DeliveryAttempt & { responseStatus: number }) {
    const { error } = await this.db.rpc('complete_pos_outbox_delivery', {
      p_event_id: input.eventId,
      p_attempt: input.attemptNumber,
      p_status: input.responseStatus,
      p_duration: input.durationMs,
    });
    dbError(error);
  }
  async failOutboxDelivery(input: DeliveryAttempt & { nextAttemptAt?: Date; errorCode: string }) {
    const { error } = await this.db.rpc('fail_pos_outbox_delivery', {
      p_event_id: input.eventId,
      p_attempt: input.attemptNumber,
      p_status: input.responseStatus ?? null,
      p_outcome: input.outcome,
      p_error: input.errorCode,
      p_duration: input.durationMs,
      p_next: input.nextAttemptAt?.toISOString() ?? null,
    });
    dbError(error);
  }
  async markOutboxDelivered(eventId: string) {
    const { error } = await this.db
      .from('pos_outbox_events')
      .update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        locked_at: null,
        lock_expires_at: null,
      })
      .eq('id', eventId);
    dbError(error);
  }
  async scheduleOutboxRetry(eventId: string, next: Date, errorCode: string) {
    const { error } = await this.db
      .from('pos_outbox_events')
      .update({
        status: 'pending',
        next_attempt_at: next.toISOString(),
        last_error_code: errorCode,
        locked_at: null,
        lock_expires_at: null,
      })
      .eq('id', eventId);
    dbError(error);
  }
  async markOutboxDeadLetter(eventId: string, errorCode: string) {
    const { error } = await this.db
      .from('pos_outbox_events')
      .update({
        status: 'dead_letter',
        last_error_code: errorCode,
        locked_at: null,
        lock_expires_at: null,
      })
      .eq('id', eventId);
    dbError(error);
  }
  async releaseExpiredLeases() {
    const { data, error } = await this.db.rpc('release_expired_pos_outbox_leases');
    dbError(error);
    return data ?? 0;
  }
  async replayOutboxEvent(eventId: string) {
    const { error } = await this.db.rpc('replay_pos_outbox_event', { p_event_id: eventId });
    dbError(error);
  }
  async createSandboxEvent(
    connectionId: string,
    scenario: string,
    externalBillId: string,
    amount?: number,
  ) {
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    const connection = await this.authorizeConnection(connectionId);
    if (!connection || connection.environment !== 'sandbox')
      throw new Error('Sandbox connection not found');
    const privateEventId = `sandbox_${randomUUID().replaceAll('-', '')}`;
    const bill = await this.getBill(connectionId, externalBillId);
    if (!bill) throw new RepositoryError('resource_not_found');
    if (scenario === 'amount_mismatch') throw new RepositoryError('amount_mismatch');
    if (scenario === 'bill_already_paid') throw new RepositoryError('bill_already_paid');
    const type =
      scenario === 'payment.refunded'
        ? 'payment.refunded'
        : scenario === 'payment.failed'
          ? 'payment.failed'
          : 'payment.completed';
    const grandTotal = bill.grand_total;
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
    const payload = eventSchema.parse({
      id: eventId,
      type,
      schema_version: '2026-07-01',
      created_at: new Date(
        Date.now() - (scenario === 'out_of_order_event' ? 60_000 : 0),
      ).toISOString(),
      data: {
        location_id: connection.locationId,
        external_bill_id: externalBillId,
        external_table_id: bill.external_table_id,
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
            type === 'payment.completed'
              ? nextDue > 0
                ? 'partially_paid'
                : 'paid'
              : type === 'payment.refunded'
                ? nextRefunded === nextPaid
                  ? 'refunded'
                  : 'partially_refunded'
                : 'failed',
          version: bill.version,
        },
      },
    });
    const accepted = {
      privateEventId,
      eventType: type,
      schemaVersion: '2026-07-01',
      connectionId,
      requestHash: sha256(JSON.stringify(payload)),
      payload: { id: privateEventId, type, scenario },
      publicEventId: eventId,
      publicPayload: payload as any,
    };
    await this.acceptPrivateEvent(accepted);
    if (scenario === 'duplicate_event') await this.acceptPrivateEvent(accepted);
    await this.createAuditLog({
      actorType: 'sandbox',
      connectionId,
      action: 'sandbox.scenario.created',
      result: 'accepted',
      targetType: 'event',
      targetId: eventId,
      metadata: { scenario },
    });
    const { error: scenarioError } = await this.db.from('sandbox_scenarios').insert({
      connection_id: connectionId,
      scenario,
      external_bill_id: externalBillId,
      requested_amount: amount,
      public_event_id: eventId,
      status: 'accepted',
    });
    dbError(scenarioError);
    if (scenario === 'delayed_event') {
      const { error: delayError } = await this.db
        .from('pos_outbox_events')
        .update({ next_attempt_at: new Date(Date.now() + 30_000).toISOString() })
        .eq('public_event_id', eventId);
      dbError(delayError);
    }
    return { eventId };
  }
  async createAuditLog(input: AuditInput) {
    const { error } = await this.db.from('audit_logs').insert({
      actor_type: input.actorType,
      actor_id: input.actorId,
      partner_id: input.partnerId,
      connection_id: input.connectionId,
      request_id: input.requestId,
      action: input.action,
      result: input.result,
      target_type: input.targetType,
      target_id: input.targetId,
      metadata: input.metadata ?? {},
    });
    dbError(error);
  }
  async reservePaymentSession(input: CreatePaymentSessionInput) {
    const row = {
      public_payment_session_id: input.publicPaymentSessionId,
      environment: input.environment,
      partner_id: input.partnerId,
      connection_id: input.connectionId,
      location_id: input.locationId,
      external_bill_id: input.externalBillId,
      private_location_reference: input.privateLocationReference,
      private_connection_reference: input.privateConnectionReference,
      method: input.method,
      amount_minor: input.amountMinor,
      currency: input.currency,
      status: input.status,
      expires_at: input.expiresAt,
      idempotency_key: input.idempotencyKey,
      request_fingerprint: input.requestFingerprint,
    };
    const { data, error } = await this.db.from('payment_sessions').insert(row).select('*').single();
    if (!error && data) return { record: paymentSessionRow(data), created: true };
    if (error?.code !== '23505') dbError(error);
    const { data: existing, error: readError } = await this.db
      .from('payment_sessions')
      .select('*')
      .eq('public_payment_session_id', input.publicPaymentSessionId)
      .maybeSingle();
    dbError(readError);
    if (!existing) throw new RepositoryError('payment_in_progress');
    if (existing.request_fingerprint !== input.requestFingerprint)
      throw new RepositoryError('idempotency_conflict');
    return { record: paymentSessionRow(existing), created: false };
  }
  async attachPaymentSession(input: AttachPaymentSessionInput) {
    const { data, error } = await this.db
      .from('payment_sessions')
      .update({
        private_payment_session_reference: input.privatePaymentSessionReference,
        encrypted_provider_checkout_url: input.encryptedProviderCheckoutUrl,
        provider_checkout_host: input.providerCheckoutHost,
        status: input.status,
        expires_at: input.expiresAt,
        last_private_status: input.status,
        updated_at: new Date().toISOString(),
      })
      .eq('public_payment_session_id', input.publicPaymentSessionId)
      .in('status', ['creating', 'requires_customer_action', 'processing'])
      .select('*')
      .single();
    dbError(error);
    if (!data) throw new RepositoryError('resource_not_found');
    return paymentSessionRow(data);
  }
  async claimPaymentSessionCheckoutRefresh(
    publicPaymentSessionId: string,
    lockToken: string,
    leaseSeconds: number,
  ) {
    const { data, error } = await this.db.rpc('claim_payment_session_checkout_refresh', {
      p_public_payment_session_id: publicPaymentSessionId,
      p_lock_token: lockToken,
      p_lease_seconds: leaseSeconds,
    });
    dbError(error);
    return data?.[0] ? paymentSessionRow(data[0]) : null;
  }
  async completePaymentSessionCheckoutRefresh(input: CompletePaymentSessionCheckoutRefreshInput) {
    const { data, error } = await this.db.rpc('complete_payment_session_checkout_refresh', {
      p_public_payment_session_id: input.publicPaymentSessionId,
      p_private_payment_session_reference: input.privatePaymentSessionReference,
      p_lock_token: input.lockToken,
      p_encrypted_provider_checkout_url: input.encryptedProviderCheckoutUrl,
      p_provider_checkout_host: input.providerCheckoutHost,
    });
    dbError(error);
    return data?.[0] ? paymentSessionRow(data[0]) : null;
  }
  async releasePaymentSessionCheckoutRefresh(publicPaymentSessionId: string, lockToken: string) {
    const { error } = await this.db.rpc('release_payment_session_checkout_refresh', {
      p_public_payment_session_id: publicPaymentSessionId,
      p_lock_token: lockToken,
    });
    dbError(error);
  }
  async getPaymentSession(publicPaymentSessionId: string) {
    const { data, error } = await this.db
      .from('payment_sessions')
      .select('*')
      .eq('public_payment_session_id', publicPaymentSessionId)
      .maybeSingle();
    dbError(error);
    return data ? paymentSessionRow(data) : null;
  }
  async transitionPaymentSession(
    publicPaymentSessionId: string,
    requestedStatus: PaymentSessionStatus,
    occurredAt: string,
  ) {
    const { data, error } = await this.db.rpc('transition_payment_session', {
      p_public_payment_session_id: publicPaymentSessionId,
      p_requested_status: requestedStatus,
      p_occurred_at: occurredAt,
    });
    dbError(error);
    const result = data?.[0];
    if (!result?.session) throw new RepositoryError('resource_not_found');
    return { record: paymentSessionRow(result.session), changed: Boolean(result.changed) };
  }
  async acceptPaymentSessionEvent(input: PaymentSessionEventInput) {
    const { data, error } = await this.db.rpc('accept_payment_session_event', {
      p_private_event_id: input.privateEventId,
      p_event_type: input.eventType,
      p_schema_version: input.schemaVersion,
      p_connection_id: input.connectionId,
      p_request_hash: input.requestHash,
      p_payload: input.payload,
      p_public_event_id: input.publicEventId,
      p_public_payload: input.publicPayload,
      p_public_payment_session_id: input.publicPaymentSessionId,
      p_requested_status: input.requestedStatus,
    });
    dbError(error);
    const result = data?.[0];
    if (!result || typeof result.event_id !== 'string' || typeof result.accepted !== 'boolean')
      throw new Error('event_commit_incomplete');
    return {
      eventId: result.event_id,
      duplicate: result.accepted === false,
    };
  }
  async getMockPosWebhookContext(eventId: string) {
    const { data, error } = await this.db
      .from('pos_outbox_events')
      .select('connection_id')
      .eq('public_event_id', eventId)
      .maybeSingle();
    dbError(error);
    if (!data) return null;
    const connection = await this.authorizeConnection(data.connection_id);
    const secret = connection?.configuration.webhook_secret;
    return connection && typeof secret === 'string'
      ? { connectionId: connection.connectionId, signingSecret: secret }
      : null;
  }
  async acceptMockPosReceipt(input: MockPosReceipt) {
    const { error } = await this.db.from('mock_pos_receipts').insert({
      event_id: input.eventId,
      connection_id: input.connectionId,
      request_hash: input.requestHash,
      event_type: input.eventType,
      received_at: input.receivedAt,
    });
    if (!error) return { duplicate: false };
    if (error.code !== '23505') dbError(error);
    const { data, error: readError } = await this.db
      .from('mock_pos_receipts')
      .select('request_hash')
      .eq('event_id', input.eventId)
      .single();
    dbError(readError);
    if (data?.request_hash !== input.requestHash) throw new RepositoryError('replay_detected');
    return { duplicate: true };
  }
  async getLastMockPosReceipt() {
    const { data, error } = await this.db
      .from('mock_pos_receipts')
      .select('event_id,connection_id,request_hash,event_type,received_at')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    dbError(error);
    return data
      ? {
          eventId: data.event_id,
          connectionId: data.connection_id,
          requestHash: data.request_hash,
          eventType: data.event_type,
          receivedAt: data.received_at,
        }
      : null;
  }
  async getPaymentSessionCertificationEvidence(publicPaymentSessionId: string) {
    const session = await this.getPaymentSession(publicPaymentSessionId);
    if (!session) return null;
    const [billResult, outboxResult] = await Promise.all([
      this.db
        .from('bill_mappings')
        .select('payment_status')
        .eq('connection_id', session.connectionId)
        .eq('external_bill_id', session.externalBillId)
        .maybeSingle(),
      this.db
        .from('pos_outbox_events')
        .select('id,public_event_id,status,deduplication_key,attempt_count,event_type')
        .eq('connection_id', session.connectionId)
        .eq('event_type', 'payment.completed')
        .contains('payload', { data: { payment_session_id: publicPaymentSessionId } })
        .order('created_at', { ascending: false }),
    ]);
    dbError(billResult.error);
    dbError(outboxResult.error);
    const outboxes = outboxResult.data ?? [];
    const outbox = outboxes[0];
    let paymentCompletedInboxCount = 0;
    let matchingMockPosReceiptCount = 0;
    if (outboxes.length > 0) {
      const privateEventIds = outboxes.map((event) => event.deduplication_key);
      const publicEventIds = outboxes.map((event) => event.public_event_id);
      const [inboxResult, receiptResult] = await Promise.all([
        this.db
          .from('private_event_inbox')
          .select('private_event_id', { count: 'exact' })
          .in('private_event_id', privateEventIds)
          .eq('event_type', 'payment.completed')
          .eq('status', 'accepted'),
        this.db
          .from('mock_pos_receipts')
          .select('event_id', { count: 'exact' })
          .in('event_id', publicEventIds)
          .eq('event_type', 'payment.completed'),
      ]);
      dbError(inboxResult.error);
      dbError(receiptResult.error);
      paymentCompletedInboxCount = inboxResult.count ?? inboxResult.data?.length ?? 0;
      matchingMockPosReceiptCount = receiptResult.count ?? receiptResult.data?.length ?? 0;
    }
    return {
      privatePaymentSessionReference: session.privatePaymentSessionReference,
      paymentSessionStatus: session.status,
      paidAt: session.paidAt ?? null,
      billPaymentStatus: billResult.data?.payment_status ?? null,
      privateEventAccepted: paymentCompletedInboxCount > 0,
      paymentCompletedInboxCount,
      publicEventId: outbox?.public_event_id ?? null,
      posOutboxStatus: outbox?.status ?? null,
      paymentCompletedPosCount: outboxes.length,
      deliveryAttempts: outbox?.attempt_count ?? 0,
      mockPosAccepted: matchingMockPosReceiptCount > 0,
      matchingMockPosReceiptCount,
      deadLettered: outboxes.some((event) => event.status === 'dead_letter'),
    };
  }
  async listPaymentSessionsForReconciliation(limit: number) {
    const { data, error } = await this.db
      .from('payment_sessions')
      .select('*')
      .in('status', ['creating', 'requires_customer_action', 'processing'])
      .order('updated_at', { ascending: true })
      .limit(limit);
    dbError(error);
    return (data ?? []).map(paymentSessionRow);
  }
}
