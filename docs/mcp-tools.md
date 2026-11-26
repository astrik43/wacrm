# MCP tool reference

All 147 tools of the wacrm MCP server (`/api/mcp`). See the [MCP guide](./mcp.md) for how to connect, the safety model and error codes.

- **Tier**: `read` never changes anything. `write` changes data or sends a message (audited; accepts `dry_run` and `idempotency_key`). **destructive** also needs `confirm: true`.
- **Scope**: the API-key scope the tool needs. A key only sees the tools its scopes allow.
- **Arguments**: `name?` is optional. Every write and destructive tool additionally accepts `dry_run` and `idempotency_key`, and destructive ones `confirm`. List tools take `limit` (default 25, max 100) and `cursor`.
- Tools never return phone numbers, emails or addresses unless their job is to read a contact.

## Basics

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `whoami` | read | any key | `verbose?` | Show the account this API key belongs to, the scopes it carries, and how many tools it can use. |

## Team and API keys

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_team_members` | read | `team:read` | — | List the people in this account with their role (owner, admin, agent, viewer) and join date. |
| `list_pending_invitations` | read | `team:read` | — | List outstanding (not accepted, not expired) team invitations. |
| `invite_member` | write | `team:write` | `role`, `label?`, `expires_in_days?` | Create a team invite link for a role (admin, agent or viewer; never owner). |
| `change_member_role` | write | `team:write` | `user_id`, `role` | Change a team member to admin, agent or viewer. |
| `remove_member` | **destructive** | `team:write` | `user_id` | Remove a member from the account. |
| `list_api_keys` | read | `account:read` | — | List this account's API keys: name, prefix, scopes, last used, expiry, revoked state. |
| `create_api_key` | **destructive** | `team:write` | `name`, `scopes`, `expires_in_days?` | Mint a new API key. |
| `revoke_api_key` | **destructive** | `team:write` | `key_id` | Revoke an API key immediately (it stops working on its next request). |

## Contacts and custom fields

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `search_contacts` | read | `contacts:read` | `query?`, `tag_id?`, `custom_field_id?`, `custom_field_value?`, `created_after?`, `created_before?`, `is_staff?`, `limit?`, `cursor?` | Search contacts by free text (name/phone/email/company), tag, custom field value and created date. |
| `get_contact` | read | `contacts:read` | `contact_id` | Get one contact with tags, custom field values, recent notes, open deals, recent Shopify orders and the last message. contact_id comes from search_contacts. |
| `create_contact` | write | `contacts:write` | `phone`, `name?`, `email?`, `company?`, `tags?` | Create a contact from a phone number in international format (e.g. +14155550123). |
| `update_contact` | write | `contacts:write` | `contact_id`, `name?`, `email?`, `company?`, `tags?` | Update a contact's name, email or company (null clears email/company). |
| `delete_contact` | **destructive** | `contacts:write` | `contact_id` | Permanently delete a contact with their notes, tags and conversation history. |
| `import_contacts` | write | `contacts:write` | `rows?`, `csv?`, `update_existing?` | Bulk create contacts from JSON rows (or CSV text with a phone header and optional name,email,company,tags columns), max 1000 per call. |
| `export_contacts` | read | `contacts:read` | `query?`, `tag_id?`, `custom_field_id?`, `custom_field_value?`, `created_after?`, `created_before?`, `is_staff?`, `max_rows?` | Export contacts as CSV text (columns: phone,name,email,company,tags,created_at,is_staff), same filters as search_contacts, capped at 5000 rows (truncated=true when more exist; narrow the filters). |
| `list_custom_fields` | read | `contacts:read` | — | List the custom contact fields defined in this account. |
| `create_custom_field` | write | `contacts:write` | `name` | Define a new custom contact field (text). |
| `set_contact_custom_value` | write | `contacts:write` | `contact_id`, `custom_field_id`, `value` | Set a contact's value for a custom field, or clear it with value=null. |

## Tags

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_tags` | read | `tags:read` | `limit?`, `cursor?` | List the account's tags with colour and how many contacts carry each. |
| `create_tag` | write | `tags:write` | `name`, `color?` | Create a tag. |
| `rename_tag` | write | `tags:write` | `tag_id`, `name?`, `color?` | Rename a tag and/or change its colour. |
| `delete_tag` | **destructive** | `tags:write` | `tag_id` | Delete a tag and remove it from every contact. |
| `add_tag_to_contacts` | write | `tags:write` | `contact_ids`, `tag_id?`, `tag_name?` | Add one tag to up to 500 contacts (give tag_id or tag_name; a missing name is created). |
| `remove_tag_from_contacts` | write | `tags:write` | `contact_ids`, `tag_id?`, `tag_name?` | Remove one tag from up to 500 contacts (give tag_id or tag_name of an existing tag). |

