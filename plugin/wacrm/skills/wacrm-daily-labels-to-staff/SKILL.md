---
name: wacrm-daily-labels-to-staff
description: Send the day's shipping labels and manifest PDF to the team member who prints them, over WhatsApp. Use for "send today's labels to Priyanshu", "send the manifest to the team", after shipments are booked.
---

# Daily labels to staff

Load `wacrm-safety-rules` first. Documents go **only to staff contacts**, never to customers.

1. The shipments must already be booked and the labels and manifest produced (for Estelle, the `estelle-ops-create-shipmaxx-shipments` skill does that).
2. `send_document_to_staff` needs a **public https link to the PDF** (`application/pdf`, up to 10 MB, with a Content-Length). There is no file upload. If the PDF only exists on this computer, say so and ask the user where it can be hosted; don't try another route.
3. Find the recipient: `list_staff_contacts` (names and ids, no phones). If the person isn't listed, ask the user, and flag them with `set_contact_staff` (`is_staff: true`) only on the user's say-so.
4. Dry run: `send_document_to_staff` with `contact_id`, `url`, `filename` (for example `labels-2026-11-30.pdf`), `caption` (for example `Labels and manifest, 30 Nov: 42 orders`), `dry_run: true`. Show the user the result.
5. Send for real with `idempotency_key: "labels-<date>-<file>"`. Send the manifest and the labels as separate documents if they are separate files.
6. If it says `outside_24h_window`, the team member hasn't messaged recently and no staff template is configured. `get_ops_settings` shows the staff template; if none, tell the user the next step (configure one with `update_ops_settings`), or ask the team member to message the business number first.

Report the file names sent and to whom (by name).
