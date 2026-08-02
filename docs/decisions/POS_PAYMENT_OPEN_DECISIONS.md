# POS payment open decisions

The current v1 contract intentionally rejects or omits behavior without an approved financial rule.

| Decision                                      | Current behavior                                                 | Approval needed                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| POS-initiated void/reversal                   | No endpoint; rejected as unsupported                             | Authority, legal states, audit/event semantics, and time window                         |
| POS-initiated refund                          | No endpoint; authoritative refund notifications are receive-only | Refund authority, partial rules, limits, and reconciliation owner                       |
| Structured modifiers and per-line allocations | No v1 fields                                                     | Canonical pricing/tax ownership and rounding rules                                      |
| Stable table/customer QR resolver             | No v1 route; only a session-specific Restec checkout URL exists  | Link ownership, current-bill selection, table moves, closed bills, and customer privacy |
| `other` external payment method               | Accepted only for an approved onboarding use                     | Approved categories and reconciliation evidence                                         |
| Production rotation grace                     | Tool supports an operator-selected 0–7 day window                | Security owner sets standard duration and emergency override                            |

No operator should emulate an unsupported operation by editing a bill or payment record.
