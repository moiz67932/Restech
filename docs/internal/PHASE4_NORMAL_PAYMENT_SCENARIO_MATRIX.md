# Phase 4 normal-payment scenario matrix

Statuses are `LOCAL_PASS`, `DATABASE_EXECUTION_GATED`, or `PROVIDER_SANDBOX_CERTIFICATION_GATED`. Phase 5-only refund/reversal behavior is excluded.

## Digital

| ID     | Scenario                        | Result / evidence                                                            |
| ------ | ------------------------------- | ---------------------------------------------------------------------------- |
| DIG-01 | Full digital payment            | LOCAL_PASS: signed completion path and mock POS E2E                          |
| DIG-02 | Partial digital payment         | LOCAL_PASS: event projection supports positive remaining due                 |
| DIG-03 | Requires customer action        | LOCAL_PASS: create contract and route tests                                  |
| DIG-04 | Processing                      | LOCAL_PASS: state transition retains reservation                             |
| DIG-05 | Paid                            | LOCAL_PASS: atomic reservation completion/bill/outbox                        |
| DIG-06 | Failed                          | LOCAL_PASS: provider-confirmed release and event                             |
| DIG-07 | Cancelled                       | LOCAL_PASS: provider-confirmed release; browser cancel is inert              |
| DIG-08 | Expired                         | LOCAL_PASS: provider-confirmed scheduler release/event                       |
| DIG-09 | Browser abandoned               | LOCAL_PASS: scheduler needs no browser                                       |
| DIG-10 | Return after expiry             | LOCAL_PASS: confirmation remains pending until authoritative state           |
| DIG-11 | Duplicate success               | LOCAL_PASS: same and different technical IDs dedupe logically                |
| DIG-12 | Failure then paid               | LOCAL_PASS: late paid capacity reacquisition                                 |
| DIG-13 | Cancel then paid                | LOCAL_PASS: late paid capacity reacquisition                                 |
| DIG-14 | Expiry then paid                | LOCAL_PASS: late paid capacity reacquisition                                 |
| DIG-15 | Expiry versus paid race         | LOCAL_PASS in memory/state model; DATABASE_EXECUTION_GATED for row-lock race |
| DIG-16 | Processing beyond local TTL     | LOCAL_PASS: reservation retained, pending confirmation audited               |
| DIG-17 | New session after failure       | LOCAL_PASS through released one-active reservation policy                    |
| DIG-18 | New session after expiry        | LOCAL_PASS: explicit scheduler test                                          |
| DIG-19 | New session after full paid     | LOCAL_PASS: payable-bill check rejects                                       |
| DIG-20 | Two active sessions             | LOCAL_PASS: one-active rule and concurrency stress                           |
| DIG-21 | Amount above balance            | LOCAL_PASS: 422 / capacity rejection                                         |
| DIG-22 | Wrong currency                  | LOCAL_PASS: PKR contract and bill match                                      |
| DIG-23 | Bill update during session      | LOCAL_PASS: protected financial floor                                        |
| DIG-24 | Bill close during session       | LOCAL_PASS: Phase 3 `payment_in_progress` guard                              |
| DIG-25 | Provider semantics/deployed job | PROVIDER_SANDBOX_CERTIFICATION_GATED and deployed-scheduler gated            |

## Traditional

| IDs         | Scenario group                              | Result / evidence                                                      |
| ----------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| TRAD-01..03 | Full, partial, and multiple cash            | LOCAL_PASS: route/idempotency/shared-capacity tests                    |
| TRAD-04..05 | Full and partial terminal                   | LOCAL_PASS: route and shared-capacity tests                            |
| TRAD-06     | Cash plus terminal                          | LOCAL_PASS: exact mixed-capacity matrix                                |
| TRAD-07     | Wallet terminal                             | LOCAL_PASS at generic contract/capacity level; real terminal UAT gated |
| TRAD-08     | Voucher                                     | LOCAL_PASS at generic contract/capacity level; partner UAT gated       |
| TRAD-09     | Approved other                              | Contract-compatible only after onboarding approval                     |
| TRAD-10..13 | Overpay, currency, retry, conflicting reuse | LOCAL_PASS                                                             |
| TRAD-14..17 | Pending, declined, cancelled, void/reversal | LOCAL_PASS: deterministic 422/no write; intentionally unsupported v1   |
| TRAD-18..19 | Cancelled or fully paid bill                | LOCAL_PASS: bill not payable/capacity guards                           |
| TRAD-20     | Traditional while digital active            | LOCAL_PASS within remainder; excess rejected                           |

## Mixed

| ID     | Scenario                                  | Result / evidence                              |
| ------ | ----------------------------------------- | ---------------------------------------------- |
| MIX-01 | Cash + digital                            | LOCAL_PASS                                     |
| MIX-02 | Terminal + digital                        | LOCAL_PASS                                     |
| MIX-03 | Cash + terminal                           | LOCAL_PASS                                     |
| MIX-04 | Cash + digital + terminal                 | LOCAL_PASS                                     |
| MIX-05 | Two POS partials + digital                | LOCAL_PASS under generic shared capacity       |
| MIX-06 | Digital failure then cash                 | LOCAL_PASS after authoritative release         |
| MIX-07 | Cash, digital failure, terminal           | LOCAL_PASS under generic sequence              |
| MIX-08 | Digital expiry then new digital           | LOCAL_PASS                                     |
| MIX-09 | Digital expiry then cash                  | LOCAL_PASS after provider-confirmed release    |
| MIX-10 | Ambiguous traditional + digital           | LOCAL_PASS: ambiguous amount remains protected |
| MIX-11 | Active digital + cash within remainder    | LOCAL_PASS                                     |
| MIX-12 | Active digital + cash exceeding remainder | LOCAL_PASS: `payment_capacity_conflict`        |

All database race cases remain `DATABASE_EXECUTION_GATED` until `npm run test:database:certify` passes against a disposable PostgreSQL/Supabase instance. Provider claims remain gated until a real safe sandbox run is retained.
