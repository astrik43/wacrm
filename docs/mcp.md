# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server, so Claude (or any MCP client) can run your CRM in natural
language:

> "Which chats are waiting for a reply?"
> "Look up order #EL2204 and tell me where it is."
> "Send the Diwali offer to everyone who got a delivery. Test it on my number first."

There are two ways to connect. Use the **remote server**; the original
standalone program is kept for older setups.

| | Remote server (`/api/mcp`) | Standalone `wacrm-mcp` |
|---|---|---|
| Tools | **147** (see [tool reference](./mcp-tools.md)) | 12 |
| Runs | inside your wacrm app | on your computer (`npx`), calling `/api/v1` |
| Safety | scopes, `confirm`, `dry_run`, idempotency, audit log | read-only unless you opt in |
| Connect | URL + API key header | command + environment variables |

## Connect to the remote server

**URL:** `https://<your-wacrm-host>/api/mcp`

1. In wacrm: **Settings → API keys → New API key.** Grant only the
   scopes you need (see [Scopes](#scopes)). The key is shown once.
2. Add the server to your client. Claude Code:

   ```bash
   claude mcp add --transport http wacrm https://<your-wacrm-host>/api/mcp \
     --header "Authorization: Bearer wacrm_live_xxxxxxxx"
   ```

   Any client that can send a bearer header works: the URL is the
   endpoint, the header is `Authorization: Bearer <key>`.
3. Ask "who am I in wacrm?" The `whoami` tool shows the account, the
   key's scopes and how many tools the key can use.

For Claude Code you can instead install the [`plugin/wacrm`](../plugin/wacrm)
folder: it bundles this connection (`WACRM_MCP_URL`, `WACRM_API_KEY`) with
14 skills that teach the agent your workflows (broadcasts, NDR, inbox
triage, weekly report and more).

> **claude.ai on the web and the Claude desktop "connectors" screen cannot
> connect yet.** They only support OAuth or no authentication, and wacrm
> authenticates with API keys. Use Claude Code or another client that can
> send a header. Do **not** work around this by removing authentication.

### How the endpoint behaves
- **Protocol:** MCP Streamable HTTP, stateless. Every request is a
  JSON-RPC `POST` to `/api/mcp` with `Content-Type: application/json`
  and `Accept: application/json, text/event-stream`. `GET` and `DELETE`
  return 405: opening the URL in a browser is an error by design.
- **Auth:** a missing, unknown, revoked or expired key returns `401`
  (`{"error":{"code":"unauthorized",…}}`). Each key has a request rate
  limit (`429` with `Retry-After`).
- **Tool visibility:** `tools/list` returns only tools whose scope the
  key holds, so an assistant never sees a tool it would be refused.

A raw call, for testing:

```bash
curl -s https://<host>/api/mcp \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

## Scopes

A key can do exactly what its scopes allow, independent of who created
it. Creating keys is admin-only, and an MCP-created key can only carry
scopes its creator already has.

| Scope | Allows |
|---|---|
| `messages:send` | Send WhatsApp messages |
| `messages:read` | Read messages and their delivery status |
| `contacts:read` | List and read contacts |
| `contacts:write` | Create and update contacts |
| `conversations:read` | List and read conversations |
| `broadcasts:send` | Launch broadcast campaigns |
| `webhooks:manage` | Register and manage outbound event webhooks |
| `account:read` | Read account details, plan and WhatsApp number status |
| `team:read` | List team members and roles |
| `team:write` | Invite, change roles of and remove team members |
| `tags:read` | List tags and their contact counts |
| `tags:write` | Create, rename and delete tags; tag and untag contacts |
| `notes:read` | Read a contact's notes |
| `notes:write` | Add, edit and delete a contact's notes |
| `conversations:write` | Assign, close and reopen conversations; manage quick replies |
| `templates:read` | List and preview message templates |
| `templates:write` | Create, submit, sync and delete message templates |
| `broadcasts:read` | List broadcasts, their stats and recipients; estimate audiences |
| `deals:read` | Read pipelines and deals |
| `deals:write` | Create and update pipelines and deals |
| `automations:read` | Read automations and their logs |
| `automations:write` | Create, update, enable and delete automations |
| `flows:read` | Read chatbot flows and their runs |
| `flows:write` | Create, edit and activate chatbot flows |
| `ai:read` | Read the AI assistant config, knowledge base and usage |
| `ai:write` | Change the AI assistant config and knowledge base |
| `commerce:read` | Read Shopify orders, order updates and notification logs |
| `commerce:write` | Change order-update settings; replay events; tag past orders |
| `reports:read` | Read analytics, spend and agent performance reports |
| `settings:read` | Read WhatsApp and workspace settings |
| `settings:write` | Change WhatsApp business profile and workspace settings |
| `ops:read` | Look up customers by order number or AWB; read staff and NDR state |
| `ops:write` | Send documents to staff, run the NDR flow and sync tags with the ERP |
| `events:read` | Read the event feed (inbound replies, order events, tag changes) |

### Suggested keys
- **Read-only assistant** (triage, lookups, reports): `account:read`, `contacts:read`, `notes:read`, `tags:read`, `conversations:read`, `templates:read`, `broadcasts:read`, `deals:read`, `automations:read`, `flows:read`, `commerce:read`, `reports:read`, `settings:read`, `ops:read`, `events:read`.
- **Add for replies:** `messages:send`, `conversations:write`. **For broadcasts:** `broadcasts:send`. **For tagging and notes:** `tags:write`, `notes:write`.
- **Keep away from unattended agents:** `team:write`, `settings:write`, `webhooks:manage`, `ai:write`.

## Safety model

Sending a WhatsApp message cannot be recalled, so every tool goes
through one executor (`src/lib/mcp/executor.ts`) that no tool can skip.

| Tier | Meaning | Extra rules |
|---|---|---|
| `read` | never changes anything | needs a `:read` scope; not audited |
| `write` | changes data or sends | needs a write scope; audited; accepts `dry_run` and `idempotency_key` |
| `destructive` | deletes, mass-sends, mints credentials | everything a write has, plus `confirm: true` |

- **`confirm: true`**: a destructive tool refuses without it
  (`confirm_required`). It also carries MCP's `destructiveHint`, so
  compliant clients ask you first. A `dry_run` needs no confirm.
- **`dry_run: true`**: changes and sends nothing and returns what would
  happen: the exact WhatsApp message payload, the recipient count, the
  rows affected, the cost estimate. The result carries `"dry_run": true`.
- **`idempotency_key`**: retrying a write with the same key returns the
  first result (marked `"idempotent_replay": true`) instead of acting
  twice. Keys are per account and tool; only successful runs are kept;
  dry runs are not.
- **Audit log**: every write, destructive and dry-run call is recorded in
  `mcp_audit_log` (which key, which tool, arguments, result, duration).
  Secrets and customer contact details (fields named like `secret`,
  `token`, `password`, `api_key`, `authorization`, `credential`, `phone`,
  `email`, `address`) are stored as `[redacted]`. Account admins can read
  the table; there is no dashboard page for it yet.
- **Account scoping**: tools use a service-role database client, so every
  query is filtered by the key's account and every id an assistant
  supplies is checked to belong to it. Another account's id returns
  `not_found`.
- **Staff are never marketed to.** Contacts flagged `is_staff` (team
  members) are excluded from broadcast audiences even under "all", from
  marketing counts and spend, from customer metrics, and from order
  updates, cart reminders and automatic tags. They are the only
  recipients `send_document_to_staff` accepts.
- **Privacy**: tools return ids, names and order numbers. Phone numbers,
  emails and addresses come back only from the contact tools. Secrets
  (tokens, API keys, webhook signing secrets) are never returned; a
  created key or webhook secret is shown once.
- **Shopify test mode** is respected: while it's on, order updates reach
  only the test numbers.

## Results and errors

Every tool returns one JSON text block. A failure sets `isError` and
returns one shape:

```json
{ "code": "outside_24h_window", "message": "…what to do next…", "field": "conversation_id" }
```

| Code | Meaning |
|---|---|
| `missing_scope` | the key lacks the tool's scope |
| `invalid_input` | bad or missing argument (`field` names it) |
| `not_found` | the id doesn't exist in this account |
| `confirm_required` | a destructive tool was called without `confirm: true` |
| `conflict` | the action clashes with current state |
| `rate_limited` | too many requests |
| `upstream_error` | WhatsApp/Meta, Shopify or another provider refused |
| `outside_24h_window` | free text needs the customer to have written in the last 24 hours; use a template |
| `template_not_approved` | only APPROVED templates can be sent |
| `button_param_missing` | a URL button with `{{1}}` or a coupon button needs a value |
| `not_staff` | `send_document_to_staff` was pointed at a customer |
| `internal` | unexpected; nothing was changed unless stated |

**Pagination:** list tools take `limit` (default 25, max 100) and an
opaque `cursor`, and return `next_cursor` (null at the end).

**Keys need an owner for some tools.** Creating deals, automations,
flows, quick replies, submitting templates, reactions, opening a new
conversation and notifications record a user. They use the user who
created the key; if that user was removed, they return `invalid_input`.

## Ops: orders, staff, NDR and the event feed

These are built for a scheduled agent that works from order numbers.

- **`find_by_order`** takes `#EL2204`, `EL2204` or an AWB and returns the
  contact id, conversation id and order status. No phone, name or address.
- **Staff**: `set_contact_staff`, `list_staff_contacts`, and
  `send_document_to_staff` (a PDF link plus caption to a staff contact:
  https, public, `application/pdf`, at most 10 MB; there is no file
  upload). Outside the 24-hour window it needs a staff template
  (`update_ops_settings`).
- **NDR flow** (off by default). When Shopify reports a delivery attempt or
  failure, wacrm sends the NDR template once per order ("reply 1 to
  reattempt, 2 for a new time"), records the answer, tags the contact
  `NDR: reattempt` / `NDR: reschedule`, and emits an `ndr.reply` event.
  Enable it with `update_ndr_settings`. It skips cancelled orders, staff
  and, in test mode, non-test numbers. Free-text replies are kept as
  `other` and stay open; requests expire after 7 days.
- **Event feed**: `list_events_since(cursor, types)` returns what's new,
  oldest first, each event exactly once: `inbound_message`,
  `button_reply`, `ndr_reply`, `cod_confirmation`, `order_event`,
  `tag_added`. Save `next_cursor` between runs. Events carry ids, order
  numbers and a short text excerpt, never phone numbers.
- **ERP bridge.** wacrm never calls your ERP. The agent reads events and
  tag state from wacrm and writes to the ERP with the ERP's own MCP (for
  example posting an NDR answer as an order comment). `get_tag_state` and
  `apply_tag_changes` keep `Order RTO`, `Blocked` and `Partial pay` in
  step; matching is by order number, never by phone.

## Skills

[`plugin/wacrm`](../plugin/wacrm) holds 14 skills (inbox triage, customer
360, broadcast campaign, template builder, abandoned carts, RTO review,
order-updates setup, NDR handling, daily labels to staff, COD
confirmation, ERP tag sync, automation builder, weekly report, and the
shared safety rules). The tools say what the agent *can* do; the skills
say how *your* workflow does it: test before sending, exclude RTO
customers, use templates outside 24 hours. A test fails if a skill names a
tool that doesn't exist.

## The standalone `wacrm-mcp` program (older, 12 tools)

[`mcp-server/`](../mcp-server) wraps the [public API](./public-api.md) as
a local program started by the client. It is read-only unless
`WACRM_ENABLE_WRITES=true` (and `WACRM_ENABLE_BROADCASTS=true` for mass
sends). It is the only option for clients that can launch a command but
can't send an HTTP header. Prefer the remote server otherwise.

## Deploying or upgrading

Apply the migrations **before** the new code starts serving:

| Migration | Adds |
|---|---|
| `054_mcp_audit_log.sql` | `mcp_audit_log` |
| `055_contacts_is_staff.sql` | `contacts.is_staff` |
| `056_ops_ndr.sql` | `ops_settings`, `ndr_requests` |

```bash
npx supabase db push --linked --dry-run   # see what will apply
npx supabase db push --linked             # apply
```

The endpoint allows 300 seconds per request, so a large broadcast can
finish its sends after the response; host platforms with a shorter limit
may need it raised.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Couldn't reach … server" in claude.ai | claude.ai connectors need OAuth, which wacrm doesn't offer. Use Claude Code or a client that sends a header. |
| `401 unauthorized` | missing, wrong, revoked or expired key. Check the `Authorization: Bearer …` header. |
| A tool isn't listed | the key lacks its scope. `whoami` shows the key's scopes. |
| `missing_scope` | same, from a direct call. Add the scope to a new key. |
| `confirm_required` | a destructive tool: ask the user, then pass `confirm: true`. |
| `outside_24h_window` | use `send_template` instead, or wait for the customer to write. |
| `invalid_input` on a create tool | the key's owner was removed; make a new key as an active user. |
| GET on `/api/mcp` shows "method not allowed" | expected: the endpoint only accepts JSON-RPC `POST`. |

## Not supported yet
OAuth (claude.ai web connectors), broadcast scheduling, contact merging,
conversation snooze, file upload for staff documents, and NDR triggers
from Shiprocket (NDR starts from Shopify shipments).
