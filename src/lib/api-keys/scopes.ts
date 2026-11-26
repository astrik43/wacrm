// ============================================================
// API key scopes — pure, unit-testable, no I/O.
//
// Authorization for the public API is *scopes-only*: a key's
// capabilities are defined entirely by the scopes granted to it at
// creation, independent of the role of the user who minted it. (We
// still gate *key creation* at admin+, so only trusted members can
// hand out capabilities — see the management routes.)
//
// A scope is `<resource>:<action>`. Endpoints declare the single
// scope they require; `requireApiKey(request, scope)` enforces it.
// Adding a capability = one entry here + the endpoint that checks
// it. No migration needed (the DB stores scopes as a free `text[]`).
// ============================================================

export const API_SCOPES = [
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'broadcasts:send',
  'webhooks:manage',
  // ── MCP 2.0 (docs/mcp-2.0-plan.md) ─────────────────────────
  'account:read',
  'team:read',
  'team:write',
  'tags:read',
  'tags:write',
  'notes:read',
  'notes:write',
  'conversations:write',
  'templates:read',
  'templates:write',
  'broadcasts:read',
  'deals:read',
  'deals:write',
  'automations:read',
  'automations:write',
  'flows:read',
  'flows:write',
  'ai:read',
  'ai:write',
  'commerce:read',
  'commerce:write',
  'reports:read',
  'settings:read',
  'settings:write',
  'ops:read',
  'ops:write',
  'events:read',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Human-readable descriptions, surfaced in the key-creation UI. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  'messages:send': 'Send WhatsApp messages',
  'messages:read': 'Read messages and their delivery status',
  'contacts:read': 'List and read contacts',
  'contacts:write': 'Create and update contacts',
  'conversations:read': 'List and read conversations',
  'broadcasts:send': 'Launch broadcast campaigns',
  'webhooks:manage': 'Register and manage outbound event webhooks',
  'account:read': 'Read account details, plan and WhatsApp number status',
  'team:read': 'List team members and roles',
  'team:write': 'Invite, change roles of and remove team members',
  'tags:read': 'List tags and their contact counts',
  'tags:write': 'Create, rename and delete tags; tag and untag contacts',
  'notes:read': "Read a contact's notes",
  'notes:write': "Add, edit and delete a contact's notes",
  'conversations:write': 'Assign, close and reopen conversations; manage quick replies',
  'templates:read': 'List and preview message templates',
  'templates:write': 'Create, submit, sync and delete message templates',
  'broadcasts:read': 'List broadcasts, their stats and recipients; estimate audiences',
  'deals:read': 'Read pipelines and deals',
  'deals:write': 'Create and update pipelines and deals',
  'automations:read': 'Read automations and their logs',
  'automations:write': 'Create, update, enable and delete automations',
  'flows:read': 'Read chatbot flows and their runs',
  'flows:write': 'Create, edit and activate chatbot flows',
  'ai:read': 'Read the AI assistant config, knowledge base and usage',
  'ai:write': 'Change the AI assistant config and knowledge base',
  'commerce:read': 'Read Shopify orders, order updates and notification logs',
  'commerce:write': 'Change order-update settings; replay events; tag past orders',
  'reports:read': 'Read analytics, spend and agent performance reports',
  'settings:read': 'Read WhatsApp and workspace settings',
  'settings:write': 'Change WhatsApp business profile and workspace settings',
  'ops:read': 'Look up customers by order number or AWB; read staff and NDR state',
  'ops:write': 'Send documents to staff, run the NDR flow and sync tags with the ERP',
  'events:read': 'Read the event feed (inbound replies, order events, tag changes)',
};

/** Type-narrow an unknown value into a valid `ApiScope`. */
export function isApiScope(value: unknown): value is ApiScope {
  return (
    typeof value === 'string' &&
    (API_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Validate and de-duplicate a caller-supplied scope list. Returns
 * the cleaned list, or `null` if any entry is not a known scope
 * (callers turn that into a 400). An empty input is valid — it
 * yields a key that authenticates but can't do anything beyond the
 * scope-free endpoints (e.g. `GET /api/v1/me`).
 */
export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input)) return null;
  const out: ApiScope[] = [];
  for (const entry of input) {
    if (!isApiScope(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * True iff `granted` contains `required`. The single source of
 * truth for "is this key allowed to do X?" — both `requireApiKey`
 * and any future inline check should call this rather than poking
 * at the array directly.
 */
export function hasScope(
  granted: readonly string[],
  required: ApiScope
): boolean {
  return granted.includes(required);
}