## Notes

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_contact_notes` | read | `notes:read` | `contact_id`, `limit?`, `cursor?` | List the internal notes on a contact, newest first. contact_id comes from search_contacts. |
| `add_contact_note` | write | `notes:write` | `contact_id`, `text` | Add an internal note (never sent to the customer) to a contact. |
| `edit_contact_note` | write | `notes:write` | `note_id`, `text` | Replace the text of an existing note. note_id comes from list_contact_notes. |
| `delete_contact_note` | **destructive** | `notes:write` | `note_id` | Permanently delete a note. note_id comes from list_contact_notes. |

## Inbox and sending

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_conversations_filtered` | read | `conversations:read` | `status?`, `agent_id?`, `unassigned?`, `unread_only?`, `tag_id?`, `active_after?`, `active_before?`, `limit?`, `cursor?` | List inbox conversations, most recently active first, with filters: status (open/pending/closed), assignee (agent_id from list_team_members, or unassigned=true), unread_only, tag_id (contact tag), and a last-activity window… |
| `get_conversation_thread` | read | `conversations:read` | `conversation_id`, `limit?`, `cursor?` | Read the messages of one conversation (conversation_id from list_conversations_filtered), oldest first within the page, newest page first. |
| `check_reply_window` | read | `conversations:read` | `conversation_id` | Tell whether you can send free text to a conversation or must use a template. |
| `get_media_info` | read | `conversations:read` | `message_id` | Get details of the media on a message (message_id from get_conversation_thread): kind, mime type, size when known, and a url the agent can fetch when the file is stored publicly. |
| `assign_conversation` | write | `conversations:write` | `conversation_id`, `agent_id` | Assign a conversation to a team member (agent_id from list_team_members). |
| `unassign_conversation` | write | `conversations:write` | `conversation_id` | Remove the assignee from a conversation so it returns to the shared inbox. |
| `set_conversation_status` | write | `conversations:write` | `conversation_id`, `status` | Set a conversation's status to open, pending (waiting on the customer or a teammate) or closed. |
| `mark_conversation_read` | write | `conversations:write` | `conversation_id` | Reset a conversation's unread counter to zero. |
| `list_quick_replies` | read | `conversations:read` | — | List the account's saved quick replies (reusable text or interactive snippets). |
| `create_quick_reply` | write | `conversations:write` | `title`, `kind?`, `content_text?`, `interactive_payload?` | Save a reusable quick reply. kind "text" needs content_text; kind "interactive" needs interactive_payload (reply buttons or a list). |
| `update_quick_reply` | write | `conversations:write` | `quick_reply_id`, `title?`, `kind?`, `content_text?`, `interactive_payload?` | Edit a quick reply (id from list_quick_replies). |
| `delete_quick_reply` | **destructive** | `conversations:write` | `quick_reply_id` | Permanently delete a quick reply (id from list_quick_replies). |
| `send_text` | write | `messages:send` | `conversation_id`, `text`, `reply_to_message_id?` | Send a free-form text message in a conversation. |
| `send_template` | write | `messages:send` | `conversation_id?`, `contact_id?`, `template_name`, `language?`, `body_params?`, `header_text?`, `header_media_url?`, `button_params?` | Send an approved WhatsApp template. |
| `send_media` | write | `messages:send` | `conversation_id`, `kind`, `media_url`, `caption?`, `filename?` | Send a media message from a public https URL. Free-form, so it is only allowed inside the 24-hour reply window (otherwise outside_24h_window; use send_template with a media header instead). caption is not supported for audio… |
| `send_reaction` | write | `messages:send` | `message_id`, `emoji` | React to a message in a thread with an emoji (empty string removes your reaction). message_id is an id from get_conversation_thread; the message must have been delivered via WhatsApp. |

