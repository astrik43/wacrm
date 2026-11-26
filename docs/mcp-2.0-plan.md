# wacrm MCP 2.0: feature list

## Context
The current `mcp-server/` (v0.1.1, stdio, wraps `/api/v1`) has 12 tools:
- **Read:** whoami, list/get contacts, list/get conversations, list messages, get broadcast.
- **Write:** send message, create/update contact.
- **Broadcast:** send broadcast.

Its scopes are `contacts:read|write`, `conversations:read`, `messages:read|send` and `broadcasts:send`.

Everything else the CRM does is only reachable from the dashboard, which talks to Supabase directly or through internal `/api/*` routes behind a session login. Examples are tags, notes, deals, templates, automations, flows, AI, Shopify, team, analytics and assigning or closing chats. That's why the main Claude agent can't do most tasks today.

The aim of MCP 2.0 is that the agent can do anything an admin does in the dashboard, safely:
- every feature becomes an `/api/v1` endpoint protected by API-key scopes (the reusable layer);
- the MCP server exposes those endpoints as tools.

## Architecture (recommended)
- **Remote MCP endpoint inside the app** at `/api/mcp` (Streamable HTTP), so claude.ai, Claude Code and the desktop app can connect with a URL and an API key. Keep the stdio `npx wacrm-mcp` package as a thin client of the same tools.
- **Tools call shared server functions**, the same `src/lib/*` code the dashboard and v1 routes use (for example `findOrCreateContact`, `addContactTagAndDispatch`, `sendTemplateMessage`, `buildSendComponents`, `createBroadcast`, `resolveTemplateRow`, `tagDeliveredCustomersPage`). No logic is duplicated.
- **New API-key scopes** for each domain (listed below). The existing three-tier guard stays: read is always on, write needs an opt-in, and mass or destructive actions need an opt-in plus `confirm: true`.
- **Audit log:** every MCP write records the API key, tool name, arguments and result.

## Feature list

### 1. Account & team (`account:read`, `team:write`)
- whoami: account, plan, scopes, WhatsApp number, quality rating, messaging limit tier.
- List members and roles. Invite, change role, remove (confirm).
- List, create and revoke API keys (admin only, confirm).

### 2. Contacts (extends v1)
- Search by name, phone, tag, custom field or created date. Get a contact with its tags, custom values, notes, deals, orders and last message.
- Create, update, merge duplicates (confirm) and delete (confirm).
- Bulk import from CSV text or JSON rows, and bulk tag or untag a filtered set.
- Export a filtered set as CSV.
- Custom fields: list fields, define a field, and set or clear a contact's value.

### 3. Tags (`tags:read|write`)
- List tags with contact counts. Create, rename, recolour, delete (confirm).
- Add or remove a tag on one or many contacts. This goes through `addContactTagAndDispatch`, so "tag added" automations still fire.

### 4. Notes (`notes:write`)
- List, add, edit and delete a contact's notes.

### 5. Inbox / conversations (`conversations:write`)
- List conversations by status, assignee, unread, tag or last-activity window. Get a thread with its messages, media links and reactions.
- Assign or unassign an agent, open/close/snooze, mark read or unread.
- Send text, template (with body, header media, URL-button and coupon values), media, or a reaction.
- Check the 24-hour window ("can I send free text or must I use a template?").
- Quick replies: list, use, create, edit, delete.
- Download a media message so the agent can read an image, PDF or voice note.

### 6. Templates (`templates:read|write`)
- List templates with status, category, quality, variables and buttons.
- Preview a filled template for a contact (render only, no send).
- Create and submit for approval, edit and resubmit, delete (confirm), sync from Meta.

### 7. Broadcasts (extends v1)
- List broadcasts with funnel stats (sent, delivered, read, replied, failed). Get recipients filtered by status, and export them.
- Estimate an audience: all, tags include/exclude, custom field, or a list of phones. Returns the count and a sample.
- Save a draft. Send a test to one number. Send now or schedule (confirm). Resume or retry failed sends (confirm). Delete.
- Uses the same variable, button and header handling as the wizard (`lib/broadcast-template-variables.ts`, `recipient-params.ts`).

### 8. Pipelines & deals (`deals:read|write`)
- List pipelines and stages. Create, rename or reorder stages.
- Deals: list by stage, owner or value. Create, update, move stage, mark won or lost, delete (confirm).

