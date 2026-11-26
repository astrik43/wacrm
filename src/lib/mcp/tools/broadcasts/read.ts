// Broadcast read tools (scope broadcasts:read). Nothing here changes data.

import { z } from 'zod';

import { resolveServerAudience } from '@/lib/broadcasts/audience';
import { BROADCAST_MAX_RECIPIENTS, estimateBroadcastCost } from '@/lib/broadcasts/payload';
import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';
import {
  BROADCAST_COLUMNS,
  audienceSchema,
  loadBroadcast,
  mapError,
  presentBroadcast,
  toServerAudience,
} from './common';

const RECIPIENT_STATUSES = ['pending', 'sent', 'delivered', 'read', 'replied', 'failed'] as const;
const RECIPIENT_COLUMNS =
  'id, contact_id, status, sent_at, delivered_at, read_at, replied_at, error_message, created_at, contact:contacts(name)';

/** Estimates look at up to this many contacts; beyond it the count is a floor. */
const ESTIMATE_CAP = 20000;
/** Rows an export returns in one call. */
export const EXPORT_MAX_ROWS = 5000;

const limitSchema = z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100).');
const cursorSchema = z.string().optional().describe('The next_cursor from the previous page.');

function contactName(row: Record<string, unknown>): string | null {
  const c = row.contact as { name?: string | null } | { name?: string | null }[] | null | undefined;
  const one = Array.isArray(c) ? c[0] : c;
  return one?.name ?? null;
}

function presentRecipient(row: Record<string, unknown>) {
  return {
    id: row.id,
    contact_id: row.contact_id,
    contact_name: contactName(row),
    status: row.status,
    sent_at: row.sent_at ?? null,
    delivered_at: row.delivered_at ?? null,
    read_at: row.read_at ?? null,
    replied_at: row.replied_at ?? null,
    error: row.error_message ?? null,
  };
}

