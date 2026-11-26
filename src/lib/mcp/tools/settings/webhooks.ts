// Outgoing webhook endpoints. Reuses the v1 helpers (URL/events
// validation, secret generation, public serialization). The signing
// secret is returned exactly once, by create_webhook_endpoint.

import { z } from 'zod';

import { encrypt } from '@/lib/whatsapp/encryption';
import { WEBHOOK_EVENTS, normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  generateWebhookSecret,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { deliverTestWebhook } from '@/lib/webhooks/test-delivery';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../../types';

/** HTTPS only (as the v1 routes) and the host must resolve to a public address. */
async function validateUrl(raw: string): Promise<string> {
  const url = normalizeWebhookUrl(raw);
  if (!url) throw new McpToolError('invalid_input', "url must be a valid https:// URL", 'url');
  if (!(await isDeliverableUrl(url))) {
    throw new McpToolError('invalid_input', 'url must resolve to a public address (no localhost or private networks)', 'url');
  }
  return url;
}

function validateEvents(raw: string[]) {
  const events = normalizeEvents(raw);
  if (!events) {
    throw new McpToolError('invalid_input', `events must be a non-empty list of: ${WEBHOOK_EVENTS.join(', ')}`, 'events');
  }
  return events;
}

async function requireEndpoint(ctx: McpContext, id: string, columns = WEBHOOK_PUBLIC_COLUMNS) {
  const { data, error } = await ctx.supabase
    .from('webhook_endpoints')
    .select(columns)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new McpToolError('internal', 'Failed to load the webhook');
  if (!data) throw new McpToolError('not_found', 'Webhook not found. Use list_webhook_endpoints for ids.', 'webhook_id');
  return data as unknown as Record<string, unknown>;
}

const eventsSchema = z
  .array(z.string())
  .min(1)
  .describe(`Events to subscribe to. Known: ${WEBHOOK_EVENTS.join(', ')}.`);

export const webhookTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_webhook_endpoints',
    title: 'List webhook endpoints',
    description:
      'List the outgoing webhook endpoints (id, url, events, is_active, last delivery, failure count). Signing secrets are never returned. An endpoint auto-disables after repeated failures: re-enable it with update_webhook_endpoint.',
    scope: 'settings:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('webhook_endpoints')
        .select(WEBHOOK_PUBLIC_COLUMNS)
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false });
      if (error) throw new McpToolError('internal', 'Failed to list webhooks');
      return {
        items: (data ?? []).map((r) => serializeWebhookEndpoint(r as unknown as Record<string, unknown>)),
        next_cursor: null,
      };
    },
  }),

  defineTool({
    name: 'create_webhook_endpoint',
    title: 'Create webhook endpoint',
    description:
      'Register an outgoing webhook: wacrm will POST signed JSON events to the https url. The url must be https and public. The response includes the signing secret ONCE (verify X-Wacrm-Signature with it); it can never be shown again, so tell the user to store it. dry_run validates without creating.',
    scope: 'webhooks:manage',
    tier: 'write',
    input: { url: z.string().min(1), events: eventsSchema },
    handler: async (ctx, args) => {
      const url = await validateUrl(args.url);
      const events = validateEvents(args.events);
      if (ctx.dryRun) return { dry_run: true, would_create: { url, events } };

      const secret = generateWebhookSecret();
      const { data, error } = await ctx.supabase
        .from('webhook_endpoints')
        .insert({ account_id: ctx.accountId, created_by: ctx.createdBy, url, secret: encrypt(secret), events })
        .select(WEBHOOK_PUBLIC_COLUMNS)
        .single();
      if (error || !data) throw new McpToolError('internal', 'Failed to create the webhook');
      return {
        ...serializeWebhookEndpoint(data as unknown as Record<string, unknown>),
        secret,
        note: 'Store this secret now: it is shown only once.',
      };
    },
  }),

  defineTool({
    name: 'update_webhook_endpoint',
    title: 'Update webhook endpoint',
    description:
      'Change a webhook endpoint: url, events or is_active. Re-enabling (is_active true) clears its failure streak. Get the id from list_webhook_endpoints. dry_run shows the change without applying it.',
    scope: 'webhooks:manage',
    tier: 'write',
    input: {
      webhook_id: z.string().uuid(),
      url: z.string().min(1).optional(),
      events: eventsSchema.optional(),
      is_active: z.boolean().optional(),
    },
    handler: async (ctx, args) => {
      const current = await requireEndpoint(ctx, args.webhook_id);
      const updates: Record<string, unknown> = {};
      if (args.url !== undefined) updates.url = await validateUrl(args.url);
      if (args.events !== undefined) updates.events = validateEvents(args.events);
      if (args.is_active !== undefined) {
        updates.is_active = args.is_active;
        if (args.is_active) updates.failure_count = 0;
      }
      if (Object.keys(updates).length === 0) {
        throw new McpToolError('invalid_input', 'Provide at least one of url, events or is_active.');
      }
      if (ctx.dryRun) {
        return { dry_run: true, id: current.id, would_change: updates };
      }
      const { data, error } = await ctx.supabase
        .from('webhook_endpoints')
        .update(updates)
        .eq('id', args.webhook_id)
        .eq('account_id', ctx.accountId)
        .select(WEBHOOK_PUBLIC_COLUMNS)
        .maybeSingle();
      if (error) throw new McpToolError('internal', 'Failed to update the webhook');
      if (!data) throw new McpToolError('not_found', 'Webhook not found.', 'webhook_id');
      return serializeWebhookEndpoint(data as unknown as Record<string, unknown>);
    },
  }),

  defineTool({
    name: 'delete_webhook_endpoint',
    title: 'Delete webhook endpoint',
    description:
      'Permanently delete a webhook endpoint; its receiver stops getting events and the signing secret is lost. Cannot be undone (to pause instead, set is_active false with update_webhook_endpoint). Needs confirm: true (or dry_run: true).',
    scope: 'webhooks:manage',
    tier: 'destructive',
    input: { webhook_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const current = await requireEndpoint(ctx, args.webhook_id);
      if (ctx.dryRun) return { dry_run: true, would_delete: { id: current.id, url: current.url } };
      const { error } = await ctx.supabase
        .from('webhook_endpoints')
        .delete()
        .eq('id', args.webhook_id)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError('internal', 'Failed to delete the webhook');
      return { ok: true, deleted: args.webhook_id };
    },
  }),

  defineTool({
    name: 'send_test_webhook',
    title: 'Send test webhook',
    description:
      "Send one signed 'webhook.test' event to an endpoint and report the HTTP status it answered. Uses the same signing and public-address rules as real deliveries and does NOT count toward the endpoint's failure streak. Write-tier because it makes an outbound request to the customer's server. dry_run only shows the target.",
    scope: 'webhooks:manage',
    tier: 'write',
    input: { webhook_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const row = await requireEndpoint(ctx, args.webhook_id, 'id, url, secret');
      if (ctx.dryRun) return { dry_run: true, would_post_to: row.url, event: 'webhook.test' };
      return deliverTestWebhook(ctx.accountId, {
        id: row.id as string,
        url: row.url as string,
        secret: row.secret as string,
      });
    },
  }),
];
