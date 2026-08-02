import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CertificationHttpError,
  CertificationCancelledError,
  CertificationStateError,
  assertCertificationTableAvailable,
  certificationBillBody,
  certificationStages,
  cleanupCertificationBill,
  createCertificationCancellationHandler,
  createCertificationDeadline,
  createPaymentSessionWithCleanup,
  isCertificationPass,
  monitorCertification,
  paelyCertificationDiagnosticsPath,
  reportPollingHttpResponse,
  type PaelyCertificationEvidence,
  type RestecCertificationEvidence,
} from './certify-real-payment-session.js';

const timedOutPublicSessionId = 'rps_test_33a8322a6ec21d0ed8ce12f838';
const timedOutPrivateSessionId = 'pps_a6bd99a4cc7f499185377aaf3ac94274';

const paidStatus = {
  status: 'paid',
  paid_at: '2026-08-01T00:00:00.000Z',
  external_bill_id: 'CERT-test',
};

const verifiedPaely = (overrides: PaelyCertificationEvidence = {}) => ({
  signature_valid: true,
  verified: true,
  processed: true,
  paely_private_session_status: 'paid',
  payment_completed_outbox_count: 1,
  paely_outbox_delivery_status: 'delivered',
  restec_delivery_http_status: 202,
  paely_outbox_dead_lettered: false,
  ...overrides,
});

const deliveredRestec = (overrides: RestecCertificationEvidence = {}) => ({
  payment_session_status: 'paid',
  paid_at: '2026-08-01T00:00:00.000Z',
  bill_payment_status: 'paid',
  private_event_accepted: true,
  payment_completed_inbox_count: 1,
  public_event_id: 'evt_test',
  pos_outbox_status: 'delivered',
  payment_completed_pos_count: 1,
  delivery_attempts: 1,
  mock_pos_accepted: true,
  matching_mock_pos_receipt_count: 1,
  dead_lettered: false,
  ...overrides,
});

test('table preflight rejects an unmapped external table before bill creation', () => {
  assert.throws(
    () =>
      assertCertificationTableAvailable('4', [
        { external_table_id: '1', active: true },
        { external_table_id: '2', active: true },
        { external_table_id: 'EXT-04', active: true },
      ]),
    /RESTEC_SANDBOX_EXTERNAL_TABLE_ID=4 is not mapped.*1, 2, EXT-04/,
  );
  assert.doesNotThrow(() =>
    assertCertificationTableAvailable('2', [
      { external_table_id: '1', active: true },
      { external_table_id: '2', active: true },
    ]),
  );
});

