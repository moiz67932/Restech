import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
const unsafeNames = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
const unsafeV4 = (host: string) => {
  const p = host.split('.').map(Number);
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] !== undefined && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] === 0
  );
};
const unsafeV6 = (host: string) => {
  const value = host.toLowerCase();
  if (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('fc') ||
    value.startsWith('fd')
  )
    return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  return Boolean(mapped?.[1] && unsafeV4(mapped[1]));
};
export async function assertSafeWebhookUrl(
  value: string,
  environment: 'sandbox' | 'production' | 'test',
  lookup: typeof dnsLookup = dnsLookup,
) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && environment === 'production')
    throw new Error('Webhook URL must use HTTPS');
  if (url.username || url.password || unsafeNames.has(url.hostname.toLowerCase()))
    throw new Error('Unsafe webhook destination');
  const addresses = await lookup(url.hostname, { all: true });
  for (const result of addresses) {
    if (
      (isIP(result.address) === 4 && unsafeV4(result.address)) ||
      (isIP(result.address) === 6 && unsafeV6(result.address))
    )
      throw new Error('Unsafe webhook destination');
  }
  return url;
}
export const retryDelaySeconds = (attempt: number) =>
  [30, 120, 600, 1800, 7200, 21600, 43200][Math.min(Math.max(attempt - 1, 0), 6)]!;

export * from './secret-rotation.js';
