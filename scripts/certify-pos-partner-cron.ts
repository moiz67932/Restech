import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { signRequest } from '@restec/security';

type Evidence = {
  payment_session_status?: string;
  bill_payment_status?: string | null;
  private_event_accepted?: boolean;
  payment_completed_inbox_count?: number;
  pos_outbox_status?: string | null;
  payment_completed_pos_count?: number;
  delivery_attempts?: number;
  mock_pos_accepted?: boolean;
  matching_mock_pos_receipt_count?: number;
  dead_lettered?: boolean;
};

export async function waitForCronCertification(input: {
  readStatus: () => Promise<{ status?: string }>;
  readEvidence: () => Promise<Evidence>;
  timeoutMs: number;
  pollMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const [status, evidence] = await Promise.all([input.readStatus(), input.readEvidence()]);
    const passed =
      status.status === 'paid' &&
      evidence.payment_session_status === 'paid' &&
      evidence.bill_payment_status === 'paid' &&
      evidence.private_event_accepted === true &&
      evidence.payment_completed_inbox_count === 1 &&
      evidence.pos_outbox_status === 'delivered' &&
      evidence.payment_completed_pos_count === 1 &&
      evidence.delivery_attempts === 1 &&
      evidence.mock_pos_accepted === true &&
      evidence.matching_mock_pos_receipt_count === 1 &&
      evidence.dead_lettered === false;
    if (passed) return { result: 'PASS' as const, status: status.status, evidence };
    if (evidence.dead_lettered === true) throw new Error('Certification event was dead-lettered.');
    if (Date.now() >= deadline) throw new Error('Cron-only certification timed out.');
    await sleep(input.pollMs);
  }
}

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

export async function main() {
  const baseUrl = new URL(required('RESTEC_PUBLIC_BASE_URL'));
  const locationId = required('RESTEC_SANDBOX_LOCATION_ID');
  const paymentSessionId = required('RESTEC_CERTIFICATION_PAYMENT_SESSION_ID');
  const apiKey = required('RESTEC_SANDBOX_TEST_API_KEY');
  const signingSecret = required('RESTEC_SANDBOX_REQUEST_SIGNING_SECRET');
  const jobToken = required('RESTEC_INTERNAL_JOB_TOKEN');
  const statusPath = `/v1/locations/${encodeURIComponent(locationId)}/payment-sessions/${encodeURIComponent(paymentSessionId)}`;
  const readStatus = async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(new URL(statusPath, baseUrl), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Restec-Environment': 'sandbox',
        'X-Restec-Timestamp': String(timestamp),
        'X-Restec-Signature': signRequest(signingSecret, timestamp, 'GET', statusPath, ''),
        'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
      },
    });
    if (!response.ok) throw new Error(`Public status returned HTTP ${response.status}.`);
    return (await response.json()) as { status?: string };
  };
  const readEvidence = async () => {
    const path = `/api/internal/test/payment-sessions/${encodeURIComponent(paymentSessionId)}/evidence`;
    const response = await fetch(new URL(path, baseUrl), {
      headers: { Authorization: `Bearer ${jobToken}` },
    });
    if (!response.ok) throw new Error(`Certification evidence returned HTTP ${response.status}.`);
    return (await response.json()) as Evidence;
  };
  const result = await waitForCronCertification({
    readStatus,
    readEvidence,
    timeoutMs: Number(process.env.RESTEC_CRON_CERTIFICATION_TIMEOUT_MS ?? 1_200_000),
    pollMs: Number(process.env.RESTEC_CRON_CERTIFICATION_POLL_MS ?? 15_000),
  });
  console.log(
    JSON.stringify({
      certification: 'RESTEC_POS_PARTNER_CRON_ONLY',
      result: result.result,
      public_status: result.status,
      inbox_count: result.evidence.payment_completed_inbox_count,
      pos_outbox_status: result.evidence.pos_outbox_status,
      pos_count: result.evidence.payment_completed_pos_count,
      delivery_attempts: result.evidence.delivery_attempts,
      dead_lettered: result.evidence.dead_lettered,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
