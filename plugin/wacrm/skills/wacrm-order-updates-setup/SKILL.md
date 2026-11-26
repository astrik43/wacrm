---
name: wacrm-order-updates-setup
description: Set up or change the WhatsApp order updates sent from Shopify (order confirmed, shipped, out for delivery, delivered, carts). Use for "set up Shopify messages", "change the order update template", "test the shipping message", "turn on delivery updates".
---

# Order updates setup

Load `wacrm-safety-rules` first. These messages go to real customers, so change them in test mode.

1. `get_shopify_status`. If it isn't connected, stop: connecting is done in the dashboard.
2. **Test mode on.** `set_shopify_test_mode` with `enabled: true` and the owner's `test_numbers` (ask for them). While it's on, customers receive nothing.
3. `list_order_update_events`, then `get_order_update_event` (`event`, `variant`, `step`) for each event being changed.
4. For each event: `list_templates` (`status: "APPROVED"`), choose a template, map its variables (`variable_mapping`), set `delay_minutes`, and `update_order_update_event` with `dry_run: true`. Show the from/to diff, then apply it.
5. **Test each one.** `send_order_update_test` (`event`, `variant`, `step`, `phone` = the test number, `source: "latest"` for real order values). Ask the owner to confirm each message arrived and looks right.
6. Check the log: `list_notification_log` (`include_tests: true`) for `sent` / `skipped` / `failed` and why.
7. **Go live only when the owner asks.** Then `set_shopify_test_mode` with `enabled: false`, and enable the events with `update_order_update_event` (`is_enabled: true`).

Past orders can be tagged `Order Delivered` / `Order RTO` with `tag_delivered_customers` (one page per call; repeat with the returned `next_cursor` until it ends).
