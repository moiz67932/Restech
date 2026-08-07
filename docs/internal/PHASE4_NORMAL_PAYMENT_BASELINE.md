# Phase 4 normal-payment baseline

Captured 2026-08-07 before Phase 4 runtime changes.

## Source baseline

- Branch: `main`
- Commit: `151e2994090b6e42847387b467874b4c6f365ea5`
- Worktree: already contained the uncommitted Phase 1, Phase 2, and Phase 3 changes listed by `git status`; Phase 4 must preserve them.
- Migration count: 11.
- `git diff --check`: passed, with only Git CRLF conversion warnings.

## Existing payment behavior

- Digital states: internal `creating`, then public `requires_customer_action`, `processing`, `paid`, `failed`, `expired`, `cancelled`; refund states also exist but belong to Phase 5.
- One active digital reservation per bill is enforced in both the memory financial boundary and the PostgreSQL partial unique index/RPC.
- Digital session creation reserves shared bill capacity before calling the private payment service.
- Signed private `payment.completed`, `payment.failed`, and `payment.expired` events atomically update the session, reservation, bill projection, inbox, and POS outbox.
- A provider cancellation is represented by `payment.failed` with payment-session status `cancelled`.
- Traditional methods are `cash`, `card_terminal`, `wallet_terminal`, `voucher`, and approved `other`; v1 accepts only `status=completed`.
- Multiple traditional partial payments and traditional/digital mixing share the Phase 1 capacity projection.
- `amount_due` is projected as `max(0, grand_total - amount_paid + amount_refunded)`.
- The customer return route polls the stored session; the cancel return records abandonment without changing financial state.
- The checkout route incorrectly changed an active session to `expired` from local time/browser access. The reconciliation scheduler only logged locally due sessions for review and did not query the provider or terminalize them.
- Vercel configuration schedules POS dispatch every minute and payment-session reconciliation every five minutes.

## Baseline commands

| Command                      | Result                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`          | PASS                                                                     |
| `npm test`                   | PASS: 110 total, 105 passed, 5 skipped                                   |
| `npm run test:e2e:mock`      | PASS: 4/4                                                                |
| `npm run check:migrations`   | PASS: 11 migrations                                                      |
| financial concurrency target | PASS: 13/13                                                              |
| payment-session targets      | PASS: 22/22                                                              |
| POS partner target           | PASS: 4/4                                                                |
| table/QR lifecycle target    | PASS: 6/6                                                                |
| `npm run verify`             | PRE-EXISTING REPOSITORY FORMAT GATE: stopped at `format:check`, 83 files |

The five skipped unit tests are the explicitly gated sandbox E2E case and four real-PostgreSQL certification cases. No disposable PostgreSQL environment or verified provider sandbox result was available at baseline.
