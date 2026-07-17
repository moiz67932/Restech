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
      result.address === '::1' ||
      result.address.startsWith('fe80:') ||
      result.address.startsWith('fc') ||
      result.address.startsWith('fd')
    )
      throw new Error('Unsafe webhook destination');
  }
  return url;
}
export const retryDelaySeconds = (attempt: number) =>
  [30, 120, 600, 1800, 7200, 21600, 43200][Math.min(Math.max(attempt - 1, 0), 6)]!;