## Templates

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_templates` | read | `templates:read` | `status?`, `category?`, `quality?`, `search?`, `limit?`, `cursor?` | List the account's WhatsApp templates with status (APPROVED, PENDING, REJECTED, PAUSED, ...), category, quality rating, number of body variables and buttons (with which ones need a value to send). |
| `get_template` | read | `templates:read` | `template_id` | Get one template in full (template_id from list_templates): header, body, footer, buttons, sample values, status, rejection reason, and which values you must pass to send it. |
| `preview_template` | read | `templates:read` | `template_id`, `contact_id?`, `body_params?`, `header_text?`, `header_media_url?`, `button_params?` | Render a template without sending: returns the readable message and the exact Meta components payload send_template would post. |
| `submit_template` | write | `templates:write` | `name`, `category`, `language?`, `header_type?`, `header_content?`, `header_media_url?`, `body_text`, `footer_text?`, `buttons?`, `sample_values?` | Create a new message template and submit it to Meta for approval (review usually takes minutes to 24 hours; check status with list_templates or sync_templates). |
| `sync_templates` | write | `templates:write` | — | Pull the latest templates and their approval status from Meta into the CRM. Run it after submitting a template, when a template looks missing, or when its status may have changed. |
| `delete_template` | **destructive** | `templates:write` | `template_id` | Delete a template on Meta (that language variant) and in the CRM. Cannot be undone and any broadcast or automation using it will stop working. template_id from list_templates. |

## Broadcasts

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_broadcasts` | read | `broadcasts:read` | `status?`, `limit?`, `cursor?` | List broadcasts, newest first, each with its funnel (sent, delivered, read, replied, failed). |
| `get_broadcast` | read | `broadcasts:read` | `broadcast_id` | One broadcast with its funnel and the template and variable mapping it uses. |
| `get_broadcast_recipients` | read | `broadcasts:read` | `broadcast_id`, `status?`, `limit?`, `cursor?` | Recipients of one broadcast with their delivery status and any error, newest first. |
| `export_broadcast_recipients` | read | `broadcasts:read` | `broadcast_id`, `status?` | Recipients of one broadcast as CSV text (recipient_id, contact_id, contact_name, status, sent_at, delivered_at, read_at, replied_at, error), up to 5000 rows. |
| `estimate_audience` | read | `broadcasts:read` | `audience`, `template_name?`, `template_language?` | Count who a broadcast would reach and show a few names, without sending anything. |
| `create_broadcast_draft` | write | `broadcasts:send` | `name`, `template_name`, `template_language?`, `variables?`, `button_variables?`, `header_media_url?`, `audience?` | Save a broadcast as a draft without sending it: template, variable mapping and (optionally) the audience. |
| `send_broadcast_test` | write | `broadcasts:send` | `phone`, `broadcast_id?`, `template_name?`, `template_language?`, `variables?`, `button_variables?`, `header_media_url?` | Send the broadcast message to ONE phone number so it can be checked on a real phone. |
| `send_broadcast` | **destructive** | `broadcasts:send` | `name`, `template_name`, `template_language?`, `variables?`, `button_variables?`, `header_media_url?`, `audience` | Create a broadcast and send the template to an audience. |
| `resume_broadcast` | **destructive** | `broadcasts:send` | `broadcast_id`, `scope?` | Send the recipients of an existing broadcast that did not go out: scope "pending" (never attempted, e.g. it stalled), "failed" (retry the failures) or "all" (both). |
| `delete_broadcast` | **destructive** | `broadcasts:send` | `broadcast_id` | Delete a broadcast and its recipient history. |

