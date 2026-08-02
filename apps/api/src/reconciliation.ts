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
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'reconciliation.private_bill_failed',
          connection_id: connection.connectionId,
          external_bill_id: externalBillId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
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
        await this.repo.createAuditLog({
          actorType: 'service',
          actorId: 'payment_session_reconciliation',
          partnerId: session.partnerId,
          connectionId: session.connectionId,
          action: 'payment_session.expiry_event_pending',
          result: 'review_required',
          targetType: 'payment_session',
          targetId: session.publicPaymentSessionId,
          metadata: {
            local_status: session.status,
            expires_at: session.expiresAt,
          },
        });
        expired++;
        reviewRequired++;
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
        if (remote.status !== session.status) {
          const remoteTerminal = [
            'paid',
            'failed',
            'expired',
            'cancelled',
            'refunded',
            'partially_refunded',
          ].includes(remote.status);
          if (remoteTerminal) {
            reviewRequired++;
            await this.repo.createAuditLog({
              actorType: 'service',
              actorId: 'payment_session_reconciliation',
              partnerId: session.partnerId,
              connectionId: session.connectionId,
              action: 'payment_session.private_terminal_event_missing',
              result: 'review_required',
              targetType: 'payment_session',
              targetId: session.publicPaymentSessionId,
              metadata: {
                local_status: session.status,
                private_status: remote.status,
              },
            });
            console.error(
              JSON.stringify({
                event: 'payment_session.reconciliation_terminal_event_missing',
                payment_session_id: session.publicPaymentSessionId,
                private_payment_session_id: session.privatePaymentSessionReference,
                canonical_status: session.status,
                provider_status: remote.status,
              }),
            );
            continue;
          }
          await this.repo.transitionPaymentSession(
            session.publicPaymentSessionId,
            remote.status,
            remote.paidAt ?? new Date().toISOString(),
          );
        }
        matched++;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'payment_session.reconciliation_failed',
            payment_session_id: session.publicPaymentSessionId,
            private_payment_session_id: session.privatePaymentSessionReference,
            canonical_status: session.status,
            error_type: error instanceof Error ? error.name : typeof error,
          }),
        );
        await this.repo.createAuditLog({
          actorType: 'service',
          actorId: 'payment_session_reconciliation',
          partnerId: session.partnerId,
          connectionId: session.connectionId,
          action: 'payment_session.private_status_pending',
          result: 'pending',
          targetType: 'payment_session',
          targetId: session.publicPaymentSessionId,
          metadata: {
            local_status: session.status,
            error_type: error instanceof Error ? error.name : typeof error,
          },
        });
      }
    }
    return { examined: sessions.length, matched, expired, review_required: reviewRequired };
  }
}