### 9. Automations (`automations:read|write`)
- List automations with their trigger and steps. Get the execution logs.
- Create or update one (trigger, conditions, steps), enable or disable, duplicate, delete (confirm).
- See pending scheduled executions and cancel one.

### 10. Flows / chatbots (`flows:read|write`)
- List flows and templates. Get a flow's nodes. Create from a template, edit the nodes, activate or deactivate.
- See runs and their events (debug why a customer got stuck).

### 11. AI assistant (`ai:read|write`)
- Read or update the AI auto-reply config (on/off, persona, hours, hand-off rules).
- Knowledge base: list docs, add text or a URL, delete, reindex.
- Draft a reply for a conversation. Run a playground test question. Show usage and cost.

### 12. Shopify / FlexyPe / Shiprocket (`commerce:read|write`)
- Connection status, test mode and test numbers, and credentials health (without revealing the secrets).
- Orders: search, get one with its fulfilment timeline, list the orders for a contact.
- Order-update events: list, view or edit the template mapping, delays, follow-ups and on/off. Send a test.
- Notification log (sent, skipped or failed and why) and webhook events, with replay of one event (confirm).
- Run the "Delivered / RTO" past-order tagging and return its progress.

### 13. Analytics & reports (`reports:read`)
- Dashboard numbers: conversations opened or closed, response time, messages per day, broadcast performance, top tags, deal value per stage.
- Spending: the transactions and message-charges ledger, cost per broadcast, monthly totals.
- Agent performance: chats handled and first-response time per member.

### 14. Notifications & webhooks
- List and mark read in-app notifications.
- Outgoing webhooks (already in v1): list, create, update, delete, plus a test delivery.

### 15. WhatsApp settings (`settings:read`; writes for admins only)
- Number status, display name, quality, tier and registration check (`whatsapp/config/verify-registration`).
- Business profile: read and update the about text, address and website.

### 16. Agent-friendly extras (MCP-specific)
- **Resources:** `wacrm://contact/{id}`, `wacrm://conversation/{id}`, `wacrm://template/{name}`, `wacrm://broadcast/{id}`, so the agent can attach context.
- **Prompts:** "daily inbox triage", "follow up with abandoned carts", "weekly broadcast report", "RTO customer review".
- **Dry run:** every send or bulk tool accepts `dry_run: true` and returns the exact Meta payload and the recipient count without sending.
- **Bulk-safe pagination** with cursors, plus an `estimated_cost` for mass sends.
- **Idempotency keys** on sends and broadcasts, so a retried tool call never messages someone twice.
- **Structured errors** in one shape, `{ code, message, field }`, for example `missing_scope`, `outside_24h_window`, `template_not_approved`, `button_param_missing`.

### 17. Ops & ERP integration (`ops:read|write`)
The ops team works in order numbers and AWBs, and the ERP (Estelle ops: orders, shipments, order comments, customer tags) is a second system of record. These tools connect the two without passing phone numbers around.

- **Look up by order number or AWB.** `find_by_order` accepts `#EL2204`, `EL2204` or an AWB.
  - It returns the contact id, the conversation id, the order status and the latest fulfilment: no phone number, name or address.
  - It searches `shopify_orders` and `shopify_fulfillments` (tracking numbers), so a lookup appears in logs and the audit trail as an order reference, not as customer data.
  - Every other tool accepts the returned ids, so the agent can open the chat or send to that customer without ever handling the number.
- **Send a document to a team member.** `send_document_to_staff` sends a PDF (labels, manifest) to a contact flagged as staff, using `sendMediaMessage` (document plus caption and filename).
  - The PDF is a URL, or a file uploaded through the tool.
  - Only staff contacts are allowed, so it can't be pointed at a customer.
  - If the team member hasn't messaged in 24 hours, a utility template with a document header is used instead.
  - This replaces the manual PC step of sending the day's labels to Priyanshu.
- **NDR (non-delivery) message flow.**
  - **Trigger:** an NDR event from Shiprocket or Shopify (`shipment_status` failure or attempted delivery). It sends a template along the lines of "We couldn't deliver order {{1}}. Reply 1 to reattempt, 2 to choose a new time."
  - **Reply handling:** the reply is matched to the open NDR for that contact (`1` means reattempt, `2` means new time, anything else goes to a person). The answer is saved as a comment on the ERP order, and the conversation is tagged `NDR: reattempt` or `NDR: reschedule`.
  - **Tracking and safety:** an `ndr_requests` record per order holds the state (sent, answered, expired), so a second NDR on the same order doesn't open a duplicate. Test mode applies as for the other Shopify updates.
