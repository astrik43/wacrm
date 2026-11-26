// Inbox read tools (conversations:read). Nothing here sends or changes data.

import { z } from 'zod';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';
import { decodeCursor } from '@/lib/api/v1/pagination';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import { getReplyWindow } from '@/lib/whatsapp/reply-window';
import { loadConversation, loadMessage } from './common';

const limitShape = z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100).');
const cursorShape = z.string().optional().describe('Opaque cursor from the previous page\'s next_cursor.');

const PROXY_PREFIX = '/api/whatsapp/media/';

/** Expose a stored media pointer without leaking anything fetchable-only-with-a-session. */
function mediaOf(m: { media_url: string | null; media_type?: string | null; content_type: string }) {
  if (!m.media_url) return null;
  const isPublic = /^https?:\/\//i.test(m.media_url);
  return {
    kind: m.content_type,
    mime_type: m.media_type ?? null,
    url: isPublic ? m.media_url : null,
    // A pointer into Meta's media store (not mirrored): metadata only via get_media_info.
    meta_media_id: m.media_url.startsWith(PROXY_PREFIX)
      ? m.media_url.slice(PROXY_PREFIX.length)
      : null,
  };
}

export const inboxReadTools = [
  defineTool({
    name: 'list_conversations_filtered',
    title: 'List conversations',
    description:
      'List inbox conversations, most recently active first, with filters: status (open/pending/closed), assignee (agent_id from list_team_members, or unassigned=true), unread_only, tag_id (contact tag), and a last-activity window (active_after / active_before, ISO datetimes). Returns ids, contact name, last message preview, unread count, assignee and status, no phone numbers. Page with next_cursor. Use get_conversation_thread for the messages.',
    scope: 'conversations:read',
    tier: 'read',
    input: {
      status: z.enum(['open', 'pending', 'closed']).optional(),
      agent_id: z.string().uuid().optional().describe('Only conversations assigned to this team member.'),
      unassigned: z.boolean().optional().describe('Only conversations with no assignee.'),
      unread_only: z.boolean().optional(),
      tag_id: z.string().uuid().optional().describe('Only contacts that carry this tag (id from list_tags).'),
      active_after: z.string().datetime().optional().describe('Last message at or after this time.'),
      active_before: z.string().datetime().optional().describe('Last message before this time.'),
      limit: limitShape,
      cursor: cursorShape,
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('conversations')
        .select('id, contact_id, status, assigned_agent_id, unread_count, last_message_text, last_message_at')
        .eq('account_id', ctx.accountId)
        .not('last_message_at', 'is', null);

      if (args.status) q = q.eq('status', args.status);
      if (args.unassigned) q = q.is('assigned_agent_id', null);
      else if (args.agent_id) q = q.eq('assigned_agent_id', args.agent_id);
      if (args.unread_only) q = q.gt('unread_count', 0);
      if (args.active_after) q = q.gte('last_message_at', args.active_after);
      if (args.active_before) q = q.lt('last_message_at', args.active_before);

      if (args.tag_id) {
        const { data: tag } = await ctx.supabase
          .from('tags')
          .select('id')
          .eq('id', args.tag_id)
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        if (!tag) throw new McpToolError('not_found', 'Tag not found.', 'tag_id');
        const { data: links } = await ctx.supabase
          .from('contact_tags')
          .select('contact_id')
          .eq('tag_id', args.tag_id);
        const contactIds = ((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id);
        if (contactIds.length === 0) return { items: [], next_cursor: null };
        q = q.in('contact_id', contactIds);
      }

      // Keyset on (last_message_at desc, id desc). The cursor reuses the
      // shared encoding: `createdAt` carries last_message_at.
      const cursor = args.cursor ? decodeCursor(args.cursor) : null;
      if (cursor) {
        q = q.or(
          `last_message_at.lt.${cursor.createdAt},and(last_message_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
        );
      }
      const { data, error } = await q
        .order('last_message_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (error) throw new McpToolError('internal', 'Failed to list conversations.');

      const rows = (data ?? []) as {
        id: string;
        contact_id: string;
        status: string;
        assigned_agent_id: string | null;
        unread_count: number | null;
        last_message_text: string | null;
        last_message_at: string;
      }[];
      const page = rows.slice(0, limit);
      const next =
        rows.length > limit
          ? Buffer.from(`${page[page.length - 1].last_message_at}|${page[page.length - 1].id}`, 'utf8').toString('base64url')
          : null;

      const contactIds = [...new Set(page.map((r) => r.contact_id))];
      const names = new Map<string, string | null>();
      if (contactIds.length > 0) {
        const { data: contacts } = await ctx.supabase
          .from('contacts')
          .select('id, name')
          .eq('account_id', ctx.accountId)
          .in('id', contactIds);
        for (const c of (contacts ?? []) as { id: string; name: string | null }[]) {
          names.set(c.id, c.name);
        }
      }

      return {
        items: page.map((r) => ({
          conversation_id: r.id,
          contact_id: r.contact_id,
          contact_name: names.get(r.contact_id) ?? null,
          status: r.status,
          assigned_agent_id: r.assigned_agent_id,
          unread_count: r.unread_count ?? 0,
          last_message_text: r.last_message_text,
          last_message_at: r.last_message_at,
        })),
        next_cursor: next,
      };
    },
  }),

  defineTool({
    name: 'get_conversation_thread',
    title: 'Read a conversation',
    description:
      'Read the messages of one conversation (conversation_id from list_conversations_filtered), oldest first within the page, newest page first. Each message has direction, sender type, text, media metadata (kind, mime type, a url when it is publicly fetchable; otherwise use get_media_info), template name, delivery status, and emoji reactions. Also returns the 24-hour reply window. Page backwards in time with next_cursor.',
    scope: 'conversations:read',
    tier: 'read',
    input: {
      conversation_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).optional().describe('Messages per page (default 30, max 100).'),
      cursor: cursorShape,
    },
    handler: async (ctx, args) => {
      const conv = await loadConversation(ctx, args.conversation_id);
      const limit = args.limit ?? 30;

      let q = ctx.supabase
        .from('messages')
        .select(
          'id, sender_type, content_type, content_text, media_url, media_type, template_name, status, error_title, reply_to_message_id, interactive_reply_id, ai_generated, created_at'
        )
        .eq('conversation_id', conv.id);
      const cursor = args.cursor ? decodeCursor(args.cursor) : null;
      if (cursor) {
        q = q.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
        );
      }
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (error) throw new McpToolError('internal', 'Failed to load messages.');

      type Row = {
        id: string;
        sender_type: string;
        content_type: string;
        content_text: string | null;
        media_url: string | null;
        media_type: string | null;
        template_name: string | null;
        status: string;
        error_title: string | null;
        reply_to_message_id: string | null;
        interactive_reply_id: string | null;
        ai_generated: boolean | null;
        created_at: string;
      };
      const rows = (data ?? []) as Row[];
      const page = rows.slice(0, limit);
      const nextCursor =
        rows.length > limit
          ? Buffer.from(`${page[page.length - 1].created_at}|${page[page.length - 1].id}`, 'utf8').toString('base64url')
          : null;

      const reactions = new Map<string, { emoji: string; actor_type: string }[]>();
      if (page.length > 0) {
        const { data: rx } = await ctx.supabase
          .from('message_reactions')
          .select('message_id, emoji, actor_type')
          .eq('conversation_id', conv.id)
          .in('message_id', page.map((m) => m.id));
        for (const r of (rx ?? []) as { message_id: string; emoji: string; actor_type: string }[]) {
          const list = reactions.get(r.message_id) ?? [];
          list.push({ emoji: r.emoji, actor_type: r.actor_type });
          reactions.set(r.message_id, list);
        }
      }

      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id, name')
        .eq('id', conv.contact_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      const window = await getReplyWindow(ctx.supabase, conv.id);

      return {
        conversation: {
          conversation_id: conv.id,
          status: conv.status,
          assigned_agent_id: conv.assigned_agent_id,
          unread_count: conv.unread_count ?? 0,
          contact_id: conv.contact_id,
          contact_name: (contact as { name: string | null } | null)?.name ?? null,
        },
        reply_window: window,
        messages: page
          .slice()
          .reverse()
          .map((m) => ({
            message_id: m.id,
            direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
            sender_type: m.sender_type,
            content_type: m.content_type,
            text: m.content_text,
            media: mediaOf(m),
            template_name: m.template_name,
            status: m.status,
            error: m.status === 'failed' ? m.error_title : null,
            reply_to_message_id: m.reply_to_message_id,
            interactive_reply_id: m.interactive_reply_id,
            ai_generated: m.ai_generated === true,
            reactions: reactions.get(m.id) ?? [],
            created_at: m.created_at,
          })),
        next_cursor: nextCursor,
      };
    },
  }),

  defineTool({
    name: 'check_reply_window',
    title: 'Check the 24-hour reply window',
    description:
      'Tell whether you can send free text to a conversation or must use a template. WhatsApp only allows free-form messages within 24 hours of the customer\'s last message. Returns can_send_free_text, the deadline (expires_at) and seconds remaining. Call before send_text / send_media.',
    scope: 'conversations:read',
    tier: 'read',
    input: { conversation_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const conv = await loadConversation(ctx, args.conversation_id);
      const w = await getReplyWindow(ctx.supabase, conv.id);
      return {
        conversation_id: conv.id,
        can_send_free_text: w.open,
        must_use_template: !w.open,
        expires_at: w.expires_at,
        remaining_seconds: w.remaining_seconds,
        last_customer_message_at: w.last_customer_message_at,
      };
    },
  }),

  defineTool({
    name: 'get_media_info',
    title: 'Get media details',
    description:
      'Get details of the media on a message (message_id from get_conversation_thread): kind, mime type, size when known, and a url the agent can fetch when the file is stored publicly. Files still only held by Meta (older inbound media not yet mirrored) return no url, just metadata. Never returns the file itself.',
    scope: 'conversations:read',
    tier: 'read',
    input: { message_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const m = await loadMessage(ctx, args.message_id);
      if (!m.media_url) {
        throw new McpToolError('not_found', 'That message has no media.', 'message_id');
      }
      const info = mediaOf(m)!;
      let sizeBytes: number | null = null;
      let mime = info.mime_type;

      // Metadata for media that only lives at Meta: resolve it with the
      // account's token (decrypted here, never returned).
      if (info.meta_media_id) {
        const { data: config } = await ctx.supabase
          .from('whatsapp_config')
          .select('access_token')
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        if (config) {
          try {
            const meta = await getMediaUrl({
              mediaId: info.meta_media_id,
              accessToken: decrypt((config as { access_token: string }).access_token),
            });
            sizeBytes = meta.fileSize;
            mime = mime ?? meta.mimeType;
          } catch {
            // Expired on Meta's side (~30 days) or unreachable: report what we have.
          }
        }
      }

      return {
        message_id: m.id,
        kind: info.kind,
        mime_type: mime,
        size_bytes: sizeBytes,
        url: info.url,
        fetchable: info.url !== null,
        note:
          info.url === null
            ? 'This file is held by Meta only and has no public URL; it may expire about 30 days after it was received.'
            : undefined,
      };
    },
  }),
];
