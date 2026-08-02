# UAT test plan

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

UAT passes only when every required case has deterministic evidence and no credentials or card data appear in captures.

A stable table/customer QR lifecycle is not part of partner v1 and must not be marked passed through this plan.
