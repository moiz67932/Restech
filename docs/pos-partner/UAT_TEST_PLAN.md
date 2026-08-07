# UAT test plan

## Table QR lifecycle

- Open, update, move, complete, and cancel a mapped-table bill.
- Reuse a table after close; refresh the old customer visit and confirm it cannot show the new bill.
- Confirm simultaneous open conflicts, stale bill rejection, no-bill scans, multiple scans, disabled table, and QR rotation.

Retain only public IDs, request IDs, event IDs, timestamps, statuses, and sanitized response evidence.

| #   | Test                                                | Expected result                                       |
| --- | --------------------------------------------------- | ----------------------------------------------------- |
| 1   | Upsert an open bill at version 1                    | 200; authenticated bill GET reflects the bill         |
| 2   | Update items and totals at a higher version         | 200; GET matches the new revision                     |
| 3   | Replay identical bill request                       | Original response; one bill result                    |
| 4   | Reuse version or idempotency key with changed bytes | 409; no state change                                  |
| 5   | Create and complete customer payment                | One paid state and one signed POS event               |
| 6   | Deliver the same event twice                        | Second delivery returns 2xx; one POS update           |
| 7   | Report completed cash payment                       | Bill/customer state becomes paid or correctly partial |
| 8   | Report completed physical-terminal payment          | Bill/customer state becomes paid or correctly partial |
| 9   | Repeat identical external payment                   | Original result; no second financial action           |
| 10  | Reuse payment ID/key with changed amount            | 409; no second financial action                       |
| 11  | Use wrong-location credential                       | 403 or non-revealing 404                              |
| 12  | Use expired credential                              | 401                                                   |
| 13  | Rotate credential                                   | New version works; old version fails after grace      |
| 14  | Return 503 or time out a webhook                    | Restec retries with the same event ID                 |
| 15  | Return permanent 4xx                                | Event enters Restec manual review                     |
| 16  | Attempt sandbox/production crossover                | Rejected; no state crosses environments               |
| 17  | Run concurrent deliveries                           | POS unique event constraint prevents duplicates       |
| 18  | Compare final bill and POS states                   | Amount, currency, status, and balance agree           |
| 19  | Submit two full-balance cash payments concurrently  | One succeeds; only one reaches financial completion   |
| 20  | Submit full-balance cash and digital concurrently   | Only the first protected channel owns the capacity    |
| 21  | Reduce a bill below an active protected amount      | `bill_financial_floor_conflict`; no downstream update |
| 22  | Simulate an ambiguous downstream payment outcome    | Capacity stays protected; same-key retry reconciles   |
| 23  | Close the browser and never return                  | Scheduler/provider evidence completes safely          |
| 24  | Let local expiry pass while provider remains active | Capacity stays protected; no false expiry event       |
| 25  | Provider confirms expiry                            | One expiry state/event; capacity is released          |
| 26  | Run expiry scheduler twice                          | Second run makes no release or event                  |
| 27  | Race provider paid with expiry                      | Paid wins or conflict is review-required; no overpay  |
| 28  | Deliver failure then late paid                      | Capacity-checked late paid; paid never regresses      |
| 29  | Deliver cancellation then late paid                 | Capacity-checked late paid; paid never regresses      |
| 30  | Cash plus cash partials                             | Exact final zero due; one fact per identity           |
| 31  | Cash plus terminal                                  | Shared balance settles without overpayment            |
| 32  | Cash plus hosted digital                            | Digital reserve protects only its amount              |
| 33  | Terminal plus hosted digital                        | Both fit shared capacity                              |
| 34  | Cash plus digital plus terminal                     | Three-way total settles exactly                       |
| 35  | Submit pending/declined/cancelled POS status        | 422; no private or local financial write              |

UAT passes only when every required case has deterministic evidence and no credentials or card data appear in captures.

A stable table/customer QR lifecycle is not part of partner v1 and must not be marked passed through this plan.
