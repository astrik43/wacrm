---
name: wacrm-template-builder
description: Create a WhatsApp message template and get it approved by Meta. Use for "create a template for...", "make a new message template", "why was my template rejected", "sync templates".
---

# Template builder

Load `wacrm-safety-rules` first.

1. `list_templates` first, to avoid duplicating one that exists, and to copy the house style from an approved one (`get_template`).
2. Draft the template and check Meta's rules before submitting:
   - Name: lowercase letters, digits and underscores.
   - Category: `Marketing` for offers, `Utility` for order updates, `Authentication` for codes. Marketing costs more; don't call an offer "Utility".
   - Variables are `{{1}}`, `{{2}}`, numbered in order. A variable can't be the first or last thing in the body, and each needs a sample value in `sample_values`.
   - Header (optional): text (one variable at most) or image / video / document with `header_media_url`.
   - Buttons (up to 10): URL (a `{{1}}` at the end makes it dynamic), phone, quick reply, copy code (`example` is the code).
   - No promotional text in a Utility template; no repeated sentences; no content Meta bans.
3. Show the draft to the user. `submit_template` with `dry_run: true` to validate without sending to Meta.
4. After approval, `submit_template` for real.
5. Approval takes minutes to hours. Poll with `sync_templates`, then `get_template` (`status`: `PENDING`, `APPROVED`, `REJECTED`).
6. If rejected, read `rejection_reason`, explain it in plain words, and propose a fixed version. Resubmitting under the same name may be blocked for a while: suggest a new name.
7. `delete_template` only after the user confirms (`confirm: true`).
