import { randomUUID } from 'node:crypto';
import type { Connection, Credential, Repository, StoredResult } from './types.js';
export class MemoryRepository implements Repository {
  credentials = new Map<string, Credential>();
  connections = new Map<string, Connection>();
  requests = new Set<string>();
  idempotency = new Map<string, StoredResult>();
  bills = new Map<string, unknown>();
  events = new Map<string, string>();
  async findCredential(k: string) {
    return this.credentials.get(k) ?? null;
  }
  async consumeRequestId(id: string) {
    if (this.requests.has(id)) return false;
    this.requests.add(id);
    return true;
  }
  async findConnection(locationId: string, partnerId: string) {
    return (
      [...this.connections.values()].find(
        (v) => v.locationId === locationId && v.partnerId === partnerId,
      ) ?? null
    );
  }
  async beginIdempotency(partnerId: string, key: string, value: Omit<StoredResult, 'status'>) {
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
  async saveBill(connectionId: string, externalBillId: string, state: unknown) {
    this.bills.set(`${connectionId}:${externalBillId}`, state);
  }
  async getBill(connectionId: string, externalBillId: string) {
    return this.bills.get(`${connectionId}:${externalBillId}`) ?? null;
  }
  async listTables() {
    return [];
  }
  async acceptPrivateEvent(input: { privateEventId: string; publicEventId: string }) {
    const old = this.events.get(input.privateEventId);
    if (old) return { eventId: old, duplicate: true };
    this.events.set(input.privateEventId, input.publicEventId);
    return { eventId: input.publicEventId, duplicate: false };
  }
  async createSandboxEvent() {
    return { eventId: `evt_${randomUUID().replaceAll('-', '')}` };
  }
}
