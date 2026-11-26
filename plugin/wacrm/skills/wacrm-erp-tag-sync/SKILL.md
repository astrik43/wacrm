---
name: wacrm-erp-tag-sync
description: Keep the customer tags Order RTO, Blocked and Partial pay the same in wacrm and in the ERP. Use for "sync tags with ERP", "reconcile RTO tags", nightly reconcile, or after changing a risk tag.
---

# ERP tag sync

Load `wacrm-safety-rules` first. wacrm has no ERP connection: you compare both sides and apply the differences to each.

1. `get_ops_settings`: the `sync_tags` list (default `Order RTO`, `Blocked`, `Partial pay`). Only these can be synced.
2. **wacrm side.** For each tag, `get_tag_state` (`tags`, `cursor`; page until done): the contacts carrying it, by contact id and order numbers, no phones.
3. **ERP side.** With the ERP's own tools (its customer search and tag tools) get the customers carrying the same tags.
4. **Match by order number** (or contact id), never by phone. Build two lists per tag: *only in wacrm* and *only in the ERP*. Customers without an order in common can't be matched: list them as "unmatched", don't guess.
5. **Decide the rule with the user** (default: a risk tag on either side means tagged):
   - only in wacrm: add it in the ERP (the ERP's add-tag tool).
   - only in the ERP: add it in wacrm with `apply_tag_changes` (`add: [{ "tag": "Order RTO", "order_numbers": ["#EL2204"] }]`).
   - Removals only when the user asks for them (`remove` has the same shape).
6. **Dry run first:** `apply_tag_changes` with `dry_run: true` returns the counts, tags it would create, and anything `unresolved`. Show it, then apply. Max 500 targets per call. Staff are skipped automatically.
7. Adding a tag in wacrm fires "tag added" automations, so say that before applying.

Report counts per tag and side, and the unmatched list (by order number).