/** Spreadsheet apps run a cell that starts with these as a formula. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const broadcastReadTools = [
  defineTool({
    name: 'list_broadcasts',
    title: 'List broadcasts',
    description:
      'List broadcasts, newest first, each with its funnel (sent, delivered, read, replied, failed). Filter by status. Use get_broadcast_recipients for who got what.',
    scope: 'broadcasts:read',
    tier: 'read',
    input: {
      status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(),
      limit: limitSchema,
      cursor: cursorSchema,
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('broadcasts')
        .select(BROADCAST_COLUMNS)
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (args.status) q = q.eq('status', args.status);
      const filter = keysetFilter(decodeCursor(args.cursor ?? null));
      if (filter) q = q.or(filter);
      const { data, error } = await q;
      if (error) throw new McpToolError('internal', 'Failed to list broadcasts');
      const page = buildPage((data ?? []) as unknown as { created_at: string; id: string }[], limit);
      return {
        items: page.items.map((r) => presentBroadcast(r as unknown as Record<string, unknown>)),
        next_cursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: 'get_broadcast',
    title: 'Get a broadcast',
    description:
      'One broadcast with its funnel and the template and variable mapping it uses. Use it to watch a send in progress: status moves sending to sent, and delivered/read keep climbing.',
    scope: 'broadcasts:read',
    tier: 'read',
    input: { broadcast_id: z.string().uuid().describe('Broadcast id from list_broadcasts.') },
    handler: async (ctx, args) => {
      const row = await loadBroadcast(
        ctx,
        args.broadcast_id,
        `${BROADCAST_COLUMNS}, template_variables, audience_filter`
      );
      return {
        ...presentBroadcast(row),
        template_variables: row.template_variables ?? {},
        audience_filter: row.audience_filter ?? {},
      };
    },
  }),

  defineTool({
    name: 'get_broadcast_recipients',
    title: 'Broadcast recipients',
    description:
      'Recipients of one broadcast with their delivery status and any error, newest first. Filter by status (for example failed, to see what to retry). Phone numbers are never returned; use contact_id.',
    scope: 'broadcasts:read',
    tier: 'read',
    input: {
      broadcast_id: z.string().uuid(),
      status: z.enum(RECIPIENT_STATUSES).optional(),
      limit: limitSchema,
      cursor: cursorSchema,
    },
    handler: async (ctx, args) => {
      await loadBroadcast(ctx, args.broadcast_id, 'id');
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('broadcast_recipients')
        .select(RECIPIENT_COLUMNS)
        .eq('broadcast_id', args.broadcast_id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (args.status) q = q.eq('status', args.status);
      const filter = keysetFilter(decodeCursor(args.cursor ?? null));
      if (filter) q = q.or(filter);
      const { data, error } = await q;
      if (error) throw new McpToolError('internal', 'Failed to list recipients');
      const page = buildPage((data ?? []) as unknown as { created_at: string; id: string }[], limit);
      return {
        items: page.items.map((r) => presentRecipient(r as unknown as Record<string, unknown>)),
        next_cursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: 'export_broadcast_recipients',
    title: 'Export broadcast recipients',
    description: `Recipients of one broadcast as CSV text (recipient_id, contact_id, contact_name, status, sent_at, delivered_at, read_at, replied_at, error), up to ${EXPORT_MAX_ROWS} rows. No phone numbers. Optionally filter by status.`,
    scope: 'broadcasts:read',
    tier: 'read',
    input: {
      broadcast_id: z.string().uuid(),
      status: z.enum(RECIPIENT_STATUSES).optional(),
    },
    handler: async (ctx, args) => {
      await loadBroadcast(ctx, args.broadcast_id, 'id');
      const rows: Record<string, unknown>[] = [];
      let truncated = false;
      for (let from = 0; ; from += 1000) {
        let q = ctx.supabase
          .from('broadcast_recipients')
          .select(RECIPIENT_COLUMNS)
          .eq('broadcast_id', args.broadcast_id)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + 999);
        if (args.status) q = q.eq('status', args.status);
        const { data, error } = await q;
        if (error) throw new McpToolError('internal', 'Failed to export recipients');
        const page = (data ?? []) as Record<string, unknown>[];
        rows.push(...page);
        if (page.length < 1000 || rows.length > EXPORT_MAX_ROWS) break;
      }
      if (rows.length > EXPORT_MAX_ROWS) {
        truncated = true;
        rows.length = EXPORT_MAX_ROWS;
      }
      const header = [
        'recipient_id',
        'contact_id',
        'contact_name',
        'status',
        'sent_at',
        'delivered_at',
        'read_at',
        'replied_at',
        'error',
      ];
      const lines = rows.map((r) => {
        const p = presentRecipient(r);
        return [p.id, p.contact_id, p.contact_name, p.status, p.sent_at, p.delivered_at, p.read_at, p.replied_at, p.error]
          .map(csvCell)
          .join(',');
      });
      return {
        row_count: rows.length,
        truncated,
        csv: [header.join(','), ...lines].join('\n'),
      };
    },
  }),

  defineTool({
    name: 'estimate_audience',
    title: 'Estimate an audience',
    description:
      'Count who a broadcast would reach and show a few names, without sending anything. Audience: all, tags (any of), custom field, explicit contact ids or a phone list; staff contacts are always excluded. Pass template_name to also get an estimated Meta cost. Use it before send_broadcast.',
    scope: 'broadcasts:read',
    tier: 'read',
    input: {
      audience: audienceSchema,
      template_name: z.string().optional().describe('Approved template name, to estimate the cost.'),
      template_language: z.string().optional(),
    },
    handler: async (ctx, args) => {
      let resolved;
      try {
        resolved = await resolveServerAudience(ctx.supabase, ctx.accountId, toServerAudience(args.audience), {
          cap: ESTIMATE_CAP,
        });
      } catch (err) {
        mapError(err);
      }
      const count = resolved.contacts.length;

      let cost: unknown = null;
      let costNote: string | undefined;
      if (args.template_name) {
        const t = await resolveTemplateRow(ctx.supabase, ctx.accountId, args.template_name, args.template_language);
        if (!t.row) {
          costNote = `Template '${args.template_name}' not found, so the cost could not be estimated.`;
        } else {
          cost = estimateBroadcastCost(t.row.category, count);
          if (!cost) costNote = `No rate is known for the '${t.row.category}' category, so the cost could not be estimated.`;
        }
      } else {
        costNote = 'Pass template_name to get an estimated cost.';
      }

      return {
        recipients: count,
        count_is_floor: resolved.capped,
        over_send_limit: count > BROADCAST_MAX_RECIPIENTS,
        send_limit_per_call: BROADCAST_MAX_RECIPIENTS,
        staff_excluded: resolved.staffExcluded,
        phones_without_contact: resolved.unmatchedPhones,
        sample_names: resolved.contacts.slice(0, 5).map((c) => c.name ?? '(no name)'),
        estimated_cost: cost,
        ...(costNote ? { cost_note: costNote } : {}),
      };
    },
  }),
];