- **Event feed for the agent.** `list_events_since(cursor, types)` returns new events in order:
  - the types are `inbound_message`, `button_reply`, `ndr_reply`, `cod_confirmation`, `order_event` and `tag_added`;
  - each call returns a `next_cursor`, so a scheduled agent run fetches only what's new instead of scanning the inbox;
  - outgoing webhooks can deliver the same events as a push, from the existing v1 webhooks plus these event types.
- **ERP tag sync.** `Order RTO`, `Blocked`, `Partial pay` and any other configured tags stay in step between ERP customers and wacrm contacts.
  - It runs both ways, matching customers by normalised phone on the server, so the agent never sees the number.
  - wacrm → ERP goes through a tag-added or tag-removed webhook. ERP → wacrm goes through a sync endpoint or a nightly reconcile with a report of the differences.
  - RTO scoring and the broadcast exclusion lists then come from one list. Every change is recorded in the audit log.
- **Staff contacts / internal team group.** A `is_staff` flag on contacts (or a "Team" group that sets it).
  - Staff are never added to broadcasts, campaign counts or marketing analytics, even under "All contacts", and are never charged as marketing in the spend reports.
  - Opt-out, abandoned-cart, order-update and automation marketing logic skips them.
  - Their messages are kept apart from customer metrics: response time and open conversations.
  - Staff are the only allowed recipients for `send_document_to_staff`.

### 18. Skills (the know-how layer on top of the tools)
The MCP tools are *what* the agent can do. Skills are *how* to do your workflows well. Each skill is a `SKILL.md` (with optional scripts and reference files) that the agent loads only when a task matches. Tools alone leave the agent guessing at rules such as "test before sending", "exclude Order RTO" or "templates only outside 24h".

Delivery: one **Claude Code plugin, `wacrm`**, that bundles the MCP server config (`.mcp.json` pointing at `/api/mcp`) with the `skills/` folder. Installing the plugin gives the agent both. The same skill folders can be uploaded to claude.ai as custom skills for use in the web or desktop app.

| Skill | Triggers on | What it encodes |
|---|---|---|
| `wacrm-inbox-triage` | "check the inbox", "what needs a reply" | Open, unread and outside-24h buckets; draft replies; use a template when the window has closed; assign or close; summary report |
| `wacrm-broadcast-campaign` | "send a broadcast / offer to …" | Pick the template; build the audience (include tags, exclude `Order RTO` and opted-out contacts); estimate count and cost; map variables, buttons and video header; **Send test to the owner's number first**; wait for an OK; schedule; report the funnel the next day |
| `wacrm-template-builder` | "create a template for …" | Meta rules (categories, variable samples, button limits, no `{{}}` at the start or end); submit; poll the status; explain rejections |
| `wacrm-abandoned-cart-recovery` | "follow up abandoned carts" | `Abandoned Cart` tag, carts with no order since, a reminder template with a coupon, no repeat within N days |
| `wacrm-rto-review` | "RTO customers", "COD risk" | Contacts with `Order RTO`, their order history, deciding whether to block COD or tag them high-risk, and an outreach script |
| `wacrm-order-updates-setup` | "set up Shopify messages" | Test mode on with test numbers; map each event to a template; delays and follow-ups; send a test per event; turn test mode off only after approval |
| `wacrm-customer-360` | "tell me about +91…" | Contact, tags, notes, orders, deliveries, deals, last chats; a one-page summary |
| `wacrm-weekly-report` | "weekly report", "how did we do" | Messages, response time, broadcast results, spend, new customers, delivered vs RTO; a fixed report format |
| `wacrm-automation-builder` | "when X happens, send Y" | Translate the request into a trigger, conditions and steps; dry-run it; enable; check the logs after the first run |
| `wacrm-ndr-handling` | "handle NDRs", scheduled run | Pull NDR events from `list_events_since`; send the NDR template once per order; read replies (1 reattempt, 2 new time); write each answer as an ERP order comment; escalate unclear replies; daily NDR summary |
| `wacrm-daily-labels-to-staff` | "send today's labels to Priyanshu" | After the shipments are booked, fetch the labels and manifest PDF and send them with `send_document_to_staff` with a dated caption; confirm delivery |
| `wacrm-cod-confirmation` | scheduled run | Pick up COD confirm or cancel replies from the event feed; update the order and tags; flag no-replies for a call |
| `wacrm-erp-tag-sync` | "sync tags with ERP", nightly | Reconcile `Order RTO`, `Blocked` and `Partial pay` both ways; report the differences; never print phone numbers |
| `wacrm-safety-rules` (always loaded by the others) | any send or bulk change | Never mass-send without a dry run, a test and an explicit OK; respect opt-outs; idempotency keys; never print API keys or secrets; use a template outside 24h; refer to customers by order number or contact id, not phone; never broadcast to staff |

