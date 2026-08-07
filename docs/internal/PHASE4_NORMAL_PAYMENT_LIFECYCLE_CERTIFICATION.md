# Phase 4 normal-payment lifecycle certification

## 1. Baseline and existing gaps

Baseline branch/commit: `main` at `151e2994090b6e42847387b467874b4c6f365ea5`, with the existing Phase 1-3 working tree preserved. Baseline had 11 migrations, 110 unit tests (105 pass, five gated), and mock E2E 4/4. The primary gap was contradictory expiry: a browser GET could locally mark expiry while the scheduler only audited due sessions and never completed the lifecycle.

## 2. Product decisions and state machine

The evidence and decisions are in `docs/decisions/PHASE4_NORMAL_PAYMENT_POLICY_DECISIONS.md`. One active digital session remains mandatory. Traditional v1 accepts completed facts only. All approved methods use shared capacity, including three-way mixing.

The public digital machine is:

`requires_customer_action -> processing -> paid|failed|cancelled|expired`

Direct terminal transitions from `requires_customer_action` are also allowed. `paid` is monotonic for Phase 4. `failed`, `cancelled`, and `expired` may move to `paid` only through authoritative late-success processing with capacity reacquisition. `creating` remains internal; refund states remain Phase 5.

## 3. Authority and reservation behavior

| Terminal    | Authority                                                                                       | Reservation                                                                    | POS event                     |
| ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| `paid`      | Signed completion or authenticated private provider read plus verified provider bill projection | Completed; a released reservation must atomically reacquire available capacity | `payment.completed`           |
| `failed`    | Signed failure or authenticated provider state `failed`                                         | `failed_released`                                                              | `payment.failed`              |
| `cancelled` | Signed failed-family event/provider state `cancelled`                                           | `cancelled_released`                                                           | v1 failed-family notification |
| `expired`   | Signed expiry or authenticated provider state `expired`                                         | `expired_released`                                                             | `payment.expired`             |

Local time, customer/POS clocks, browser return, browser close, and cancel navigation are never financial authority. `requires_customer_action` and `processing` retain the full reservation.

## 4. Scheduler and expiry semantics

Production config invokes `/api/internal/jobs/reconcile-payment-sessions` every five minutes with the internal job bearer. Each run lists nonterminal sessions, validates mapped private identity/amount/currency/reference, and reads provider state.

- Provider active: update a permitted nonterminal state, retain capacity, and audit `expiry_pending_confirmation` if local time is due.
- Provider unavailable/invalid/mismatched: retain capacity and audit pending/review evidence.
- Provider paid: fetch/validate provider bill projection, then atomically complete session/reservation/bill/inbox/outbox.
- Provider failed/cancelled/expired: atomically terminalize with the current unchanged bill projection, release exactly once, and create one canonical event/outbox row.
- Duplicate run: terminal sessions leave the scan; duplicate technical evidence also reuses the existing logical event.

The browser is not required for expiry: **NO**. Local `expires_at` alone can release capacity: **NO**. The repository contains no provider guarantee equating Restec local time with impossibility of later charge; only authenticated provider terminal state is used.

## 5. Abandonment, return, cancellation, and failure

Checkout after the local deadline returns 410 but does not mutate financial state. The return page continues to show `confirmation_pending` until stored authoritative terminal state. The cancel page records that provider state is unchanged. Failure/cancellation/expiry release only through provider evidence. A new session is allowed after release and rejected after a fully paid bill.

## 6. Late success, races, and restart behavior

Late paid after failure/cancellation/expiry uses the existing Phase 1 reservation transaction. If capacity remains, paid commits; if another method consumed it, `payment_capacity_conflict` is recorded as a late-success review condition and the bill cannot silently overpay. Paid-first causes later failure/cancel/expiry to fail the state transition. Expiry-versus-paid, duplicate-run, different-event-ID, and memory atomicity regressions are locally tested. PostgreSQL row-lock execution remains gated.

State is repository-backed, so API restart does not make browser state authoritative or clear reservations. The scheduler uses deterministic reconciliation event/payment identities.

## 7. Traditional, partial, and mixed policy

Traditional supported methods are `cash`, `card_terminal`, `wallet_terminal`, `voucher`, and onboarding-approved `other`. Only `status=completed` is accepted. Pending, declined, cancelled, voided, reversed, and POS-originated refunded states deterministically return 422 with no reservation/private/local financial write.

Distinct completed POS facts may settle a bill incrementally. Cash + cash, cash + terminal, cash + digital, terminal + digital, and cash + digital + terminal are supported against one available-capacity projection. One active/ambiguous digital session remains the limit even when a remainder exists.

## 8. Final balance and bill status

The invariant is `amount_due = max(0, grand_total - amount_paid + amount_refunded)`. Partial settlement has positive due and `partially_paid`; full settlement has zero due and `paid`. Shared capacity and protected-floor tests prove that completed + reserved + ambiguous never exceeds the legal bill capacity and due never becomes negative. Increasing a bill follows version rules; reducing it below the protected floor fails. Financial paid state does not close the Phase 3 table visit.

## 9. POS events, duplicates, and ordering