## Pipelines and deals

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_pipelines` | read | `deals:read` | — | List the sales pipelines with their stages in order. |
| `create_stage` | write | `deals:write` | `pipeline_id`, `name`, `color?`, `position?` | Add a stage to a pipeline. |
| `rename_stage` | write | `deals:write` | `stage_id`, `name?`, `color?` | Rename a stage and/or change its colour. |
| `reorder_stages` | write | `deals:write` | `pipeline_id`, `stage_ids` | Set the left-to-right order of a pipeline's stages. stage_ids must list EVERY stage of the pipeline exactly once, in the new order (see list_pipelines). |
| `delete_stage` | **destructive** | `deals:write` | `stage_id`, `move_deals_to_stage_id?` | Delete a pipeline stage. |
| `list_deals` | read | `deals:read` | `pipeline_id?`, `stage_id?`, `assigned_to?`, `status?`, `min_value?`, `max_value?`, `limit?`, `cursor?` | List deals, newest first. |
| `get_deal` | read | `deals:read` | `deal_id` | Get one deal with its notes. deal_id comes from list_deals. |
| `create_deal` | write | `deals:write` | `pipeline_id`, `contact_id`, `title`, `stage_id?`, `value?`, `currency?`, `assigned_to?`, `notes?`, `expected_close_date?` | Create a deal for a contact in a pipeline. stage_id defaults to the first stage. |
| `update_deal` | write | `deals:write` | `deal_id`, `title?`, `value?`, `currency?`, `contact_id?`, `assigned_to?`, `notes?`, `expected_close_date?` | Edit a deal's title, value, currency, notes, owner, expected close date or contact. |
| `move_deal_stage` | write | `deals:write` | `deal_id`, `stage_id` | Move a deal to another stage of its pipeline. |
| `mark_deal_won` | write | `deals:write` | `deal_id` | Mark a deal as won. deal_id comes from list_deals. |
| `mark_deal_lost` | write | `deals:write` | `deal_id`, `reason?` | Mark a deal as lost. |
| `reopen_deal` | write | `deals:write` | `deal_id` | Set a won or lost deal back to open. |
| `delete_deal` | **destructive** | `deals:write` | `deal_id` | Permanently delete a deal. |

## Automations

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_automations` | read | `automations:read` | `is_active?`, `trigger_type?`, `limit?`, `cursor?` | List automations, newest first, with their trigger and a summary of their steps (step types in order). |
| `get_automation` | read | `automations:read` | `automation_id` | Get one automation in full: trigger, config and the nested step tree (condition steps carry branches.yes / branches.no). automation_id comes from list_automations. |
| `get_automation_logs` | read | `automations:read` | `automation_id`, `status?`, `limit?`, `cursor?` | Execution history of one automation, newest first: trigger event, status (success/partial/failed), per-step results and the error message. |
| `list_pending_automation_executions` | read | `automations:read` | `automation_id?`, `status?`, `limit?`, `cursor?` | List automation runs that are parked on a wait step (status pending by default) with when they will resume. |
| `cancel_pending_execution` | write | `automations:write` | `execution_id` | Cancel one pending (waiting) automation run so its remaining steps never fire. |
| `create_automation` | write | `automations:write` | `name`, `description?`, `trigger_type`, `trigger_config?`, `steps?`, `enabled?` | Create an automation (trigger + steps). |
| `update_automation` | write | `automations:write` | `automation_id`, `name?`, `description?`, `trigger_type?`, `trigger_config?`, `steps?` | Edit an automation: name, description, trigger and/or steps. |
| `set_automation_enabled` | write | `automations:write` | `automation_id`, `enabled` | Turn an automation on or off. |
| `duplicate_automation` | write | `automations:write` | `automation_id` | Copy an automation and its steps into a new, disabled automation named "<name> (Copy)". |
| `delete_automation` | **destructive** | `automations:write` | `automation_id` | Permanently delete an automation with its steps, logs and pending runs. |

