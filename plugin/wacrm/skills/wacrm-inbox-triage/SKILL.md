---
name: wacrm-inbox-triage
description: Go through the wacrm inbox and sort what needs attention. Use for "check the inbox", "what needs a reply", "any unanswered customers", "triage WhatsApp". Drafts replies, never sends without approval.
---

# Inbox triage

Load `wacrm-safety-rules` first.

1. `list_conversations_filtered` with `status: "open"`, `unread_only: true`. Also run it with `unassigned: true`. Page with `cursor` until you have them all (max 100 per page).
2. For each, `get_conversation_thread` (a few recent messages is enough) and `check_reply_window`.
3. Bucket them:
   - **Reply now**: the window is open and the customer's last message is unanswered.
   - **Template only**: the window has closed, so a free-text reply is impossible.
   - **Waiting on customer**: we replied last.
   - **Handle by a person**: complaints, refunds, anything angry or unclear.
4. Draft a short reply for each "reply now" and "template only" item. For templates, `list_templates` (`status: "APPROVED"`) and `preview_template` to show the exact text.
5. Show the user the buckets and the drafts. Do not send anything yet.
6. After approval, per conversation: `send_text` (window open) or `send_template` (window closed; pass `body_params`, and `button_params` keyed by button index if the template has a URL or coupon button). Use an `idempotency_key` such as `triage-<conversation_id>-<date>`.
7. Then `mark_conversation_read`, `set_conversation_status` (`closed` when done), and `assign_conversation` to a team member (`list_team_members` gives the `agent_id`) for the ones that need a person.

Report: counts per bucket, what was sent, what is left. Refer to customers by order number or conversation, not phone.
