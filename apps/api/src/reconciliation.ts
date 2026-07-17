import type { RestecRepository, AuthorizedLocation } from '@restec/database';
import type { PaelyClient } from '@restec/paely-client';
export type ReconciliationStatus = 'matched' | 'pending' | 'mismatch' | 'review_required';
const fields = [
  'version',
  'grand_total',
  'currency',
  'amount_paid',
  'amount_refunded',
  'amount_due',
  'payment_status',
] as const;
export class ReconciliationService {
  constructor(
    private repo: RestecRepository,
    private client: PaelyClient,
  ) {}
  async compare(
    connection: AuthorizedLocation,
    externalBillId: string,
  ): Promise<{
    status: ReconciliationStatus;
    differences: Array<{ field: string; restec: unknown; private: unknown }>;
  }> {
    const local = await this.repo.getBill(connection.connectionId, externalBillId);
    if (!local)
      return {
        status: 'review_required',
        differences: [{ field: 'bill', restec: null, private: 'present_or_unknown' }],
      };
    let remote: Awaited<ReturnType<PaelyClient['getBill']>>;
    try {
      remote = await this.client.getBill(connection.privateLocationId, externalBillId);
    } catch {
      return { status: 'pending', differences: [] };
    }
    const differences = fields.flatMap((field) =>
      local[field] === remote[field]
        ? []
        : [{ field, restec: local[field], private: remote[field] }],
    );
    return { status: differences.length ? 'mismatch' : 'matched', differences };
  }
  async markManualReview(connection: AuthorizedLocation, externalBillId: string, actorId: string) {
    await this.repo.createAuditLog({
      actorType: 'service',
      actorId,
      partnerId: connection.partnerId,
      connectionId: connection.connectionId,
      action: 'reconciliation.manual_review',
      result: 'accepted',
      targetType: 'bill',
      targetId: externalBillId,
    });
  }
  async requeueEvent(eventId: string, actorId: string) {
    await this.repo.replayOutboxEvent(eventId);
    await this.repo.createAuditLog({
      actorType: 'service',
      actorId,
      action: 'reconciliation.outbox_requeued',
      result: 'accepted',
      targetType: 'event',
      targetId: eventId,
    });
  }
}
