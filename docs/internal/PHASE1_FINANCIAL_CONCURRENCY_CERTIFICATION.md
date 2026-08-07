# Phase 1 financial concurrency certification

## Verdict

`RESTEC_PHASE1_FINANCIAL_CONCURRENCY_PARTIAL`

The unsafe runtime ordering is corrected in application code and the forward migration, and all runnable financial tests pass. Certification is partial because the migration and concurrency RPCs could not be executed against PostgreSQL/Supabase, and provider timeout-after-success behavior was not exercised against a real sandbox.

## 1. Baseline

- Branch: `main`
- Commit: `151e2994090b6e42847387b467874b4c6f365ea5`
- Existing untracked audit files were preserved and updated only for the requested use cases.
- Full evidence: `PHASE1_FINANCIAL_CONCURRENCY_BASELINE.md`.

Baseline unit/mock behavior was green. Repository formatting and dependency audit gates were already red. Real database/provider tests were gated.

## 2. Original races

| Use case | Original cause                                                                                         | Correction                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| UC-012   | Paid floor was checked after downstream bill mutation and ignored active/ambiguous money.              | Reserve the revision under the bill lock and validate the full protected floor before downstream mutation.                                |
| UC-036   | Digital sessions and POS payments had separate balance views.                                          | Both create a bill-scoped financial reservation before downstream work.                                                                   |
| UC-041   | Bill version preflight was an unlocked read; the row lock occurred after downstream mutation.          | A durable bill-mutation reservation serializes the version and effective total first.                                                     |
| UC-042   | Distinct POS requests both called downstream before `persist_restec_external_payment` locked the bill. | `reserve_bill_capacity` locks and consumes capacity first; only the winner calls downstream.                                              |
| UC-043   | Digital completion and POS commit used unrelated transactions.                                         | The session owns capacity from creation; authoritative completion converts that reservation atomically with inbox, bill, and outbox work. |

The exact original call order is in `PHASE1_CURRENT_FINANCIAL_CALL_ORDER.md`.

## 3. Architecture and schema

The smallest compatible design adds two append-oriented evidence sets:

- A financial reservation/commitment per stable external-payment or public payment-session identity.
- A bill-mutation reservation per bill revision.

Existing payment, session, inbox, outbox, and bill tables remain. The migration backfills existing completed external payments and payment sessions without dropping financial history. Location/environment scope is inherited through the authorized connection and bill mapping; every reservation stores the connection and bill identity.

The atomic operations are:

- `reserve_bill_capacity`: bill row lock, identity conflict/retry check, currency/amount validation, one-active-digital policy, available-capacity calculation, and reservation insert.
- `mark_financial_reservation_ambiguous`: monotonic reserved-to-ambiguous transition.
- `persist_restec_external_payment`: locks bill and reservation, verifies facts, inserts the immutable payment, converts reservation to completed, and updates the bill.
- `reserve_bill_mutation`: locks bill, version and active revision, calculates the financial floor, and persists the proposed effective total.
- `persist_restec_bill_state`: requires the matching revision reservation before updating an existing bill.
- `accept_payment_session_event`: locks session, bill, and reservation; applies the monotonic session transition; converts/releases capacity; updates bill; inserts inbox/outbox exactly once.

Migration: `supabase/migrations/20260807000100_financial_capacity_reservations.sql`.

## 4. Authoritative projection

All values are integer minor units. While a lower bill revision is reserved or ambiguous, its proposed total is the effective capacity ceiling:

```text
effective_bill_total_minor = min(current_bill_total_minor, active_pending_bill_total_minor)

available_minor = max(
  0,
  effective_bill_total_minor
  - completed_payment_minor
  + refunded_minor
  - active_reserved_minor
  - ambiguous_pending_minor
)
```

The current migration projects completed/refunded totals from the canonical bill projection and also keeps completed immutable reservation/payment evidence. Phase 2 database certification must compare both and fail any drift before production approval.

## 5. Reservation state machine

```text
reserved
  -> completed
  -> ambiguous_pending_reconciliation
  -> failed_released
  -> expired_released
  -> cancelled_released

ambiguous_pending_reconciliation
  -> completed
  -> failed_released (authoritative proof only)
  -> expired_released (authoritative proof only)
  -> cancelled_released (authoritative proof only)
```

Released and completed states are terminal for ordinary requests. The proven existing late-authoritative-success rule may reacquire released capacity only if capacity is still available; otherwise it fails closed with a capacity conflict for reconciliation rather than overcommitting the bill.

## 6. Policy results

- One active digital payment session per bill: already defined and preserved.
- Partial POS and digital amounts: already supported.
- Multiple distinct POS partial payments: supported within shared capacity.
- Cash/terminal plus digital: retained as mixed partial behavior only against distinct available capacity.
- Session TTL: persisted configured TTL, default 900 seconds.
- Failed/expired/cancelled sessions: release only from authoritative evidence, never browser navigation alone.
- Digital authority: verified signed completion event.
- Traditional authority: authenticated POS report of a completed fact.
- Refund initiation/void/reversal: still requires product approval; not implemented.

Full evidence: `docs/decisions/PHASE1_FINANCIAL_POLICY_DECISIONS.md`.

## 7. New call ordering

### External POS payment

Authenticate and authorize -> reserve API idempotency -> validate completed fact -> lock bill and reserve capacity -> commit reservation -> call downstream with stable derived key -> on success atomically commit reservation/payment/bill -> audit -> persist API response.

If the downstream result is uncertain, the reservation becomes `ambiguous_pending_reconciliation`, the response is `503 payment_outcome_ambiguous`, and only an identical same-key retry is safe.

### Digital session