Skills call only MCP tools, never the database, so scopes and the audit log still apply. Business-specific defaults live in one `reference/estelle.md` that a skill reads: store name, the owner's test number, the default exclude tags, the coupon conventions.

## Delivery phases (suggested)
1. **Foundation:** the `/api/mcp` remote endpoint, the new scopes, the audit log, dry run and idempotency.
2. **Daily operations:** order and AWB lookup, staff contacts, the event feed, inbox actions, tags, notes, custom fields, templates (read and preview), and broadcasts (drafts, tests, audience estimate, schedule, resume).
3. **Sales & commerce:** deals and pipelines; the Shopify orders, events and logs; the NDR flow; sending documents to staff; ERP tag sync.
4. **Building:** automations, flows, and the AI config and knowledge base.
5. **Admin & insight:** reports, spending, team, API keys and WhatsApp settings.

**Skills:** each phase ships the skills that use its tools, all in the `wacrm` plugin:
- phase 2: `inbox-triage`, `broadcast-campaign`, `customer-360` and `safety-rules`;
- phase 3: `rto-review`, `abandoned-cart-recovery`, `order-updates-setup`, `ndr-handling`, `daily-labels-to-staff`, `cod-confirmation` and `erp-tag-sync`;
- phase 4: `automation-builder` and `template-builder`;
- phase 5: `weekly-report`.

## Critical files
- `mcp-server/src/tools/{read,write,broadcast,shared}.ts`: add one file per domain and register them in `tools/index.ts`.
- `src/app/api/v1/*`: new routes per domain. Auth goes through the existing API-key helper; follow `src/lib/api/v1/respond.ts` and `pagination.ts`.
- New `src/app/api/mcp/route.ts` (remote transport) and a migration for:
  - the new scopes and the audit table;
  - `contacts.is_staff`;
  - an `ndr_requests` table;
  - an `agent_events` feed table, or a view over `messages` and `shopify_*`.
- Staff exclusion goes into `use-broadcast-sending.ts` `resolveAudience`, `broadcast-core.ts`, the Shopify `notify.ts` / `auto-tags.ts` paths and the report queries.
- The NDR trigger goes into `src/lib/shopify/process.ts` `handleFulfillment`, next to the RTO tagging, and the Shiprocket webhook. Replies are matched in the WhatsApp inbound webhook handler.
- `docs/public-api.md` and `mcp-server/README.md`: the tool table and the safety model.
- New `plugin/wacrm/` containing:
  - `.claude-plugin/plugin.json`;
  - `.mcp.json`;
  - `skills/<name>/SKILL.md`, with `reference/` and `scripts/` folders where a skill needs them.

## Verification
- Unit tests per v1 route, colocated in Vitest as the repo already does: scope enforcement, account isolation, dry run.
- MCP Inspector against `/api/mcp`: list the tools, call each read tool, run every write with `dry_run`.
- Skills: install the plugin locally and check that each skill triggers on its example phrases. Run each one against test mode with a test number. For example, `broadcast-campaign` must stop for an OK after the test send.
- Ops: `find_by_order('#EL2204')` returns ids only and no PII; a staff contact never appears in a broadcast audience; replaying an NDR webhook in test mode sends once and a reply of "1" writes the ERP comment; the event cursor returns each reply exactly once.
- End to end from Claude Code with a test-mode Shopify config and a test number. Triage the inbox, tag a contact, draft a broadcast, send a test, check the audit log.
