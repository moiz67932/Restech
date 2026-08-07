# Reconciliation operator runbook

1. Inspect the case evidence, scope, authority, amount, currency, and event IDs.
2. For provider paid/local processing, refresh provider state and allow automatic convergence only when identity, environment, location, bill, amount, and currency all match. The normal event commit path must succeed before resolving the case.
3. For failed, cancelled, or expired provider state, use the same authoritative event path. A local deadline is not enough.
4. For amount/currency/identity mismatch, ambiguous outcome, late success capacity conflict, provider-ahead refund, or Restec-paid/provider-not-paid, quarantine/manual-review. Do not reverse, release, or create a correction by assumption.
5. For a dead-lettered POS event, requeue the existing event ID. Record the action and verify delivery attempts.
6. Rebuild projections only from immutable accepted payment/correction facts. Never edit those facts.

Every resolution needs a case ID, action ID, actor, evidence reference, before/after state, and timestamp. Critical unresolved cases block final offboarding.
