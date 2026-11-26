---
name: wacrm-cod-confirmation
description: Pick up customers' answers to the COD order-confirmation message and update the order. Use for "check COD confirmations", "who confirmed their COD order", "who didn't reply to COD confirm", or as a scheduled run.
---

# COD confirmation

Load `wacrm-safety-rules` first. wacrm records the customer's answer; you apply it to the ERP, which wacrm doesn't talk to.

1. `list_events_since` with `types: ["cod_confirmation", "button_reply"]` and your saved `cursor` (keep the returned `next_cursor` in the scheduled task's notes). Look at the first events to see their exact fields: they carry the order number and the customer's answer excerpt, never a phone number.
2. Per order number:
   - **Confirmed**: add a comment on the ERP order (`comment_on_order`): `COD confirmed by customer`. Don't ship-hold the order.
   - **Cancelled / declined**: comment `COD cancelled by customer` and flag the order to the user to cancel; never cancel it yourself.
   - **Unclear**: show the excerpt to the user.
3. Orders with **no answer**: `list_notification_log` (`event` for the COD confirmation, `status: "sent"`) shows who was asked. For those older than the user's cut-off (ask; for example 24 hours), list the order numbers for a phone call.
4. Customers who keep refusing or not collecting are RTO candidates: see `wacrm-rto-review`.

Report: confirmed N, cancelled N, unclear N, no answer N, with order numbers.
