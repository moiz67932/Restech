# Bill and order synchronization

One `external_bill_id` is permanently associated with one credential-authorized Restec location. The body `external_table_id` must match an active table mapping at that location.

Lifecycle:

1. Bill opened: use a new external bill ID and body `version: 1`, with `status: open`.
2. Bill updated: send the full current bill snapshot using a higher version. Repeating the same version and bytes is a replay; changing bytes at the same version is a conflict.
3. Table moved: send a higher version with the new active `external_table_id`. Restec preserves the bill identity.
4. Bill cancelled: send a higher version with bill and order status `cancelled`. A payment already committed cannot be undone by this update.
5. Bill closed: send a higher version with bill and order status `completed`. Never reuse the external bill ID for a later guest.
6. New bill on the same table: create a different external bill ID at version 1 after the earlier bill is terminal.

A higher-version bill total cannot be lower than the sum of completed payments and amounts currently protected for in-progress or ambiguous outcomes. Restec returns `bill_financial_floor_conflict` before synchronizing an invalid reduction. A bill revision being reconciled also prevents another revision or payment from consuming capacity that the pending total would remove.

The current v1 partner API validates the table mapping during every bill upsert, but it does not expose a stable table/customer-link resolver. A customer payment session produces an opaque Restec-hosted `checkout_url` for that specific bill and session. The POS must use only that returned URL and must never construct a customer URL from identifiers. Stable table-QR reassignment across bill open, move, close, and reuse remains an explicit product decision and is not certified in v1.

Line-item notes and bill-level discount, tax, service charge, and tip totals are supported. Structured modifier arrays and per-line tax/discount allocations are not part of v1; represent non-financial detail in a short item note only when your UAT policy approves it.

Do not reduce a bill below its already-paid less refunded amount. A stale version, inconsistent total, unmapped table, or illegal terminal transition is rejected.