## Flows (chatbots)

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `list_flows` | read | `flows:read` | `status?`, `limit?`, `cursor?` | List chatbot flows, newest first, with status (draft/active/archived), trigger and run counts. |
| `list_flow_templates` | read | `flows:read` | — | List the built-in flow templates (slug, name, description, trigger, node count). |
| `get_flow` | read | `flows:read` | `flow_id` | Get one flow: settings, fallback policy, every node (node_key, node_type, config) and the derived edges (source -> target with a label). flow_id comes from list_flows. |
| `create_flow_from_template` | write | `flows:write` | `template_slug`, `name?` | Create a new DRAFT flow by copying a template (see list_flow_templates). |
| `update_flow_nodes` | write | `flows:write` | `flow_id`, `nodes`, `entry_node_id?`, `name?`, `description?`, `trigger_type?`, `trigger_config?`, `fallback_policy?` | Replace a flow's whole node graph (send the COMPLETE list, from get_flow) and optionally its name, trigger, entry node or fallback policy. |
| `activate_flow` | write | `flows:write` | `flow_id` | Turn a flow on so it starts answering customers. |
| `deactivate_flow` | write | `flows:write` | `flow_id`, `archive?` | Turn a flow off (back to draft, or archived with archive: true). |
| `delete_flow` | **destructive** | `flows:write` | `flow_id` | Permanently delete a flow with its nodes, runs and run events. |
| `list_flow_runs` | read | `flows:read` | `flow_id?`, `contact_id?`, `status?`, `limit?`, `cursor?` | List flow runs (one per customer conversation with a flow), newest first: status, the node it is on, reprompt count, start/end and end reason. |
| `get_flow_run_events` | read | `flows:read` | `run_id`, `limit?` | The event timeline of one flow run (started, node_entered, message_sent, reply_received, fallback_fired, handoff, timeout, error, completed) in order, to debug why a customer got stuck. |

## AI assistant

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `get_ai_config` | read | `ai:read` | — | Read the AI assistant setup: provider, model, persona (system prompt), on/off switches, auto-reply cap and hand-off agent. |
| `update_ai_config` | write | `ai:write` | `provider?`, `model?`, `api_key?`, `embeddings_api_key?`, `system_prompt?`, `is_active?`, `auto_reply_enabled?`, `auto_reply_max_per_conversation?`, `handoff_agent_id?` | Create or change the AI assistant setup. |
| `list_knowledge_documents` | read | `ai:read` | `limit?`, `cursor?` | List the knowledge-base documents the AI assistant answers from (id, title, size, dates), newest first. |
| `add_knowledge_document` | write | `ai:write` | `title`, `content?`, `url?` | Add a document to the AI knowledge base from text (content) or from a public https page (url): exactly one of them. |
| `delete_knowledge_document` | **destructive** | `ai:write` | `document_id` | Permanently delete a knowledge-base document and its chunks, so the assistant stops using it. |
| `reindex_knowledge` | write | `ai:write` | `document_id?` | Re-chunk and re-embed knowledge documents. |
| `draft_reply` | write | `ai:write` | `conversation_id` | Draft a suggested reply for a conversation with the account's AI assistant. |
| `run_ai_playground` | write | `ai:write` | `message?`, `messages?` | Ask the AI assistant a test question exactly as a customer would (knowledge-base retrieval + auto-reply prompt) without touching WhatsApp. |
| `get_ai_usage` | read | `ai:read` | `days?` | Token usage of the AI assistant over the last N days (1-90, default 30): totals, split by auto-reply vs draft and by model, plus a per-day series. |

