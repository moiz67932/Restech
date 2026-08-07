import {
  RepositoryError,
  type RestecRepository,
  type AuthorizedLocation,
  type ReconciliationCaseType,
  type ReconciliationCaseSeverity,
} from '@restec/database';
import type { PaelyClient } from '@restec/paely-client';
import { eventSchema, type PaymentSessionStatus } from '@restec/contracts';
import { sha256 } from '@restec/security';
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
  private async recordCase(input: {
    connection: AuthorizedLocation;
    subjectType: string;
    subjectId: string;
    caseType: ReconciliationCaseType;
    severity: ReconciliationCaseSeverity;
    restecStateSnapshot: Record<string, unknown>;
    providerStateSnapshot?: Record<string, unknown>;
    differenceSummary: Record<string, unknown>;
    recommendedAction: string;
    automaticActionAllowed: boolean;
  }) {
    return this.repo.upsertReconciliationCase?.({
      logicalIdentity: `${input.connection.environment}:${input.connection.locationId}:${input.subjectType}:${input.subjectId}:${input.caseType}`,
      environment: input.connection.environment,
      partnerId: input.connection.partnerId,
      locationId: input.connection.locationId,
      connectionId: input.connection.connectionId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      caseType: input.caseType,
      severity: input.severity,
      status: input.automaticActionAllowed ? 'auto_repair_pending' : 'manual_review_required',
      detectedAt: new Date().toISOString(),
      restecStateSnapshot: input.restecStateSnapshot,
      differenceSummary: input.differenceSummary,
      recommendedAction: input.recommendedAction,
      automaticActionAllowed: input.automaticActionAllowed,
      createdBy: 'reconciliation',
      ...(input.providerStateSnapshot
        ? { providerStateSnapshot: input.providerStateSnapshot }
        : {}),
    });
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
    if (differences.length) {
      await this.recordCase({
        connection,
        subjectType: 'bill',
        subjectId: externalBillId,
        caseType: 'bill_projection_drift',
        severity: differences.some((item) =>
          ['amount_paid', 'amount_refunded', 'amount_due'].includes(item.field),
        )
          ? 'critical'
          : 'medium',
        restecStateSnapshot: { ...local },
        providerStateSnapshot: { ...remote },
        differenceSummary: { fields: differences },
        recommendedAction: 'compare_provider_state_and_require_manual_review',
        automaticActionAllowed: false,
      });
    }
    return { status: differences.length ? 'mismatch' : 'matched', differences };
  }
  async markManualReview(connection: AuthorizedLocation, externalBillId: string, actorId: string) {
    const bill = await this.repo.getBill(connection.connectionId, externalBillId);
    const caseRecord = await this.recordCase({
      connection,
      subjectType: 'bill',
      subjectId: externalBillId,
      caseType: 'bill_projection_drift',
      severity: 'high',
      restecStateSnapshot: bill ? { ...bill } : { missing: true },
      differenceSummary: { operator_requested: true },
      recommendedAction: 'manual_review',
      automaticActionAllowed: false,
    });
    await this.repo.createAuditLog({
      actorType: 'service',
      actorId,
      partnerId: connection.partnerId,
      connectionId: connection.connectionId,
      action: 'reconciliation.manual_review',
      result: 'accepted',
      targetType: 'bill',
      targetId: externalBillId,
      metadata: { case_id: caseRecord?.caseId ?? null },
    });
    return caseRecord;
  }
  async requeueEvent(eventId: string, actorId: string) {
    const actionId = `ra_${sha256(`requeue_pos_event:${eventId}`).slice(0, 24)}`;
    await this.repo.replayOutboxEvent(eventId);
    const caseRecord = this.repo.getReconciliationCase
      ? await this.repo.getReconciliationCase(
          `rc_${sha256(`event:${eventId}:pos_event_dead_lettered`).slice(0, 24)}`,
        )
      : null;
    if (this.repo.recordReconciliationAction && caseRecord) {
      await this.repo.recordReconciliationAction({
        actionId,
        caseId: caseRecord.caseId,
        actionType: 'requeue_pos_event',
        idempotencyIdentity: `requeue_pos_event:${eventId}`,
        requestedBy: actorId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: 'accepted',
        evidence: { event_id: eventId, preserves_logical_event_identity: true },
      });
    }
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
    let terminalized = 0;
    let expiryPendingConfirmation = 0;
    let reviewRequired = 0;
    for (const session of sessions) {
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
      let providerStatus: PaymentSessionStatus | undefined;
      try {
        const remote = await this.client.getPaymentSession(session.privatePaymentSessionReference);
        providerStatus = remote.status;
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
        const phase4Terminal = ['paid', 'failed', 'expired', 'cancelled'].includes(remote.status);
        if (phase4Terminal) {
          const localBill = await this.repo.getBill(session.connectionId, session.externalBillId);
          if (!localBill) throw new Error('payment_session_bill_missing');
          const bill =
            remote.status === 'paid'
              ? await this.client.getBill(session.privateLocationReference, session.externalBillId)
              : localBill;
          if (
            bill.currency !== session.currency ||
            bill.amount_due !== Math.max(0, bill.grand_total - bill.amount_paid) ||
            (remote.status === 'paid' && bill.amount_paid < session.amountMinor)
          )
            throw new Error('payment_session_reconciliation_bill_mismatch');
          const occurredAt = remote.paidAt ?? new Date().toISOString();
          const identity = sha256(
            `payment-session-reconciliation:${session.publicPaymentSessionId}:${remote.status}`,
          );
          const eventType =
            remote.status === 'paid'
              ? 'payment.completed'
              : remote.status === 'expired'
                ? 'payment.expired'
                : 'payment.failed';
          const publicEvent = eventSchema.parse({
            id: `evt_${identity.slice(0, 24)}`,
            type: eventType,
            schema_version: '2026-07-01',
            created_at: occurredAt,
            data: {
              location_id: session.locationId,
              external_bill_id: session.externalBillId,
              external_table_id: bill.external_table_id,
              payment_session_id: session.publicPaymentSessionId,
              payment: {
                restec_payment_id: `pay_${identity.slice(0, 20)}`,
                amount: session.amountMinor,
                currency: session.currency,
                method: session.method,
                status: remote.status === 'paid' ? 'completed' : 'failed',
              },
              bill: {
                grand_total: bill.grand_total,
                amount_paid: bill.amount_paid,
                amount_refunded: bill.amount_refunded,
                amount_due: bill.amount_due,
                payment_status: bill.payment_status,
                version: bill.version,
              },
            },
          });
          const privatePayload = {
            data: {
              connection_id: session.privateConnectionReference,
              location_id: session.privateLocationReference,
              external_bill_id: session.externalBillId,
              payment: {
                payment_id: `reconciliation-${identity}`,
                amount: session.amountMinor,
                currency: session.currency,
                method: session.method,
                status: remote.status === 'paid' ? 'completed' : 'failed',
              },
              payment_session: {
                private_payment_session_id: session.privatePaymentSessionReference,
                status: remote.status,
              },
            },
          };
          const accepted = await this.repo.acceptPaymentSessionEvent({
            privateEventId: `reconciliation:${identity}`,
            eventType,
            schemaVersion: '2026-07-01',
            connectionId: session.connectionId,
            requestHash: sha256(JSON.stringify(privatePayload)),
            payload: privatePayload,
            publicEventId: publicEvent.id,
            publicPayload: publicEvent,
            publicPaymentSessionId: session.publicPaymentSessionId,
            requestedStatus: remote.status as PaymentSessionStatus,
          });
          terminalized += accepted.duplicate ? 0 : 1;
          expired += remote.status === 'expired' && !accepted.duplicate ? 1 : 0;
          await this.repo.createAuditLog({
            actorType: 'service',
            actorId: 'payment_session_reconciliation',
            partnerId: session.partnerId,
            connectionId: session.connectionId,
            action: 'payment_session.provider_terminal_committed',
            result: accepted.duplicate ? 'duplicate' : remote.status,
            targetType: 'payment_session',
            targetId: session.publicPaymentSessionId,
            metadata: { prior_status: session.status, provider_status: remote.status },
          });
          console.info(
            JSON.stringify({
              event: 'payment_session.reconciliation_terminal_committed',
              payment_session_id: session.publicPaymentSessionId,
              prior_status: session.status,
              provider_status: remote.status,
              duplicate: accepted.duplicate,
            }),
          );
          continue;
        }
        if (['refunded', 'partially_refunded'].includes(remote.status)) {
          reviewRequired++;
          continue;
        }
        if (remote.status !== session.status) {
          await this.repo.transitionPaymentSession(
            session.publicPaymentSessionId,
            remote.status,
            remote.paidAt ?? new Date().toISOString(),
          );
        }
        if (new Date(session.expiresAt).getTime() <= Date.now()) {
          expiryPendingConfirmation++;
          await this.repo.createAuditLog({
            actorType: 'service',
            actorId: 'payment_session_reconciliation',
            partnerId: session.partnerId,
            connectionId: session.connectionId,
            action: 'payment_session.expiry_pending_confirmation',
            result: 'pending',
            targetType: 'payment_session',
            targetId: session.publicPaymentSessionId,
            metadata: {
              local_status: session.status,
              provider_status: remote.status,
              expires_at: session.expiresAt,
              reservation_retained: true,
            },
          });
        }
        matched++;
      } catch (error) {
        const lateSuccessConflict =
          providerStatus === 'paid' &&
          error instanceof RepositoryError &&
          error.code === 'payment_capacity_conflict';
        if (lateSuccessConflict) reviewRequired++;
        console.error(
          JSON.stringify({
            event: lateSuccessConflict
              ? 'payment_session.late_success_capacity_conflict'
              : 'payment_session.reconciliation_failed',
            payment_session_id: session.publicPaymentSessionId,
            private_payment_session_id: session.privatePaymentSessionReference,
            canonical_status: session.status,
            provider_status: providerStatus ?? null,
            error_type: error instanceof Error ? error.name : typeof error,
          }),
        );
        await this.repo.createAuditLog({
          actorType: 'service',
          actorId: 'payment_session_reconciliation',
          partnerId: session.partnerId,
          connectionId: session.connectionId,
          action: lateSuccessConflict
            ? 'payment_session.late_success_capacity_conflict'
            : 'payment_session.private_status_pending',
          result: lateSuccessConflict ? 'review_required' : 'pending',
          targetType: 'payment_session',
          targetId: session.publicPaymentSessionId,
          metadata: {
            local_status: session.status,
            provider_status: providerStatus ?? null,
            error_type: error instanceof Error ? error.name : typeof error,
          },
        });
      }
    }
    return {
      examined: sessions.length,
      matched,
      expired,
      terminalized,
      expiry_pending_confirmation: expiryPendingConfirmation,
      review_required: reviewRequired,
    };
  }
}
