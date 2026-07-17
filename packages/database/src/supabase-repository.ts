import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptSecret, hashApiKey, secureEqual, sha256 } from '@restec/security';
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
} from './repository.js';
import type { CanonicalBillInput, CanonicalExternalPaymentInput } from '@restec/contracts';

export interface SupabaseRepositoryConfig {
  apiKeyHashSecret: string;
  secretEncryptionKey: string;
}
const apiKeyParts = (key: string) => {
  const match = /^rst_(?:test|live)_([a-f0-9]{12})[A-Za-z0-9_-]+$/.exec(key);
  return match?.[1] ?? null;
};
const dbError = (error: { message: string } | null) => {
  if (error) throw new Error('Database operation failed');
};
export class SupabaseRepository implements RestecRepository {
  constructor(
    private readonly db: SupabaseClient,
    private readonly config: SupabaseRepositoryConfig,
  ) {}
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
      restec_table_id: v.restec_table_id,
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
      duplicate: row?.event_id !== input.publicEventId,
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
      if (connection)
        result.push({
          id: row.id,
          publicEventId: row.public_event_id,
          connectionId: row.connection_id,
          eventType: row.event_type,
          schemaVersion: row.schema_version,
          payload: row.payload,
          attemptCount: row.attempt_count,
          configuration: connection.configuration,
          connectorType: connection.connectorType,
          connectorVersion: connection.connectorVersion,
          connectorEnabled: connection.connectorEnabled,
        });
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
  async createSandboxEvent(connectionId: string, scenario: string) {
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    const connection = await this.authorizeConnection(connectionId);
    if (!connection || connection.environment !== 'sandbox')
      throw new Error('Sandbox connection not found');
    const privateEventId = `sandbox_${randomUUID().replaceAll('-', '')}`;
    const type =
      scenario === 'payment.completed' ||
      scenario === 'payment.refunded' ||
      scenario === 'payment.failed'
        ? scenario
        : scenario === 'partial_payment.completed'
          ? 'payment.completed'
          : 'payment.failed';
    const payload = {
      id: eventId,
      type,
      schema_version: '2026-07-01',
      created_at: new Date().toISOString(),
      data: {
        location_id: connection.locationId,
        external_bill_id: `SANDBOX-${scenario}`,
        external_table_id: 'EXT-01',
        payment: {
          restec_payment_id: `pay_${sha256(eventId).slice(0, 20)}`,
          amount: scenario === 'partial_payment.completed' ? 500 : 1000,
          currency: 'PKR',
          method: 'card',
          status:
            type === 'payment.failed'
              ? 'failed'
              : type === 'payment.refunded'
                ? 'refunded'
                : 'completed',
        },
        bill: {
          grand_total: 1000,
          amount_paid:
            type === 'payment.completed'
              ? scenario === 'partial_payment.completed'
                ? 500
                : 1000
              : 0,
          amount_refunded: type === 'payment.refunded' ? 1000 : 0,
          amount_due:
            type === 'payment.completed'
              ? scenario === 'partial_payment.completed'
                ? 500
                : 0
              : 1000,
          payment_status:
            type === 'payment.completed'
              ? scenario === 'partial_payment.completed'
                ? 'partially_paid'
                : 'paid'
              : type === 'payment.refunded'
                ? 'refunded'
                : 'failed',
          version: 1,
        },
      },
    };
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
}