## WhatsApp settings, notifications and webhooks

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `get_whatsapp_status` | read | `settings:read` | — | Show the connected WhatsApp number: display number, verified (display) name, quality rating, messaging-limit tier, name status, connection state and registration state. |
| `verify_whatsapp_registration` | write | `settings:write` | — | Run the live registration check against Meta: phone metadata reachable, WABA subscribed to this app, and the local registration stamp. |
| `get_business_profile` | read | `settings:read` | — | Read the WhatsApp business profile shown to customers: about text, address, description, email, websites and industry. |
| `update_business_profile` | write | `settings:write` | `about?`, `address?`, `description?`, `email?`, `websites?` | Change the WhatsApp business profile customers see: about (max 139 chars), address, description, email, websites (max 2, replaces the list). |
| `list_notifications` | read | `settings:read` | `unread_only?`, `limit?`, `cursor?` | List the in-app notifications of the API key's owner (for example 'conversation assigned to you'), newest first. |
| `mark_notifications_read` | write | `settings:write` | `ids?`, `all?` | Mark the API key owner's notifications as read: pass ids (from list_notifications, max 100) or all: true for every unread one. |
| `list_webhook_endpoints` | read | `settings:read` | — | List the outgoing webhook endpoints (id, url, events, is_active, last delivery, failure count). |
| `create_webhook_endpoint` | write | `webhooks:manage` | `url`, `events` | Register an outgoing webhook: wacrm will POST signed JSON events to the https url. |
| `update_webhook_endpoint` | write | `webhooks:manage` | `webhook_id`, `url?`, `events?`, `is_active?` | Change a webhook endpoint: url, events or is_active. |
| `delete_webhook_endpoint` | **destructive** | `webhooks:manage` | `webhook_id` | Permanently delete a webhook endpoint; its receiver stops getting events and the signing secret is lost. |
| `send_test_webhook` | write | `webhooks:manage` | `webhook_id` | Send one signed 'webhook.test' event to an endpoint and report the HTTP status it answered. |

