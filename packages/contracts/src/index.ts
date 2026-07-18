import { z } from 'zod';

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
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
    type: z.enum(['payment.completed', 'payment.failed', 'payment.refunded']),
    schema_version: z.literal('2026-07-01'),
    created_at: z.string().datetime(),
    data: z
      .object({
        location_id: publicIds.location,
        external_bill_id: z.string(),
        external_table_id: z.string(),
        payment: z
          .object({
            restec_payment_id: publicIds.payment,
            amount: minorAmount,
            currency: z.string().regex(/^[A-Z]{3}$/),
            method: z.string(),
            status: z.string(),
          })
          .strict(),
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
    if (bill.amount_due !== Math.max(0, bill.grand_total - bill.amount_paid + bill.amount_refunded))
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
export type CanonicalBillInput = z.infer<typeof billSchema>;
export type CanonicalExternalPaymentInput = z.infer<typeof externalPaymentSchema>;
export type CanonicalRestecEvent = z.infer<typeof eventSchema>;
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
  | 'invalid_status_transition'
  | 'rate_limited'
  | 'internal_error'
  | 'dependency_unavailable';
