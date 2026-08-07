# Phase 3 current table QR flow

Before Phase 3, location authorization yielded a connection; `external_table_id` was validated against `table_mappings`; bill state was saved by connection/bill ID; and `/s/:paymentSessionId` was a payment checkout capability. There was no concept of a current bill per physical table and no customer-facing table route.

Phase 3 adds the identity boundary: permanent table QR token → current table session/generation → newly issued customer visit token. A customer visit resolves its original session only. This closes the former stale-link risk where a raw table link could have followed table reuse.
