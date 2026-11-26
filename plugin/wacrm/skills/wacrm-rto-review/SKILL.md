---
name: wacrm-rto-review
description: Review customers whose parcels came back (RTO) and decide what to do about COD risk. Use for "RTO customers", "COD risk", "who keeps returning orders", "should I block COD for this customer".
---

# RTO review

Load `wacrm-safety-rules` first.

1. `list_tags` for the ids of `Order RTO`, `Order Delivered`, `Blocked`, `Partial pay`.
2. Who is affected: `search_contacts` with `tag_id` = `Order RTO` (page with `cursor`). For each, `list_contact_orders` to count orders, COD vs prepaid, delivered vs returned.
3. Score in plain words:
   - **High risk**: two or more RTOs, or an RTO and no delivered order.
   - **Watch**: one RTO, also delivered orders.
   - **Fine**: one old RTO, several delivered since.
4. Recent attempts: `list_ndr_requests` (`unresolved_only: true`) shows RTOs still open with the customer's NDR answer.
5. Recommend per group, for the user to decide:
   - High risk: tag `Blocked` (stop COD) or `Partial pay` (ask for part-payment up front). Apply with `apply_tag_changes` (`dry_run: true` first), then follow `wacrm-erp-tag-sync` so the ERP matches.
   - Watch: no action, or a polite prepaid-preferred message via `send_template`.
6. Report counts per group, with order numbers rather than phone numbers.

Never message RTO customers with offers. Every broadcast should exclude `Order RTO`.
