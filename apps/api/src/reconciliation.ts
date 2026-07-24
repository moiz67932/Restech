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
  private repo: RestecRepository;
  private client: PaelyClient;

  constructor(repo: RestecRepository, client: PaelyClient) {
    this.repo = repo;
    this.client = client;
  }
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
  async reconcilePaymentSessions(limit = 25) {
    const sessions = await this.repo.listPaymentSessionsForReconciliation(limit);
    let matched = 0;
    let expired = 0;
    let reviewRequired = 0;
    for (const session of sessions) {
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        await this.repo.transitionPaymentSession(
          session.publicPaymentSessionId,
          'expired',
          new Date().toISOString(),
        );
        expired++;
        continue;
      }
      if (!session.privatePaymentSessionReference) {
        await this.repo.createAuditLog({
          actorType: 'service',
          actorId: 'payment_session_reconciliation',
          partnerId: session.partnerId,
          connectionId: session.connectionId,
          action: 'payment_session.creating_unattached',
          result: 'review_required',
          targetType: 'payment_session',
          targetId: session.publicPaymentSessionId,
        });
        reviewRequired++;
        continue;
      }
      try {
        const remote = await this.client.getPaymentSession(session.privatePaymentSessionReference);
        if (
          remote.amountMinor !== session.amountMinor ||
          remote.currency !== session.currency ||
          (remote.restecPaymentSessionReference &&
            remote.restecPaymentSessionReference !== session.publicPaymentSessionId)
        ) {
          reviewRequired++;
          await this.repo.createAuditLog({
            actorType: 'service',
            actorId: 'payment_session_reconciliation',
            partnerId: session.partnerId,
            connectionId: session.connectionId,
            action: 'payment_session.private_mismatch',
            result: 'review_required',
            targetType: 'payment_session',
            targetId: session.publicPaymentSessionId,
          });
          continue;
        }
        if (remote.status !== session.status)
          await this.repo.transitionPaymentSession(
            session.publicPaymentSessionId,
            remote.status,
            remote.paidAt ?? new Date().toISOString(),
          );
        matched++;
      } catch {
        await this.repo.createAuditLog({
          actorType: 'service',
          actorId: 'payment_session_reconciliation',
          partnerId: session.partnerId,
          connectionId: session.connectionId,
          action: 'payment_session.private_status_pending',
          result: 'pending',
          targetType: 'payment_session',
          targetId: session.publicPaymentSessionId,
        });
      }
    }
    return { examined: sessions.length, matched, expired, review_required: reviewRequired };
  }
}
