# Phase 7 reconciliation authority matrix

| Dimension               | Authority                                                         | Repair rule                                                                         |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Bill/order content      | POS-originated canonical bill version                             | Compare and record drift; never copy provider state into immutable Restec facts.    |
| Payment completion      | Authenticated provider terminal fact or accepted POS payment fact | Commit only through the existing inbox/reservation path.                            |
| Failure/cancel/expiry   | Provider lifecycle authority                                      | Commit the same terminal event path; local deadline alone is not terminal evidence. |
| Refund/correction       | Authenticated provider correction fact                            | Use the immutable correction ledger; never patch a projection as a fact.            |
| Restec ledger           | Immutable accepted Restec facts                                   | Projections may be rebuilt from these facts only.                                   |
| Receivable/settlement   | Derived bill and payment/correction rules                         | Amount/currency disagreement is manual review.                                      |
| Current table/bill      | Restec table lifecycle from accepted POS state                    | Do not reopen a table from a refund or uncertain payment.                           |
| POS delivery            | Restec outbox and delivery attempts                               | Requeue the same event identity.                                                    |
| Credentials/connections | Restec lifecycle records                                          | Offboarding is staged and location/environment scoped.                              |

Evidence snapshots exclude secrets, cardholder data, and unnecessary customer PII.
