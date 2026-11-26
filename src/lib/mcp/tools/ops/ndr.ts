// NDR (non-delivery) flow: settings, the request list and "handled".
// The sending and the reply matching live in src/lib/ops/ndr.ts; the
// agent reads replies from list_events_since (ndr_reply) and writes
// the ERP comment itself.

import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';
import { NDR_EXPIRY_MS } from '@/lib/ops/ndr';
import { excerpt, getOpsSettings, orderNameVariants, saveOpsSettings } from '@/lib/ops/settings';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';

type Row = Record<string, unknown>;

function present(r: Row) {
  const sentAt = r.sent_at as string | null;
  const stale =
    r.state === 'sent' && !!sentAt && Date.now() - Date.parse(sentAt) > NDR_EXPIRY_MS;
  return {
    id: r.id,
    order_number: r.order_name,
    contact_id: r.contact_id ?? null,
    state: stale ? 'expired' : r.state,
    answer: r.answer ?? null,
    answer_text: excerpt(r.answer_text),
    sent_at: sentAt,
    replied_at: r.replied_at ?? null,
    resolved_at: r.resolved_at ?? null,
    resolved_note: excerpt(r.resolved_note),
  };
}

export const ndrTools = [
  defineTool({
    name: 'list_ndr_requests',
    title: 'List NDR requests',
    description:
      'List non-delivery (NDR) requests, newest first: order number, contact_id, state (sent = waiting for the customer, answered, expired), answer (reattempt | new_time | other) and a short excerpt of their text. unresolved_only=true shows the ones nobody has marked handled (resolve_ndr). For a free-text answer (other) a person should follow up.',
    scope: 'ops:read',
    tier: 'read',
    input: {
      state: z.enum(['sent', 'answered', 'expired']).optional(),
      unresolved_only: z.boolean().optional().describe('Only requests not yet marked handled.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
      cursor: z.string().optional().describe('next_cursor from the previous page.'),
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('ndr_requests')
        .select(
          'id, order_name, contact_id, state, answer, answer_text, sent_at, replied_at, resolved_at, resolved_note, created_at'
        )
        .eq('account_id', ctx.accountId);
      if (args.state) q = q.eq('state', args.state);
      if (args.unresolved_only) q = q.is('resolved_at', null);
      const filter = keysetFilter(decodeCursor(args.cursor ?? null));
      if (filter) q = q.or(filter);
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (error) throw new McpToolError('internal', 'Could not list NDR requests.');
      const page = buildPage((data as { created_at: string; id: string }[]) ?? [], limit);
      return { items: page.items.map((r) => present(r as unknown as Row)), next_cursor: page.nextCursor };
    },
  }),

  defineTool({
    name: 'resolve_ndr',
    title: 'Mark an NDR handled',
    description:
      'Mark the NDR request for an order as handled (for example after the ERP comment was posted or the courier was told). order_number is the order number, e.g. #EL2204. Optional note (stored, max 300 chars).',
    scope: 'ops:write',
    tier: 'write',
    input: {
      order_number: z.string().min(1).max(40),
      note: z.string().max(300).optional(),
    },
    handler: async (ctx, args) => {
      const { data, error } = await ctx.supabase
        .from('ndr_requests')
        .select('id, order_name, resolved_at')
        .eq('account_id', ctx.accountId)
        .in('order_name', orderNameVariants(args.order_number))
        .limit(1);
      if (error) throw new McpToolError('internal', 'Could not read the NDR request.');
      const row = ((data as Row[] | null) ?? [])[0];
      if (!row) {
        throw new McpToolError('not_found', 'No NDR request for that order number.', 'order_number');
      }
      if (ctx.dryRun) {
        return { order_number: row.order_name, would_resolve: true, already_resolved: !!row.resolved_at };
      }
      const { error: updateError } = await ctx.supabase
        .from('ndr_requests')
        .update({ resolved_at: new Date().toISOString(), resolved_note: args.note ?? null })
        .eq('id', row.id as string)
        .eq('account_id', ctx.accountId);
      if (updateError) throw new McpToolError('internal', 'Could not update the NDR request.');
      return { order_number: row.order_name, resolved: true };
    },
  }),

  defineTool({
    name: 'get_ndr_settings',
    title: 'Get NDR settings',
    description:
      'Show whether the NDR message is switched on (default OFF) and which template it uses. The template should be approved, take the order number as {{1}} and offer "reply 1 to reattempt, 2 for a new time".',
    scope: 'ops:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const s = await getOpsSettings(ctx.supabase, ctx.accountId);
      return {
        enabled: s.ndr_enabled,
        template_name: s.ndr_template_name,
        template_language: s.ndr_template_language,
      };
    },
  }),

  defineTool({
    name: 'update_ndr_settings',
    title: 'Update NDR settings',
    description:
      'Switch the NDR message on or off and choose its template. Turning it on makes wacrm message real customers when a courier reports a failed delivery (once per order; Shopify test mode and staff are respected), so the template must exist and be APPROVED. Use dry_run to check first.',
    scope: 'ops:write',
    tier: 'write',
    input: {
      enabled: z.boolean().optional(),
      template_name: z.string().min(1).max(512).optional(),
      template_language: z.string().min(2).max(10).optional(),
    },
    handler: async (ctx, args) => {
      const current = await getOpsSettings(ctx.supabase, ctx.accountId);
      const next = {
        ndr_enabled: args.enabled ?? current.ndr_enabled,
        ndr_template_name: args.template_name ?? current.ndr_template_name,
        ndr_template_language: args.template_language ?? current.ndr_template_language,
      };
      if (next.ndr_enabled) {
        if (!next.ndr_template_name) {
          throw new McpToolError(
            'invalid_input',
            'Choose a template_name before turning the NDR message on.',
            'template_name'
          );
        }
        const resolved = await resolveTemplateRow(
          ctx.supabase,
          ctx.accountId,
          next.ndr_template_name,
          next.ndr_template_language
        );
        if (!resolved.row || resolved.malformed) {
          throw new McpToolError(
            'not_found',
            `Template "${next.ndr_template_name}" was not found. Run sync_templates or create it first.`,
            'template_name'
          );
        }
        if (resolved.row.status !== 'APPROVED') {
          throw new McpToolError(
            'template_not_approved',
            `Template "${next.ndr_template_name}" is ${resolved.row.status ?? 'not approved'} and cannot be sent yet.`,
            'template_name'
          );
        }
      }
      if (ctx.dryRun) return { dry_run: true, would_set: next };
      await saveOpsSettings(ctx.supabase, ctx.accountId, next);
      return {
        enabled: next.ndr_enabled,
        template_name: next.ndr_template_name,
        template_language: next.ndr_template_language,
      };
    },
  }),
];