Authenticate and authorize -> validate bill/request -> derive stable public identity -> lock bill and reserve capacity -> create/reuse durable Restec session -> call downstream with stable derived key -> attach checkout identity -> return 201. The active reservation remains through `creating`, `requires_customer_action`, and `processing`.

### Authoritative completion

Verify signature/service/environment and all mapped facts -> lock session, bill, and reservation -> deduplicate inbox -> convert reservation to completed or authoritative released state -> update session and bill -> insert POS outbox -> commit -> return accepted/duplicate.

### Bill update

Authenticate/authorize -> validate table/body -> lock bill -> reserve revision/effective total after financial-floor check -> call downstream -> commit only the matching revision. An uncertain result retains the lower effective ceiling until same-key recovery/reconciliation.

## 8. Idempotency and crash behavior

- Same key/path/exact bytes returns the original result.
- Conflicting key reuse returns 409 without a reservation or downstream call.
- Financial identity reuse with different bill/amount/currency/channel/hash returns deterministic conflict.
- Crash after reservation leaves durable protected capacity; retry reuses it.
- Downstream request loss uses the stable derived downstream key and retains ambiguity.
- Lost API response after commit replays the stored response and completed reservation.
- No code path releases capacity merely for timeout, network failure, or unusable downstream response.

## 9. Concurrency and stress results

`apps/api/src/financial-concurrency.test.ts` uses `Promise.allSettled`, concurrent HTTP requests, and deterministic randomized sequences.

| Case                                 | Result                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Two cash full-balance payments       | One reservation/one downstream call; total PKR 5,000.                                                                        |
| Cash + terminal                      | Same shared external-payment capacity rule; total never exceeds bill.                                                        |
| Cash + digital                       | One full-balance owner; the other conflicts before downstream.                                                               |
| Terminal + digital                   | One full-balance owner; the other conflicts before downstream.                                                               |
| Digital completion + POS             | Digital session capacity is already protected; POS cannot consume it. Authoritative simultaneous DB execution remains gated. |
| Two digital sessions                 | One active session, per approved policy.                                                                                     |
| Two partial POS payments             | Aggregate protected amount cannot exceed total.                                                                              |
| Bill update + payment                | Only a legal combination survives; protected amount never exceeds effective total.                                           |
| 100 full-balance conflicts           | 1 success, 99 capacity conflicts, exactly PKR 10,000 completed in the test.                                                  |
| 100 partial conflicts (PKR 200 each) | 50 successes, 50 conflicts, exactly PKR 10,000 protected.                                                                    |
| Randomized property stress           | 50 runs x 100 operations; no negative/over-capacity projection.                                                              |

No leaked or stuck reservation was found in the executable tests. The deliberately ambiguous test retains one protected reservation by design and successfully reuses it with the same identity.

## 10. Verification results

- `npm run lint`: pass.
- `npm run typecheck`: pass.
- `npm test`: 100 tests, 97 pass, 0 fail, 3 skipped.
- `npm run test:e2e:mock`: 4/4 pass.
- `npm run check:migrations`: 10 migrations pass structural checks.
- `npm run validate:openapi`: pass.
- `npm run validate:public-artifacts`: pass.
- `npm run test:examples`: pass.
- `npm run build`: pass.
- `npm run docs:typecheck`: pass.
- `npm run docs:validate`: pass.

Known baseline/non-Phase-1 gates:

- `npm run verify` and `npm run docs:verify` stop on pre-existing repository-wide Prettier drift.
- `npm audit --audit-level=high` reports four high and one moderate advisory.
- `npm run test:leakage` is blocked by a pre-existing missing `docs/postman` path; the public artifact and docs boundary validators pass.
- Two database integration tests and one real sandbox test remain explicitly skipped.

## 11. Public contract and documentation

No endpoint or successful response shape changed. Added stable problem codes:

- `payment_capacity_conflict` (409)
- `bill_financial_floor_conflict` (409)
- `payment_outcome_ambiguous` (503)

OpenAPI, modular partner payment/bill/retry/error/UAT/troubleshooting guides, the compiled implementation guide, and Postman safe conflict/capacity examples were updated. Public `amount_due` remains the economic unpaid amount; temporary reservation implementation details are not exposed.

## 12. Updated audit

- Functional completion: 60.4% (weighted 100-use-case matrix).
- Pilot readiness: 45% (risk-gated).
- Production readiness: 22% (risk-gated).
- Financial correctness: 75% locally; real DB certification missing.
- Bill/order synchronization: 68%; terminal lifecycle and DB race certification remain.
- Digital payments: 78%; provider and DB concurrency certification remain.
- Traditional payments: 84%; real POS/DB certification remains.
- Partial/mixed payments: 70%; real cross-channel database certification remains.
- Retries/idempotency: 86%; stale-processing recovery and provider proof remain.
- Reconciliation foundation: 55%; durable ambiguous evidence exists, operator resolution workflow does not.

The targeted matrix rows were updated without marking database-gated cases fully tested.

## 13. Phase 2 blockers

1. Apply the forward migration to a disposable Supabase/PostgreSQL environment and validate SQL/RPC execution.
2. Run true multi-connection database races for every C1-C9 case and 20/50/100 stress sizes.
3. Inject crashes before/after reservation, downstream send, downstream success, local commit, inbox insert, and outbox insert.
4. Prove timeout-after-provider-success converges with one real downstream financial effect.
5. Compare immutable completed reservations/payments with canonical bill projections and define drift quarantine.
6. Certify late authoritative success after a released session both with and without remaining capacity.
7. Add stale API-idempotency recovery and an operator-approved ambiguous-resolution procedure.
8. Resolve baseline formatting, public-leakage path, and dependency-audit failures separately.
