import { z } from 'zod';

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$`));
export const publicIds = {
  partner: id('ptr'),
  restaurant: id('rst'),
  location: id('loc'),
  table: id('tbl'),
  connection: id('con'),
  bill: id('bil'),
  payment: id('pay'),
  event: id('evt'),
  request: id('req'),
  paymentSession: z.string().regex(/^rps_(?:test|live)_[A-Za-z0-9]+$/),
};
export const minorAmount = z.number().int().min(0).max(2_147_483_647);
const metadata = z
  .record(z.unknown())
  .default({})
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 8192, 'Metadata exceeds 8 KB');
export const billItemSchema = z
  .object({
    external_item_id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(10_000),
    unit_amount: minorAmount,
    total_amount: minorAmount,
    notes: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.unit_amount * v.quantity === v.total_amount, 'Item total is inconsistent');
export const billSchema = z
  .object({
    external_table_id: z.string().min(1).max(128),
    external_order_id: z.string().min(1).max(128).optional(),
    version: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(['open', 'completed', 'cancelled']),
    order_status: z
      .enum(['open', 'accepted', 'preparing', 'ready', 'served', 'completed', 'cancelled'])
      .default('accepted'),
    items: z.array(billItemSchema).min(1).max(250),
    totals: z
      .object({
        subtotal: minorAmount,
        tax: minorAmount,
        service_charge: minorAmount,
        discount: minorAmount,
        tip: minorAmount,
        grand_total: minorAmount,
      })
      .strict(),
    occurred_at: z.string().datetime(),
    metadata,
  })
  .strict()
  .superRefine((v, ctx) => {
    const subtotal = v.items.reduce((sum, item) => sum + item.total_amount, 0);
    if (subtotal !== v.totals.subtotal)
      ctx.addIssue({
        code: 'custom',
        message: 'Subtotal is inconsistent',
        path: ['totals', 'subtotal'],
      });
    const total =
      subtotal + v.totals.tax + v.totals.service_charge + v.totals.tip - v.totals.discount;
    if (total !== v.totals.grand_total)
      ctx.addIssue({
        code: 'custom',
        message: 'Grand total is inconsistent',
        path: ['totals', 'grand_total'],
      });
  });
export const externalPaymentSchema = z
  .object({
    external_payment_id: z.string().min(1).max(128),
    method: z.enum(['cash', 'card_terminal', 'wallet_terminal', 'voucher', 'other']),
    amount: minorAmount.positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.literal('completed'),
    occurred_at: z.string().datetime(),
    processor_reference: z.string().max(200).optional(),
    metadata,
  })
  .strict();
export const paymentSessionStatusSchema = z.enum([
  'creating',
  'requires_customer_action',
  'processing',
  'paid',
  'failed',
  'expired',
  'cancelled',
  'refunded',
  'partially_refunded',
]);
export const publicPaymentSessionStatusSchema = paymentSessionStatusSchema.exclude(['creating']);
export const paymentSessionMethodSchema = z.enum(['card', 'google_pay']);
export const paymentSessionRequestSchema = z
  .object({
    amount_minor: z.number().int().positive().max(2_147_483_647),
    currency: z.literal('PKR'),
    method: z.literal('card'),
    customer: z
      .object({
        email: z.string().email().max(254).optional(),
        mobile: z
          .string()
          .regex(/^\+?[0-9][0-9 -]{6,18}[0-9]$/)
          .optional(),
      })
      .strict()
      .optional(),
    return_context: z
      .object({ pos_reference: z.string().min(1).max(128).optional() })
      .strict()
      .optional(),
  })
  .strict();
export const privatePaymentSessionResponseSchema = z
  .object({
    privatePaymentSessionId: z.string().min(1).max(256),
    status: z.literal('requires_customer_action'),
    providerCheckoutUrl: z.string().url().max(4096),
    amountMinor: z.number().int().positive(),
    currency: z.literal('PKR'),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const paymentStatusSchema = z.enum([
  'unpaid',
  'payment_in_progress',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
]);
export const eventSchema = z
  .object({
    id: publicIds.event,
    type: z.enum([
      'payment.completed',
      'payment.failed',
      'payment.expired',
      'payment.refunded',
      'payment.partially_refunded',
    ]),
    schema_version: z.literal('2026-07-01'),
    created_at: z.string().datetime(),
    data: z
      .object({
        location_id: publicIds.location,
        external_bill_id: z.string(),
        external_table_id: z.string(),
        payment_session_id: publicIds.paymentSession.optional(),
        payment: z
          .object({
            restec_payment_id: publicIds.payment,
            amount: minorAmount,
            currency: z.string().regex(/^[A-Z]{3}$/),
            method: z.string(),
            status: z.string(),
          })
          .strict(),
        correction: z
          .object({
            correction_id: z.string().regex(/^cor_[A-Za-z0-9]+$/),
            type: z.literal('refund'),
            original_payment_id: publicIds.payment,
            amount: minorAmount.positive(),
            currency: z.string().regex(/^[A-Z]{3}$/),
            status: z.enum(['completed', 'ambiguous', 'review_required']),
          })
          .strict()
          .optional(),
        bill: z
          .object({
            grand_total: minorAmount,
            amount_paid: minorAmount,
            amount_refunded: minorAmount,
            amount_due: minorAmount,
            payment_status: paymentStatusSchema,
            version: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, ctx) => {
    const { bill } = event.data;
    if (bill.amount_due !== Math.max(0, bill.grand_total - bill.amount_paid))
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'bill', 'amount_due'],
        message: 'Bill amounts are inconsistent',
      });
    if (bill.payment_status === 'paid' && bill.amount_due !== 0)
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'bill', 'payment_status'],
        message: 'Paid bills must have no amount due',
      });
  });
export const partnerWebhookEventSchema = z
  .object({
    event_id: publicIds.event,
    event_type: z.enum([
      'payment.completed',
      'payment.failed',
      'payment.expired',
      'payment.refunded',
      'payment.partially_refunded',
    ]),
    event_version: z.literal('1.0'),
    occurred_at: z.string().datetime(),
    environment: z.enum(['sandbox', 'production']),
    partner_id: publicIds.partner,
    location_id: publicIds.location,
    external_bill_id: z.string().min(1).max(128),
    payment_session_id: publicIds.paymentSession.optional(),
    payment_reference: publicIds.payment,
    amount_minor: minorAmount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    payment_method: z.enum([
      'card',
      'wallet',
      'cash',
      'card_terminal',
      'wallet_terminal',
      'voucher',
      'other',
    ]),
    payment_status: z.enum(['completed', 'failed', 'refunded']),
    correction: z
      .object({
        correction_id: z.string().regex(/^cor_[A-Za-z0-9]+$/),
        type: z.literal('refund'),
        original_payment_id: publicIds.payment,
        amount_minor: minorAmount.positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        status: z.enum(['completed', 'ambiguous', 'review_required']),
      })
      .strict()
      .optional(),
    bill: z
      .object({
        grand_total: minorAmount,
        amount_paid: minorAmount,
        amount_refunded: minorAmount,
        amount_due: minorAmount,
        payment_status: paymentStatusSchema,
        version: z.number().int().positive(),
      })
      .strict(),
    metadata: z.record(z.unknown()),
  })
  .strict();
export type CanonicalBillInput = z.infer<typeof billSchema>;
export type CanonicalExternalPaymentInput = z.infer<typeof externalPaymentSchema>;
export type CanonicalRestecEvent = z.infer<typeof eventSchema>;
export type PartnerWebhookEvent = z.infer<typeof partnerWebhookEventSchema>;
export type PaymentSessionRequest = z.infer<typeof paymentSessionRequestSchema>;
export type PaymentSessionStatus = z.infer<typeof paymentSessionStatusSchema>;
export type PublicPaymentSessionStatus = z.infer<typeof publicPaymentSessionStatusSchema>;
export type PaymentSessionMethod = z.infer<typeof paymentSessionMethodSchema>;
export type PublicErrorCode =
  | 'invalid_request'
  | 'invalid_credentials'
  | 'access_denied'
  | 'resource_not_found'
  | 'replay_detected'
  | 'idempotency_conflict'
  | 'bill_version_conflict'
  | 'payment_in_progress'
  | 'bill_already_paid'
  | 'payload_too_large'
  | 'amount_mismatch'
  | 'paely_connection_mapping_not_found'
  | 'paely_location_mapping_not_found'
  | 'connection_reference_mismatch'
  | 'location_reference_mismatch'
  | 'payment_session_reference_mismatch'
  | 'external_bill_reference_mismatch'
  | 'payment_method_mismatch'
  | 'payment_status_mismatch'
  | 'invalid_status_transition'
  | 'bill_not_payable'
  | 'amount_exceeds_balance'
  | 'payment_capacity_conflict'
  | 'table_active_bill_conflict'
  | 'bill_table_generation_conflict'
  | 'bill_financial_floor_conflict'
  | 'payment_outcome_ambiguous'
  | 'currency_not_supported'
  | 'payment_method_not_available'
  | 'payment_session_expired'
  | 'payment_session_not_found'
  | 'payment_session_already_completed'
  | 'payment_confirmation_pending'
  | 'invalid_checkout_destination'
  | 'rate_limited'
  | 'internal_error'
  | 'dependency_unavailable';
export * from './payment-session-state.js';
