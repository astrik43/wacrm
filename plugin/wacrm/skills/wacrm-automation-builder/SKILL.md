---
name: wacrm-automation-builder
description: Turn "when X happens, do Y" into a wacrm automation. Use for "create an automation", "when a customer gets tagged ... send ...", "automatically tag/move/assign when ...", "set up a follow-up".
---

# Automation builder

Load `wacrm-safety-rules` first. An enabled automation can message customers on its own.

1. Restate the request as **trigger**, **conditions** and **steps** and confirm it with the user.
2. Don't guess the JSON. `list_automations`, then `get_automation` on a similar existing one and copy its shape. The ids you need come from `list_tags`, `list_pipelines`, `list_templates` (`status: "APPROVED"`) and `list_team_members`; wacrm refuses ids that aren't in the account.
3. `create_automation` with `dry_run: true`, `enabled: false`. Fix whatever field-level error comes back. Iterate until it validates, then show the user the normalised definition.
4. Create it **disabled** (`enabled: false`) for real.
5. Enabling is a separate step: only after the user says so, `set_automation_enabled` (`enabled: true`). Warn if a step sends a message and who it would reach (marketing steps go to staff too: automations don't exclude them).
6. After its first real run, `get_automation_logs` (`automation_id`) and report what happened; `list_pending_automation_executions` shows delayed steps still waiting, and `cancel_pending_execution` stops one.
7. Changes: `update_automation` (dry run first). Removal: `delete_automation` needs `confirm: true`.
