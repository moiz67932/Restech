# Phase 3 table QR policy decisions

| Decision                           | Status                              | Runtime policy                                                                                         |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Active bills per table             | ALREADY_DEFINED for v1              | One active bill generation per mapped table; conflicts are rejected.                                   |
| Table move                         | IMPLIED_BUT_AMBIGUOUS               | An open bill moves its active generation to the new table; existing visits remain bill-pinned.         |
| Session start/end                  | ALREADY_DEFINED                     | An accepted open bill starts; completed/cancelled bill ends. Payment completion alone does not end it. |
| No bill                            | ALREADY_DEFINED                     | Safe no-active-order customer state.                                                                   |
| Rotation/disable                   | ALREADY_DEFINED                     | Rotation revokes the old token; disable fails closed.                                                  |
| Merge/split                        | UNDEFINED_REQUIRES_PRODUCT_DECISION | Explicitly unsupported in v1; no financial merge/split behavior was invented.                          |
| Closed unpaid/reopen/retention TTL | UNDEFINED_REQUIRES_PRODUCT_DECISION | No reopening is permitted by lifecycle code; terminal visit retention needs product policy.            |

The implementation is deliberately limited to policy-independent privacy infrastructure. PostgreSQL enforcement is supplied by migration but remains execution-gated.
