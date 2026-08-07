# Phase 1 current financial call order

This is the pre-change runtime trace at commit `151e2994090b6e42847387b467874b4c6f365ea5`. It records where capacity is actually protected, not where validation merely appears to protect it.

## Shared preliminaries

All public `/v1` mutations pass raw-body limits, public authentication, signature/replay checks, environment checks, location authorization, and partner-scoped idempotency reservation. The API idempotency record serializes only reuse of the same partner key. Different legitimate keys proceed concurrently.

`MemoryRepository` maps are not a transaction model. In PostgreSQL, the first bill row lock relevant to traditional payments is inside `persist_restec_external_payment`; for bill updates it is inside `persist_restec_bill_state`. Both locks happen after the private call. `payment_sessions_one_active_bill_idx` serializes active digital sessions with one another, but not against traditional payments or bill updates.

## A. Bill creation and update

1. Validate/authenticate/authorize and reserve API idempotency.
2. Validate canonical bill and table mapping.
3. `validateBillMutation` reads current version without reserving financial capacity.
4. Call `privateClient.upsertBillDetailed` (downstream effect).
5. `saveBillState` calls `persist_restec_bill_state`, locks the bill row, checks version and only the old `amount_paid - amount_refunded` floor, then writes the projection.
6. Complete API idempotency.

Protection point: step 5. **Can two valid requests pass before it? Yes.** Two versions, or a bill update and payment, can both create downstream effects before the local winner is known. Active/ambiguous sessions are not in the floor.

## B-D. POS cash, physical terminal, wallet terminal, voucher, or approved `other`

1. Validate/authenticate/authorize and reserve API idempotency.
2. Parse the completed external-payment fact.
3. `validateExternalPayment` reads bill balance and external-payment identity.
4. Call `privateClient.recordExternalPayment` (downstream financial synchronization).
5. `saveExternalPayment` calls `persist_restec_external_payment`, locks the bill, rechecks remaining projection, inserts the payment, and updates the bill.
6. Write audit, complete API idempotency, return.

Protection point: step 5. **Can two valid requests pass before it? Yes.** Different payment IDs/keys can both observe the same amount due and both reach the downstream system. A later local 409 does not undo the first side effect.

## E. Customer digital payment-session creation

1. Validate/authenticate/authorize and reserve API idempotency.
2. Reject cardholder fields; validate request.
3. Read bill and check payable status, reconciliation, amount due, and currency.
4. Derive stable public session identity from environment, partner, location, bill, and idempotency key.
5. Insert a `creating` payment session. A unique partial index allows only one active digital session for the bill.
6. Call `privateClient.createPaymentSession` using a stable derived private idempotency key.
7. Validate hosted destination and attach private checkout identity/URL.
8. Audit and complete API idempotency.

Protection point: step 5 protects only the one-digital-session policy. **Can a valid POS payment or bill update pass concurrently? Yes.** Neither reads active payment sessions as reserved capacity.

## F. Customer digital authoritative completion event

1. Validate content type, size, timestamp, signature, service, environment, schema, event identity, connection, and location.
2. Load session; verify bill, amount, currency, method, session references, and reported status.
3. Build the canonical public event.
4. `accept_payment_session_event` inserts inbox identity, transitions the session, copies the event-provided bill projection into `bill_mappings`, and inserts the POS outbox in one transaction.
5. Return accepted/duplicate result; dispatcher later claims and delivers the durable outbox.

Protection point: the event RPC transaction at step 4, but it does not calculate shared capacity or lock an earlier financial reservation. **Can a POS payment pass the prior point? Yes.** A digital completion and POS commit can overwrite bill projections without a common capacity fact.

## G-H. Partial digital and partial POS payment

The call orders are E/F and B-D respectively. Each validates against the currently visible `amount_due`. Partial amounts are accepted, but no common sum of active digital plus POS commitments exists. **Two valid partial requests can both pass if each individually fits the old projection.**

## I. Retry of the same external payment

The same API idempotency key and body replays a completed response. The same external payment identity/request hash is also replayed by repository validation/persistence. While the first API record is `processing`, the retry receives a retryable 409. On any thrown error the API idempotency row is released, so an ambiguous downstream result can be retried; the derived downstream key is stable, but Restec has no durable ambiguous financial state.

## J. Concurrent different external payments

Different identities and keys do not conflict until both have already called downstream and race on `persist_restec_external_payment`. **Both can create downstream effects.** Only the local projection is serialized.

## K. Bill update while payment exists

Committed `amount_paid - amount_refunded` is checked only after downstream bill update. Active sessions are ignored. A reduction below already paid money loses locally after the downstream call; therefore UC-012 is not safely solved.

## L. Bill update while payment is committing

Both perform downstream calls before either bill-row lock. Whichever local RPC locks first may cause the other to fail, but both effects may already exist downstream. **Unsafe.**

## M. Customer digital and POS payment at the same moment

The digital route reserves only `payment_sessions`; the POS route reads only the bill projection. Both can proceed. Later digital event and POS persistence use different transaction functions with no common reservation. **Unsafe for UC-036/UC-043.**

## Inbox and POS delivery ordering

Authoritative event reception inserts the private inbox identity and POS outbox in one database transaction. Duplicate event identity with identical bytes is a no-op; conflicting bytes are rejected. POS delivery is claimed with `FOR UPDATE SKIP LOCKED`, leased, retried, and deduplicated. These exactly-once delivery properties are sound but currently occur after the missing shared-capacity boundary.

## Confirmed original races

| Use case | Root cause                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------- |
| UC-012   | Bill financial floor excludes active/ambiguous capacity and is enforced after downstream update.     |
| UC-036   | Digital sessions and POS payments do not consume one shared capacity aggregate.                      |
| UC-041   | Version preflight is a read; the authoritative row lock occurs after downstream bill mutation.       |
| UC-042   | Distinct POS payments both call downstream before the bill-row lock.                                 |
| UC-043   | Digital completion and POS persistence use separate commit paths without a prior common reservation. |
