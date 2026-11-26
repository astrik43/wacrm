# wacrm plugin for Claude

The wacrm MCP server (146 tools) plus 14 skills that encode how to use it safely.

## Install (Claude Code)
1. In wacrm: **Settings → API keys → New API key**. Grant only the scopes the skills you'll use need (below). The key is shown once.
2. Set two environment variables:
   - `WACRM_MCP_URL`: `https://<your-wacrm-host>/api/mcp`
   - `WACRM_API_KEY`: the key
3. Add this folder as a plugin. The `.mcp.json` connects to `/api/mcp` with `Authorization: Bearer ${WACRM_API_KEY}`.

Or without the plugin: `claude mcp add --transport http wacrm "$WACRM_MCP_URL" --header "Authorization: Bearer $WACRM_API_KEY"`.

claude.ai web connectors expect OAuth, which wacrm doesn't offer yet. Use Claude Code, or another client that can send a bearer header.

## Skills
| Skill | Use it for |
|---|---|
| `wacrm-safety-rules` | Loaded by the others: dry run, test first, confirm, idempotency, staff and privacy rules |
| `wacrm-inbox-triage` | Sort unread chats, draft replies |
| `wacrm-customer-360` | One-page customer summary from an order number |
| `wacrm-broadcast-campaign` | Plan, test and send a broadcast |
| `wacrm-template-builder` | Create and get templates approved |
| `wacrm-abandoned-cart-recovery` | Cart follow-ups |
| `wacrm-rto-review` | RTO / COD risk review |
| `wacrm-order-updates-setup` | Shopify order-update messages, with test mode |
| `wacrm-ndr-handling` | NDR replies onto ERP orders |
| `wacrm-daily-labels-to-staff` | Labels and manifest PDFs to a team member |
| `wacrm-cod-confirmation` | COD confirm / cancel answers |
| `wacrm-erp-tag-sync` | Keep RTO / Blocked / Partial pay tags in step with the ERP |
| `wacrm-automation-builder` | "When X, do Y" automations |
| `wacrm-weekly-report` | Weekly business report |

The ERP skills (`ndr-handling`, `cod-confirmation`, `erp-tag-sync`) also need the ERP's own MCP connected: wacrm never calls the ERP.

## Suggested key scopes
- **Read-only assistant** (triage, customer 360, reports): `account:read`, `contacts:read`, `notes:read`, `tags:read`, `conversations:read`, `templates:read`, `broadcasts:read`, `deals:read`, `automations:read`, `commerce:read`, `reports:read`, `settings:read`, `ops:read`, `events:read`.
- **Add as needed:** `messages:send` + `conversations:write` (replies), `broadcasts:send` (broadcasts), `templates:write`, `tags:write`, `ops:write`, `commerce:write`, `automations:write`.
- Don't give `team:write`, `settings:write`, `webhooks:manage` or `ai:write` to an unattended agent.

## Known limits
- Documents to staff need a public https PDF link (no file upload).
- Broadcast scheduling isn't supported.
- NDR sending is off until you enable it (`update_ndr_settings`).
