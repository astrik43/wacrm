---
name: wacrm-ndr-handling
description: Handle NDR (non-delivery) customer replies: pick up answers to the "we couldn't deliver, reply 1 to reattempt, 2 for a new time" message and record them on the ERP order. Use for "handle NDRs", "check NDR replies", "what did customers say about failed deliveries", or as a scheduled run.
---

# NDR handling

Load `wacrm-safety-rules` first. wacrm sends the NDR message and records the reply; **you** write the reply onto the ERP order, because wacrm never talks to the ERP.

## One-time setup (only if the user asks)
`get_ndr_settings`. NDR sending is **off by default**. To turn it on: `list_templates` (`status: "APPROVED"`) for the NDR template, `update_ndr_settings` (`enabled`, `template_name`, `template_language`) with `dry_run: true` first. Make sure Shopify test mode is as the owner wants (`get_shopify_status`); in test mode only test numbers receive it.

## Each run
1. `list_events_since` with `types: ["ndr_reply"]` and the `cursor` you saved from the last run (store the returned `next_cursor` in the scheduled task's notes). With no cursor you get the last 24 hours.
2. For each event you get an **order number**, the answer (`reattempt`, `new_time` or `other`) and a short excerpt. No phone number.
3. Write it to the ERP with the ERP's order-comment tool (`comment_on_order`), for example: `NDR reply: customer asked for a reattempt.` or `NDR reply: customer wants a new time: "<excerpt>"`. Never put a phone number in the comment. Skip an order whose comment is already there (re-reading the same event must not duplicate it).
4. Then `resolve_ndr` (`order_number`, `note`) for `reattempt` and `new_time` once the ERP has the comment.
5. For `other` (a free-text reply): don't resolve. Show the excerpt to the user: it needs a person. The request stays open, so a later "1" or "2" still counts.

## Daily summary
`list_ndr_requests` with `unresolved_only: true` and by `state`: how many waiting for a reply, answered, expired (after 7 days). Mention the oldest waiting order numbers.