test('cleanupCertificationBill cancels the existing certification bill at the next version', async () => {
  const calls: Array<{
    method: string;
    path: string;
    body: any;
    idempotencyKey?: string;
    operation?: string;
  }> = [];
  const result = await cleanupCertificationBill({
    signedRequest: async (method, path, body, idempotencyKey, operation) => {
      calls.push({ method, path, body, idempotencyKey, operation });
      return Response.json({
        request_id: 'req_cleanup',
        external_bill_id: 'CERT-example',
        version: 4,
        order_status: 'cancelled',
      });
    },
    billPath: '/v1/locations/loc_test/bills/CERT-example',
    externalBillId: 'CERT-example',
    externalTableId: '2',
    currentVersion: 3,
  });

  assert.deepEqual(result, {
    request_id: 'req_cleanup',
    external_bill_id: 'CERT-example',
    version: 4,
    order_status: 'cancelled',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(calls[0]?.operation, 'bill_cleanup');
  assert.equal(calls[0]?.idempotencyKey, 'cert-cleanup-example-v4');
  assert.equal(calls[0]?.body.version, 4);
  assert.equal(calls[0]?.body.status, 'cancelled');
  assert.equal(calls[0]?.body.order_status, 'cancelled');
});

test('payment-session failure is classified and automatically cancels the bill', async () => {
  const calls: string[] = [];
  const reports: string[] = [];
  const original = new CertificationHttpError(
    'payment_session_create',
    502,
    'dependency_unavailable',
    'req_original',
    false,
  );

  await assert.rejects(
    createPaymentSessionWithCleanup({
      signedRequest: async (method, _path, body, _key, operation) => {
        calls.push(`${method}:${operation}`);
        if (operation === 'payment_session_create') throw original;
        assert.equal((body as { order_status: string }).order_status, 'cancelled');
        return Response.json({
          request_id: 'req_cleanup',
          external_bill_id: 'CERT-example',
          version: 2,
          order_status: 'cancelled',
        });
      },
      createPath: '/v1/locations/loc_test/bills/CERT-example/payment-sessions',
      createBody: { amount_minor: 10_000 },
      paymentIdempotencyKey: 'cert-payment-example',
      billPath: '/v1/locations/loc_test/bills/CERT-example',
      externalBillId: 'CERT-example',
      externalTableId: '2',
      expectedCheckoutOrigin: 'https://api.example',
      report: (message) => reports.push(message),
    }),
    (error) => error === original,
  );

  assert.deepEqual(calls, ['POST:payment_session_create', 'PUT:bill_cleanup']);
  assert.match(reports[0] ?? '', /restec\.certification_request_failure/);
  assert.match(reports[0] ?? '', /dependency_unavailable/);
  assert.match(reports[1] ?? '', /restec\.certification_bill_cleanup/);
  assert.match(reports[1] ?? '', /cancelled/);
});

test('failed automatic cleanup prints an exact sandbox cleanup command', async () => {
  const reports: string[] = [];
  await assert.rejects(
    createPaymentSessionWithCleanup({
      signedRequest: async (_method, _path, _body, _key, operation) => {
        if (operation === 'payment_session_create')
          throw new CertificationHttpError(
            'payment_session_create',
            502,
            'dependency_unavailable',
            'req_original',
            true,
          );
        throw new Error('cleanup dependency still unavailable');
      },
      createPath: '/payment-sessions',
      createBody: {},
      paymentIdempotencyKey: 'cert-payment-example',
      billPath: '/bills/CERT-example',
      externalBillId: 'CERT-example',
      externalTableId: '2',
      expectedCheckoutOrigin: 'https://api.example',
      report: (message) => reports.push(message),
    }),
    CertificationHttpError,
  );

  assert.match(reports.join('\n'), /Automatic certification bill cleanup failed/);
  assert.match(reports.join('\n'), /\$env:RESTEC_CERTIFICATION_EXTERNAL_BILL_ID='CERT-example'/);
  assert.match(reports.join('\n'), /npm run certify:real-payment-session -- --cleanup/);
});

test('invalid payment-session response also triggers bill cleanup', async () => {
  const operations: string[] = [];
  await assert.rejects(
    createPaymentSessionWithCleanup({
      signedRequest: async (_method, _path, _body, _key, operation) => {
        operations.push(operation ?? '');
        return Response.json(
          operation === 'payment_session_create'
            ? { status: 'unexpected' }
            : {
                request_id: 'req_cleanup',
                external_bill_id: 'CERT-example',
                version: 2,
                order_status: 'cancelled',
              },
        );
      },
      createPath: '/payment-sessions',
      createBody: {},
      paymentIdempotencyKey: 'cert-payment-example',
      billPath: '/bills/CERT-example',
      externalBillId: 'CERT-example',
      externalTableId: '2',
      expectedCheckoutOrigin: 'https://api.example',
      report: () => undefined,
    }),
    /response was incomplete/,
  );
  assert.deepEqual(operations, ['payment_session_create', 'bill_cleanup']);
});

test('certificationBillBody preserves financial values when cancelling', () => {
  const open = certificationBillBody('2', 1);
  const cancelled = certificationBillBody('2', 2, true);
  assert.deepEqual(cancelled.items, open.items);
  assert.deepEqual(cancelled.totals, open.totals);
  assert.equal(cancelled.external_table_id, open.external_table_id);
  assert.equal(cancelled.status, 'cancelled');
});

test('Paely diagnostics use the private session mapped by Restec evidence', () => {
  const path = paelyCertificationDiagnosticsPath({
    private_payment_session_id: timedOutPrivateSessionId,
    payment_session_status: 'requires_customer_action',
  });
  assert.equal(
    path,
    `/api/internal/integrations/restec/v1/certification/payment-sessions/${timedOutPrivateSessionId}/diagnostics`,
  );
  assert.equal(path.includes(timedOutPublicSessionId), false);
  assert.throws(
    () => paelyCertificationDiagnosticsPath({ payment_session_status: 'paid' }),
    /Deploy the Restec API before running certification/,
  );
});

test('polling diagnostics print each response body and redact private identifiers', async () => {
  const reports: Array<Record<string, any>> = [];
  await reportPollingHttpResponse(
    'paely_evidence',
    3,
    Response.json({
      status: 'paid',
      private_payment_session_id: timedOutPrivateSessionId,
      signature_valid: true,
      verified: true,
      processed: true,
    }),
    (diagnostic) => reports.push(diagnostic),
  );
  assert.deepEqual(reports, [
    {
      event: 'restec.certification_poll_http_response',
      attempt: 3,
      source: 'paely_evidence',
      http_status: 200,
      body: {
        status: 'paid',
        private_payment_session_id: '[redacted]',
        signature_valid: true,
        verified: true,
        processed: true,
      },
    },
  ]);
});

test('processed Safepay payment for the previously timed-out session completes polling', async () => {
  const pollReports: Array<Record<string, any>> = [];
  let paelyDispatches = 0;
  await monitorCertification({
    initialStatus: 'requires_customer_action',
    timeoutMs: 1_000,
    readRestecStatus: async () => ({ ...paidStatus, payment_session_id: timedOutPublicSessionId }),
    readPaelyEvidence: async () =>
      verifiedPaely({
        paely_outbox_delivery_status: paelyDispatches === 0 ? 'pending' : 'delivered',
      }),
    readRestecEvidence: async () => deliveredRestec(),
    dispatchPaely: async () => {
      paelyDispatches++;
    },
    dispatchRestec: async () => undefined,
    reportPoll: (diagnostic) => pollReports.push(diagnostic),
    sleep: async () => undefined,
  });
  assert.equal(paelyDispatches, 1);
  assert.equal(pollReports.length, 1);
  assert.equal((pollReports[0]?.paely_evidence as any)?.signature_valid, true);
  assert.equal((pollReports[0]?.paely_evidence as any)?.verified, true);
  assert.equal((pollReports[0]?.paely_evidence as any)?.processed, true);
  assert.equal((pollReports[0]?.paely_evidence as any)?.paely_private_session_status, 'paid');
});

test('authoritative Restec evidence passes when Paely dispatcher acceleration is unavailable', async () => {
  const reports: Array<{ stage: string; details?: Record<string, unknown> }> = [];
  let closes = 0;
  const result = await monitorCertification({
    initialStatus: 'requires_customer_action',
    timeoutMs: 1_000,
    operator: { promise: new Promise<void>(() => undefined), close: () => closes++ },
    readRestecStatus: async () => paidStatus,
    readPaelyEvidence: async () => ({
      dispatcher_status: 'credentials_not_configured',
      dispatcher_acceleration: 'manual_dispatcher_acceleration_unavailable',
    }),
    readRestecEvidence: async () => deliveredRestec(),
    reportStage: (stage, details) => reports.push({ stage, details }),
  });

  assert.equal(isCertificationPass(result.status, result.restec), true);
  assert.equal(closes, 1);
  const passReports = reports.filter(
    ({ stage, details }) => stage === 'certification_passed' && details?.result === 'PASS',
  );
  assert.equal(passReports.length, 1);
  assert.deepEqual(passReports[0]?.details?.public_session, paidStatus);
  assert.deepEqual(passReports[0]?.details?.restec_evidence, deliveredRestec());
});

test('PASS predicate requires every final authoritative Restec condition', () => {
  assert.equal(isCertificationPass(paidStatus, deliveredRestec()), true);
  assert.equal(
    isCertificationPass(paidStatus, deliveredRestec({ bill_payment_status: 'pending' })),
    false,
  );
  assert.equal(
    isCertificationPass(paidStatus, deliveredRestec({ private_event_accepted: false })),
    false,
  );
  assert.equal(
    isCertificationPass(paidStatus, deliveredRestec({ dead_lettered: undefined })),
    false,
  );
});

test('certification deadline cleanup clears its timer exactly once', () => {
  const fakeTimer = { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
  let clears = 0;
  const deadline = createCertificationDeadline(1_000, () => undefined, {
    set: () => fakeTimer,
    clear: (timer) => {
      assert.equal(timer, fakeTimer);
      clears++;
    },
  });
  deadline.close();
  deadline.close();
  assert.equal(clears, 1);
});

test('automatic progression succeeds without Enter and invokes configured dispatchers', async () => {
  const stages: string[] = [];
  let poll = -1;
  let operatorCloses = 0;
  let paelyDispatches = 0;
  let restecDispatches = 0;
  const neverEnter = new Promise<void>(() => undefined);

  await monitorCertification({
    initialStatus: 'requires_customer_action',
    timeoutMs: 1_000,
    operator: {
      promise: neverEnter,
      close: () => operatorCloses++,
    },
    readRestecStatus: async () => {
      poll++;
      return paidStatus;
    },
    readPaelyEvidence: async () =>
      poll === 0 ? verifiedPaely({ paely_outbox_delivery_status: 'pending' }) : verifiedPaely(),
    readRestecEvidence: async () =>
      poll === 0
        ? deliveredRestec({
            pos_outbox_status: 'pending',
            mock_pos_accepted: false,
            matching_mock_pos_receipt_count: 0,
          })
        : deliveredRestec(),
    dispatchPaely: async () => {
      paelyDispatches++;
    },
    dispatchRestec: async () => {
      restecDispatches++;
    },
    reportStage: (stage) => stages.push(stage),
    sleep: async () => undefined,
  });

  assert.equal(operatorCloses, 1);
  assert.equal(paelyDispatches, 1);
  assert.equal(restecDispatches, 1);
  assert.deepEqual(stages, certificationStages.slice(3));
});

test('operator Enter wins the safe race and success still waits for authoritative evidence', async () => {
  const reports: Array<{ stage: string; detectedBy?: unknown }> = [];
  let closes = 0;
  await monitorCertification({
    initialStatus: 'requires_customer_action',
    timeoutMs: 1_000,
    operator: { promise: Promise.resolve(), close: () => closes++ },
    readRestecStatus: async () => paidStatus,
    readPaelyEvidence: async () => verifiedPaely(),
    readRestecEvidence: async () => deliveredRestec(),
    dispatchRestec: async () => undefined,
    reportStage: (stage, details) => reports.push({ stage, detectedBy: details?.detected_by }),
  });
  assert.equal(closes, 1);
  assert.equal(reports[0]?.stage, 'checkout_returned');
  assert.equal(reports[0]?.detectedBy, 'operator');
  assert.equal(reports.at(-1)?.stage, 'certification_passed');
});

test('timeout prints sanitized state for every certification stage', async () => {
  let clock = 0;
  const diagnostics: Array<Record<string, any>> = [];
  await assert.rejects(
    monitorCertification({
      initialStatus: 'requires_customer_action',
      timeoutMs: 1,
      operator: { promise: Promise.resolve(), close: () => undefined },
      readRestecStatus: async () => ({ status: 'requires_customer_action' }),
      readPaelyEvidence: async () => ({ webhook_processing_error: 'token_secret-value' }),
      readRestecEvidence: async () => ({}),
      dispatchRestec: async () => undefined,
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    (error: unknown) => error instanceof CertificationStateError && error.code === 'timeout',
  );
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]?.stages ?? {}), certificationStages);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-value/);
});

test('SIGINT cancellation closes the operator resource exactly once', async () => {
  const controller = new AbortController();
  const reports: string[] = [];
  const onSigint = createCertificationCancellationHandler(controller, (stage) =>
    reports.push(stage),
  );
  onSigint();
  onSigint();
  let closes = 0;
  await assert.rejects(
    monitorCertification({
      initialStatus: 'requires_customer_action',
      timeoutMs: 1_000,
      signal: controller.signal,
      operator: {
        promise: new Promise<void>(() => undefined),
        close: () => closes++,
      },
      readRestecStatus: async () => ({ status: 'requires_customer_action' }),
      readPaelyEvidence: async () => ({}),
      readRestecEvidence: async () => ({}),
      dispatchRestec: async () => undefined,
    }),
    CertificationCancelledError,
  );
  assert.equal(closes, 1);
  assert.deepEqual(reports, ['certification_cancelled']);
});

test('duplicate payment.completed inbox evidence fails certification', async () => {
  await assert.rejects(
    monitorCertification({
      initialStatus: 'requires_customer_action',
      timeoutMs: 1_000,
      readRestecStatus: async () => paidStatus,
      readPaelyEvidence: async () => verifiedPaely(),
      readRestecEvidence: async () => deliveredRestec({ payment_completed_inbox_count: 2 }),
      dispatchRestec: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof CertificationStateError &&
      error.code === 'duplicate_payment_completed_inbox',
  );
});

test('a missing matching POS receipt times out without passing', async () => {
  let clock = 0;
  const stages: string[] = [];
  await assert.rejects(
    monitorCertification({
      initialStatus: 'requires_customer_action',
      timeoutMs: 1,
      operator: { promise: Promise.resolve(), close: () => undefined },
      readRestecStatus: async () => paidStatus,
      readPaelyEvidence: async () => verifiedPaely(),
      readRestecEvidence: async () =>
        deliveredRestec({
          mock_pos_accepted: false,
          matching_mock_pos_receipt_count: 0,
        }),
      dispatchRestec: async () => undefined,
      reportStage: (stage) => stages.push(stage),
      reportDiagnostic: () => undefined,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    }),
    (error: unknown) => error instanceof CertificationStateError && error.code === 'timeout',
  );
  assert.equal(stages.includes('mock_pos_received'), false);
  assert.equal(stages.includes('certification_passed'), false);
});

test('Paely payment.completed dead letter fails certification', async () => {
  await assert.rejects(
    monitorCertification({
      initialStatus: 'requires_customer_action',
      timeoutMs: 1_000,
      readRestecStatus: async () => paidStatus,
      readPaelyEvidence: async () =>
        verifiedPaely({
          paely_outbox_delivery_status: 'dead_letter',
          paely_outbox_dead_lettered: true,
        }),
      readRestecEvidence: async () => deliveredRestec(),
      dispatchRestec: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof CertificationStateError &&
      error.code === 'paely_payment_completed_dead_letter',
  );
});

test('Restec POS dead letter fails certification', async () => {
  await assert.rejects(
    monitorCertification({
      initialStatus: 'requires_customer_action',
      timeoutMs: 1_000,
      readRestecStatus: async () => paidStatus,
      readPaelyEvidence: async () => verifiedPaely(),
      readRestecEvidence: async () =>
        deliveredRestec({ pos_outbox_status: 'dead_letter', dead_lettered: true }),
      dispatchRestec: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof CertificationStateError && error.code === 'restec_pos_dead_letter',
  );
});
