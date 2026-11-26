---
name: wacrm-broadcast-campaign
description: Plan, test and send a WhatsApp broadcast or offer to customers. Use for "send a broadcast", "send the offer to our customers", "message everyone who ordered", "announce the sale". Always tests first and waits for approval.
---

# Broadcast campaign

Load `wacrm-safety-rules` first; the Estelle defaults are in its `reference/estelle.md`.

1. **Template.** `list_templates` (`status: "APPROVED"`). Pick one with the user; `get_template` to see its variables and buttons. Only APPROVED templates can be sent.
2. **Audience.** Real customers = tag `Order Delivered`, excluding `Order RTO`. `list_tags` to get the ids, then build the audience:
   `{ "type": "tags", "tag_ids": ["<Order Delivered id>"], "exclude_tag_ids": ["<Order RTO id>"] }`.
   Add other exclusions the user wants (for example `Blocked`). Staff are excluded automatically.
3. **Estimate.** `estimate_audience` (`audience`, `template_name`): count, sample names, estimated cost. Show the user.
4. **Fill the template.**
   - `variables`: `{"1": {"type": "field", "value": "name"}}` (`type` is `static`, `field` or `custom_field`).
   - `button_variables`: keyed by button index, e.g. `{"0": {"type":"static","value":"family-offer"}, "1": {"type":"static","value":"ESTELLE100"}}` for a URL button with a `{{1}}` link and a COPY_CODE button.
   - `header_media_url` for an image/video/document header (a public https link).
   - Check with `preview_template` (`body_params`, `button_params`) that the text looks right.
5. **Dry run.** `send_broadcast` with `dry_run: true`: recipient count, the first recipient's exact payload, cost. Show it.
6. **Test.** `send_broadcast_test` to the owner's number (ask for it). Wait for "looks good".
7. **Send.** Only after an explicit yes: `send_broadcast` with `confirm: true` and an `idempotency_key`.
8. **Follow up.** `get_broadcast` shortly after, and the next day `get_broadcast_performance`. If it stalled or some failed, `get_broadcast_recipients` (`status: "failed"`), then `resume_broadcast` (`scope: "failed"`, needs `confirm`).

Max 1,000 recipients per call. Don't schedule: scheduling isn't supported.
