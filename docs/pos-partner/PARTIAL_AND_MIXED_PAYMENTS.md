# Partial and mixed payments

One bill may be paid by multiple ordinary methods. Restec applies every completed or protected amount to one shared financial capacity; methods do not have separate balances.

Supported combinations include cash plus cash, cash plus physical terminal, cash plus hosted digital, terminal plus hosted digital, and cash plus terminal plus hosted digital. `wallet_terminal`, `voucher`, and an onboarding-approved `other` method follow the same rule. Only one hosted digital session may be active or financially ambiguous for a bill at a time.

For a bill total of 10,000 minor units, all of these are valid when submitted against still-available capacity:

- cash 2,000 then hosted digital 8,000;
- terminal 4,000 then hosted digital 6,000;
- cash 3,000 then terminal 7,000;
- cash 2,000, hosted digital 4,000, then terminal 4,000.

An active hosted session protects its full amount. A traditional payment may consume only the remainder. If a hosted session for 8,000 is active on a 10,000 bill, cash 2,000 may complete but cash 2,001 is rejected. A second hosted session is rejected even if an unprotected remainder exists.

Each partial completion increases `amount_paid`, decreases `amount_due`, and leaves `payment_status=partially_paid` while due remains positive. The final fitting completion produces `amount_due=0` and `payment_status=paid`. Restec never returns a negative due amount and rejects overpayment before an external side effect.

If digital checkout fails, is cancelled, or expires, capacity is released only after authoritative provider evidence. Local `expires_at`, browser closure, and the cancel return page do not release money. While provider outcome is uncertain, the amount remains protected and other methods may use only the unprotected remainder.

After a timeout or `payment_outcome_ambiguous`, retry identical bytes with the same idempotency key and reconcile. Do not invent a replacement payment identity.
