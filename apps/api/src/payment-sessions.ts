import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { sha256 } from '@restec/security';
import type { PaymentSessionRecord } from '@restec/database';
import type { PaymentSessionStatus } from '@restec/contracts';

const suspicious = new Set([
  'card_number',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  'expiry',
  'expiration',
  'pin',
  'otp',
  'track_data',
  'trackdata',
  'safepay_secret',
  'merchant_secret',
]);

export function containsCardholderData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsCardholderData);
  return Object.entries(value).some(
    ([key, nested]) => suspicious.has(key.toLowerCase()) || containsCardholderData(nested),
  );
}

export const paymentSessionId = (
  environment: 'sandbox' | 'production',
  partnerId: string,
  locationId: string,
  externalBillId: string,
  idempotencyKey: string,
) =>
  `rps_${environment === 'production' ? 'live' : 'test'}_${sha256(
    `${environment}:${partnerId}:${locationId}:${externalBillId}:${idempotencyKey}`,
  ).slice(0, 26)}`;

export function allowedCheckoutHosts(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertCheckoutDestination(value: string, allowedHosts: Set<string>): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host) !== 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !allowedHosts.has(host)
  )
    throw new Error('invalid_checkout_destination');
  return url;
}

export type CheckoutLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family?: number }>>;

const privateAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a = -1, b = -1] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (
      value === '::' ||
      value === '::1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb') ||
      value.startsWith('ff')
    )
      return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return Boolean(mapped?.[1] && privateAddress(mapped[1]));
  }
  return true;
};

export async function assertResolvedCheckoutDestination(
  value: string,
  allowedHosts: Set<string>,
  lookup: CheckoutLookup = async (hostname) => dnsLookup(hostname, { all: true }),
): Promise<URL> {
  const url = assertCheckoutDestination(value, allowedHosts);
  const addresses = await lookup(url.hostname);
  if (!addresses.length || addresses.some((result) => privateAddress(result.address)))
    throw new Error('invalid_checkout_destination');
  return url;
}

export const publicStatus = (status: PaymentSessionStatus) =>
  status === 'creating' ? 'processing' : status;

export function paymentSessionResponse(record: PaymentSessionRecord, checkoutBase?: string) {
  return {
    payment_session_id: record.publicPaymentSessionId,
    location_id: record.locationId,
    external_bill_id: record.externalBillId,
    status: publicStatus(record.status),
    ...(checkoutBase
      ? {
          checkout_url: new URL(
            `/s/${encodeURIComponent(record.publicPaymentSessionId)}`,
            checkoutBase,
          ).toString(),
        }
      : {}),
    amount_minor: record.amountMinor,
    currency: record.currency,
    method: record.method,
    expires_at: record.expiresAt,
    ...(checkoutBase ? { created_at: record.createdAt } : {}),
    ...(!checkoutBase
      ? {
          paid_at: record.paidAt ?? null,
          failure:
            record.status === 'failed'
              ? { code: record.lastPublicErrorCode ?? 'PAYMENT_FAILED' }
              : null,
        }
      : {}),
  };
}

export const paymentStatusFromEvent = (
  eventType: string,
  reportedStatus?: PaymentSessionStatus,
): PaymentSessionStatus => {
  if (eventType === 'payment.failed' && reportedStatus === 'cancelled') return 'cancelled';
  const statuses: Record<string, PaymentSessionStatus> = {
    'payment.completed': 'paid',
    'payment.failed': 'failed',
    'payment.expired': 'expired',
    'payment.refunded': 'refunded',
    'payment.partially_refunded': 'partially_refunded',
  };
  const status = statuses[eventType];
  if (!status) throw new Error('unsupported_payment_event');
  return status;
};