## Shopify orders and order updates

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `get_shopify_status` | read | `commerce:read` | — | Is Shopify connected, is test mode on (and which numbers are allowed, masked), are Admin API credentials saved and what scopes they have, and when each integration (Shopify, FlexyPe, Shiprocket) last delivered a webhook. |
| `search_orders` | read | `commerce:read` | `order_number?`, `status?`, `payment_mode?`, `from?`, `to?`, `limit?`, `cursor?` | Search Shopify orders stored in the CRM, newest first. |
| `get_order` | read | `commerce:read` | `order_id?`, `order_number?` | One order with its shipments (tracking and shipment status), the order-update messages sent or scheduled for it, and the tags on its contact. |
| `list_contact_orders` | read | `commerce:read` | `contact_id`, `limit?`, `cursor?` | The Shopify orders placed by one contact, newest first. contact_id is a CRM contact uuid (from the contacts tools). |
| `list_order_update_events` | read | `commerce:read` | `event?`, `only_enabled?` | Every WhatsApp order update (order created, tracking added, out for delivery, delivered, cancelled, cart reminders) with its on/off switch, template, delay in minutes and variable mapping, once per payment variant (all / cod /… |
| `get_order_update_event` | read | `commerce:read` | `event`, `variant?`, `step?` | One order update for a payment variant: its first message (step 0) and any follow-up steps, with template mapping, delays and on/off. |
| `update_order_update_event` | write | `commerce:write` | `event`, `variant?`, `step?`, `is_enabled?`, `template_name?`, `template_language?`, `delay_minutes?`, `variable_mapping?` | Change one order-update message: switch on/off, template, language, delay_minutes and variable_mapping. |
| `set_shopify_test_mode` | write | `commerce:write` | `enabled`, `test_numbers?` | Turn Shopify test mode on or off and optionally replace the list of test numbers (max 5, include the country code or the store default is used). |
| `send_order_update_test` | write | `commerce:write` | `event`, `variant?`, `step?`, `phone`, `source?` | Send one order-update message right now to a number you choose, using the saved template of that event / variant / step and values from your latest order (or sample values). |
| `list_notification_log` | read | `commerce:read` | `status?`, `event?`, `order_number?`, `include_tests?`, `limit?`, `cursor?` | Recent Shopify-triggered WhatsApp sends, newest first: sent, scheduled, skipped, failed or cancelled with the reason why. |
| `list_webhook_events` | read | `commerce:read` | `status?`, `topic?`, `order_number?`, `limit?`, `cursor?` | Recent webhook deliveries from Shopify (kept 30 days), newest first, with topic, status (received / processed / ignored / rejected / error), the reason and what each produced. |
| `replay_webhook_event` | **destructive** | `commerce:write` | `event_id` | Re-run one logged Shopify webhook through the order-update engine, as if Shopify had just sent it. |
| `tag_delivered_customers` | write | `commerce:write` | `cursor?` | Tag the customers of past Shopify orders: "Order Delivered" for delivered ones and "Order RTO" for returned ones. |

## Reports

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `get_dashboard_summary` | read | `reports:read` | `days?`, `from?`, `to?` | Headline numbers for a date range: conversations opened and closed, conversations open now, new contacts, messages per day (inbound / outbound) and average / median response time in minutes. |
| `get_broadcast_performance` | read | `reports:read` | `days?`, `from?`, `to?`, `limit?` | Delivery, read and reply counts and rates for recent broadcasts in a date range, newest first. |
| `get_top_tags` | read | `reports:read` | `limit?` | The most used tags with how many customer contacts carry each (staff contacts excluded). |
| `get_deal_value_by_stage` | read | `reports:read` | `status?` | Number of deals and their total value in every pipeline stage, for deals with the given status (default open). |
| `get_spend_report` | read | `reports:read` | `days?`, `from?`, `to?` | Estimated WhatsApp message spend from the charges ledger (the Transaction Details data): totals, by month, by Meta pricing category (marketing, utility, ...) and cost per broadcast. |
| `get_agent_performance` | read | `reports:read` | `days?`, `from?`, `to?` | Per team member: conversations assigned (chats handled), how many are closed, and first-response time (average / median minutes) for human replies. |

## Ops: orders, staff, NDR, events, ERP tag sync

| Tool | Tier | Scope | Arguments | What it does |
|---|---|---|---|---|
| `find_by_order` | read | `ops:read` | `query` | Look up an order by order number (#EL2204 or EL2204) or an AWB / tracking number. |
| `set_contact_staff` | write | `ops:write` | `contact_id`, `is_staff` | Flag (or unflag) a contact as an internal team member. |
| `list_staff_contacts` | read | `ops:read` | — | List the contacts flagged as staff: id, name and whether they messaged in the last 24 hours (so a document can be sent as a normal message instead of a template). |
| `send_document_to_staff` | write | `ops:write` | `contact_id`, `url`, `caption?`, `filename?` | Send a PDF (shipping labels, manifest) to a contact flagged as staff. url must be a public https link to a PDF under 10 MB. Inside the 24-hour window it is a normal document message with caption and filename; outside it, the… |
| `list_ndr_requests` | read | `ops:read` | `state?`, `unresolved_only?`, `limit?`, `cursor?` | List non-delivery (NDR) requests, newest first: order number, contact_id, state (sent = waiting for the customer, answered, expired), answer (reattempt \| new_time \| other) and a short excerpt of their text.… |
| `resolve_ndr` | write | `ops:write` | `order_number`, `note?` | Mark the NDR request for an order as handled (for example after the ERP comment was posted or the courier was told). order_number is the order number, e.g. #EL2204. |
| `get_ndr_settings` | read | `ops:read` | — | Show whether the NDR message is switched on (default OFF) and which template it uses. |
| `update_ndr_settings` | write | `ops:write` | `enabled?`, `template_name?`, `template_language?` | Switch the NDR message on or off and choose its template. |
| `list_events_since` | read | `events:read` | `cursor?`, `since?`, `types?`, `limit?` | Poll for what happened since the last call, oldest first: inbound_message, button_reply, ndr_reply (customer answered the NDR message: carries the ORDER NUMBER, so you can post it as a comment on the ERP order),… |
| `get_tag_state` | read | `ops:read` | `tags`, `limit?`, `cursor?` | For each tag name (usually the sync tags: Order RTO, Blocked, Partial pay), list the contacts that carry it: contact_id, when it was added and their recent order numbers. |
| `apply_tag_changes` | write | `ops:write` | `add?`, `remove?` | Add and remove sync tags on contacts, given contact ids or order numbers (resolved to the order’s contact). |
| `get_ops_settings` | read | `ops:read` | — | Show the ops configuration: the sync tags the ERP tag sync may change, the staff document template (used outside the 24-hour window) and the NDR switch. |
| `update_ops_settings` | write | `ops:write` | `sync_tags?`, `staff_doc_template_name?`, `staff_doc_template_language?` | Change the sync tags (the tag names apply_tag_changes may touch) and/or the staff document template used by send_document_to_staff outside the 24-hour window (an APPROVED utility template with a DOCUMENT header). |
