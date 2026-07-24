import type { PaymentSessionStatus } from './index.js';

const transitions: Record<PaymentSessionStatus, ReadonlySet<PaymentSessionStatus>> = {
  creating: new Set(['requires_customer_action', 'processing', 'paid', 'failed', 'expired']),
  requires_customer_action: new Set(['processing', 'paid', 'failed', 'expired', 'cancelled']),
  processing: new Set(['paid', 'failed', 'expired', 'cancelled']),
  paid: new Set(['partially_refunded', 'refunded']),
  failed: new Set(['paid']),
  expired: new Set(['paid']),
  cancelled: new Set(['paid']),
  partially_refunded: new Set(['partially_refunded', 'refunded']),
  refunded: new Set(),
};

export type PaymentSessionTransitionResult =
  | { kind: 'noop'; status: PaymentSessionStatus }
  | { kind: 'applied'; status: PaymentSessionStatus };

export function transitionPaymentSessionStatus(
  current: PaymentSessionStatus,
  requested: PaymentSessionStatus,
): PaymentSessionTransitionResult {
  if (current === requested) return { kind: 'noop', status: current };
  if (!transitions[current].has(requested))
    throw new Error(`invalid_payment_session_transition:${current}:${requested}`);
  return { kind: 'applied', status: requested };
}