Terminal notifications use the durable outbox and normal acknowledgement/retry pipeline. One logical session terminal state has one Restec event identity even when scheduler and provider supply different technical event IDs. Delivery retries retain that identity. Paid never regresses. A genuine late paid correction after a released failure/cancel/expiry is a new logical terminal fact and may produce a completion event only after capacity reacquisition.

## 10. Customer state and table interaction

Authenticated session GET returns stored authoritative state without private identifiers. Browser pages use no-store/no-referrer controls. Partial payment updates the customer bill amount due. Financial paid does not automatically close or reassign a table; all Phase 3 generation and cross-guest protections remain intact.

## 11. API, Postman, docs, and observability

OpenAPI now states that `expires_at` is a customer-action deadline, not standalone release proof, and documents the one-active/mixed-capacity rule. Postman includes full cash, partial cash, terminal/mixed, same-key, over-capacity, active-capacity, hosted-session, and unsupported-pending examples. The docs portal includes `PARTIAL_AND_MIXED_PAYMENTS.md`. Partner payment, error, webhook, UAT, and navigation artifacts match runtime.

Structured audit/log events cover provider terminal commit, expiry pending confirmation, reconciliation failure, late-success capacity conflict, and canonical POS event/outbox creation. No card data or hosted capability URL is logged.

## 12. Migrations and database status

Migration `20260807000300_normal_payment_lifecycle.sql` is forward-only and preserves history. It adds logical terminal-event deduplication inside the existing locked session/reservation/bill RPC. Structural checks pass across 12 migrations.

The configured environment lacks the required disposable-database certification/reset guards, so `npm run test:database:certify` was not authorized to reset it. Status: **DATABASE_EXECUTION_GATED**. Phase 2 remains `RESTEC_PHASE2_DATABASE_PARTIAL`.

## 13. Provider and deployed scheduler status

Provider credentials exist locally, but no retained safe end-to-end sandbox run proves create/failure/cancel/expiry/late-success semantics for this Phase 4 build. Status: **PROVIDER_SANDBOX_CERTIFICATION_GATED**.

The API Vercel configuration contains the five-minute reconciliation cron and one-minute POS dispatcher with job authentication and bounded batches. No retained deployed invocation proves this build ran on schedule. Status: **DEPLOYED_SCHEDULER_CERTIFICATION_GATED**.

## 14. Tests and gated tests

Final local results:

- `npm run typecheck`: pass.
- `npm test`: 121 total, 116 passed, five skipped/gated, zero failed.
- `npm run test:e2e:mock`: 4/4 pass.
- Targeted Phase 1/3/4 payment/table suite: 54/54 pass.
- `npm run check:migrations`: 12 pass.
- OpenAPI, public artifacts, docs portal, examples: pass.
- Full workspace build: pass.
- `git diff --check`: pass (CRLF notices only).
- Lint: pass after removing the stale unused callback argument.
- `npm run verify`: remains blocked first by the pre-existing repository-wide Prettier backlog; direct leakage checking also has the pre-existing missing `docs/postman` path.

The five skipped unit tests are one remote sandbox E2E case and four real-PostgreSQL certification cases. No Phase 4 local lifecycle test is skipped.

## 15. Bugs found and fixed

1. Browser/local time could terminalize expiry; removed.
2. Scheduler skipped provider reads for locally due sessions; replaced with provider-authoritative reconciliation.
3. Scheduler observed but could not commit missing terminal events; added deterministic canonical commit/outbox behavior.
4. Different technical terminal events could emit duplicate POS facts; logical dedupe added in memory and PostgreSQL migration.
5. Memory event processing could expose partial mutation across concurrent terminal races; reordered into a synchronous local atomic section with capacity precheck.
6. Provider session GET validation accepted weak identity/status/expiry shapes; hardened.
7. Traditional unsupported states lacked an exhaustive route test; added.

## 16. Updated use-case audit and completion scoring

Relevant rows in `RESTEC_POS_USE_CASE_MATRIX.csv` and the 100-case audit addendum now reflect Phase 4. Evidence-based completion:

| Area                          | Completion |
| ----------------------------- | ---------: |
| Digital payments              |        92% |
| Traditional payments          |        94% |
| Partial/mixed payments        |        92% |
| Retries/idempotency           |        92% |
| Bill/order synchronization    |        90% |
| Payment-session lifecycle     |        91% |
| POS event synchronization     |        90% |
| Overall functional completion |        82% |
| Pilot readiness               |        58% |
| Production readiness          |        34% |

Application scores are high because every ordinary local lifecycle path is deterministic and tested. Readiness is deliberately lower because PostgreSQL, provider, deployed scheduler, real POS, monitoring, restore, and operational evidence remain absent.

## 17. Phase 5 blockers

Phase 5 must define and implement refund initiation authority, partial/full refund limits, void timing, reversal and correction semantics, chargeback/dispute states, over-refund prevention, post-refund bill math, correction event ordering, POS retry/idempotency identities, provider reconciliation, and customer/POS projections. It must preserve the Phase 1 capacity ledger and Phase 4 paid monotonicity rather than editing completed history.

## 18. Final verdict

All Phase 4 application/domain normal-payment behavior and local scheduler behavior pass, while real database/provider/deployed-scheduler certification remains gated.

**RESTEC_PHASE4_NORMAL_PAYMENTS_APPLICATION_COMPLETE_DB_GATED**
