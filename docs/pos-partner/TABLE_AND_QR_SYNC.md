# Table and QR synchronization

A printed Restec QR identifies one physical table, not a bill, order, payment session, or database identifier. The opaque URL is provisioned by an authenticated Restec operator and remains stable until rotated.

## POS responsibilities

Continue to upsert bills with the mapped `external_table_id` and increasing bill version. Restec automatically creates the current table generation when an open bill is accepted, preserves it on ordinary updates, moves it when the bill table changes, and ends it when the bill is completed or cancelled.

Exactly one open bill may own a mapped physical table. A competing bill receives `table_active_bill_conflict`. A bill that has ended cannot be reopened to reclaim a table: it receives `bill_table_generation_conflict`. Table merge and table split are not supported in v1.

## Customer privacy

Scanning the permanent QR resolves the table's current active generation and creates a separate, opaque customer visit URL. Multiple diners may scan during the same generation. That visit is permanently pinned to that generation; it never re-resolves the physical table. Therefore, after a bill closes and a new guest uses the table, an old browser page reports that the prior visit has ended and cannot display the new bill.

Customer pages use `Cache-Control: private, no-store` and expose only table display name and a limited customer bill projection. They never expose internal references, external bill IDs, payment-provider IDs, or partner credentials.

## Operations

QR provisioning and rotation are operator-only actions. Rotation replaces the stored token hash, immediately invalidating the previous QR. Disabling a table makes both new QR resolutions and customer displays fail closed as table unavailable. A valid QR with no POS bill displays a safe “no active order” state.

Do not create a new QR for each bill, embed a bill/payment identifier in a QR, manually edit bill rows, or reuse an old customer-visit URL for a new guest.
