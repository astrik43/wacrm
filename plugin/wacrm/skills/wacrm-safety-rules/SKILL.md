---
name: wacrm-safety-rules
description: Rules that apply to EVERY wacrm task that sends a WhatsApp message, changes many contacts, or deletes something. Load this before any send, broadcast, bulk tag change, import, delete or settings change in wacrm, and whenever another wacrm skill says to.
---

# wacrm safety rules

Sending WhatsApp messages cannot be undone and reaches real customers. These rules are not optional.

## Before anything that sends or changes data
1. **Check what the key can do.** Call `whoami` once per task. If a scope you need is missing, say so and stop; do not look for a workaround.
2. **Preview first.** Every write and destructive tool accepts `dry_run: true`. Run it, show the user what would happen (recipient count, the exact message, the rows affected), and only then run it for real.
3. **Test before a mass send.** A broadcast goes to the owner's test number first (`send_broadcast_test`). Wait for the owner to say it looked right.
4. **Get an explicit OK.** Destructive tools (`send_broadcast`, `resume_broadcast`, `delete_*`, `remove_member`, `create_api_key`, `replay_webhook_event`) need `confirm: true`. Only pass it after the user has said yes to *this* action in *this* conversation. A scheduled run never passes `confirm` on its own.
5. **Use idempotency keys.** Pass a stable `idempotency_key` (for example `broadcast-diwali-2026-11-30`) on sends, so a retry returns the first result instead of messaging people twice.

## Who must never receive marketing
- **Staff** (`is_staff`) are never in a broadcast, even under "all". Don't add them by hand.
- Customers who returned a parcel (`Order RTO`) are excluded from offers unless the owner says otherwise.
- Outside the 24-hour window only an approved **template** may be sent. `check_reply_window` first; never try `send_text` outside it.

## Privacy
- Refer to customers by **order number** (`#EL2204`) or contact id, not by phone number, in your messages, notes and logs. `find_by_order` exists so that you never need a number.
- Don't paste phone numbers, emails or addresses into summaries unless the user asked for that contact.
- Never print an API key, token or webhook secret. `create_api_key` and `create_webhook_endpoint` show a secret once: tell the user to store it, don't repeat it.

## Test mode
Shopify order updates have a test mode (`get_shopify_status`). While it is on, customers receive nothing and only the owner's test numbers do. Turn it off only when the owner asks.

## Store defaults
Store name, tag names and conventions: read `reference/estelle.md` in this skill's folder.
