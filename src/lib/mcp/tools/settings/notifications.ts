// In-app notifications. They are per user: the "user" is the team member
// who minted the API key (ctx.createdBy).

import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../../types';

function recipient(ctx: McpContext): string {
  if (!ctx.createdBy) {
    throw new McpToolError('invalid_input', 'This API key has no owning user, so it has no notifications.');
  }
  return ctx.createdBy;
}

export const notificationTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_notifications',
    title: 'List notifications',
    description:
      "List the in-app notifications of the API key's owner (for example 'conversation assigned to you'), newest first. Set unread_only to see what needs attention. Returns { items, unread_count, next_cursor }; each item has id, type, title, body, conversation_id, read_at. Use mark_notifications_read with the ids.",
    scope: 'settings:read',
    tier: 'read',
    input: {
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 25).'),
      cursor: z.string().optional().describe('Opaque cursor from a previous next_cursor.'),
    },
    handler: async (ctx, args) => {
      const userId = recipient(ctx);
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('notifications')
        .select('id, type, title, body, conversation_id, contact_id, read_at, created_at')
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (args.unread_only) q = q.is('read_at', null);
      const f = keysetFilter(decodeCursor(args.cursor ?? null));
      if (f) q = q.or(f);
      const { data, error } = await q;
      if (error) throw new McpToolError('internal', 'Failed to load notifications');

      const { count } = await ctx.supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .is('read_at', null);

      const page = buildPage((data ?? []) as Array<{ created_at: string; id: string }>, limit);
      return { items: page.items, unread_count: count ?? 0, next_cursor: page.nextCursor };
    },
  }),

  defineTool({
    name: 'mark_notifications_read',
    title: 'Mark notifications read',
    description:
      "Mark the API key owner's notifications as read: pass ids (from list_notifications, max 100) or all: true for every unread one. Only the owner's own notifications are touched. dry_run reports how many would change.",
    scope: 'settings:write',
    tier: 'write',
    input: {
      ids: z.array(z.string().uuid()).min(1).max(100).optional(),
      all: z.boolean().optional().describe('Mark every unread notification read.'),
    },
    handler: async (ctx, args) => {
      const userId = recipient(ctx);
      if (!!args.ids?.length === (args.all === true)) {
        throw new McpToolError('invalid_input', 'Provide either ids or all: true.');
      }
      let sel = ctx.supabase
        .from('notifications')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .is('read_at', null);
      if (args.ids) sel = sel.in('id', args.ids);
      const { data: unread, error } = await sel;
      if (error) throw new McpToolError('internal', 'Failed to load notifications');
      const ids = ((unread ?? []) as Array<{ id: string }>).map((r) => r.id);

      if (ctx.dryRun) return { dry_run: true, would_mark_read: ids.length };
      if (ids.length === 0) return { ok: true, marked_read: 0 };

      const { error: upErr } = await ctx.supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
        .in('id', ids);
      if (upErr) throw new McpToolError('internal', 'Failed to update notifications');
      return { ok: true, marked_read: ids.length };
    },
  }),
];
