---
name: wacrm-abandoned-cart-recovery
description: Follow up customers who left items in their cart. Use for "follow up abandoned carts", "recover carts", "cart reminders". Works from the Abandoned Cart tag and the automatic reminder updates.
---

# Abandoned-cart recovery

Load `wacrm-safety-rules` first.

wacrm already sends cart reminders through Shopify order updates when they're switched on, and tags the customer `Abandoned Cart` (removed when they order). This skill reviews and tops up that process.

1. `get_shopify_status`: is the connection live, and is **test mode** on? If test mode is on, no customer gets anything. Tell the user.
2. `list_order_update_events` and `get_order_update_event` for the cart reminder event: which template, what delay, is it enabled, what follow-ups?
3. Who is waiting: `list_tags` for the `Abandoned Cart` id, then `estimate_audience` with `{ "type": "tags", "tag_ids": [<id>], "exclude_tag_ids": [<Order RTO id>] }`.
4. Check what was already sent: `list_notification_log` (`event` for the cart reminder, `status`) so nobody gets it twice.
5. Options for the user:
   - **Rely on the automatic reminder**: adjust it with `update_order_update_event` (`delay_minutes`, `template_name`, `is_enabled`). Use `dry_run: true` to show the diff first.
   - **One-off nudge** to the current tag group: follow `wacrm-broadcast-campaign` (test first). Leave out anyone nudged in the last few days (`list_notification_log`).
6. Offer a coupon only from the approved template's own code.

Report: how many carts are waiting, how many already got a reminder, what was sent now.
