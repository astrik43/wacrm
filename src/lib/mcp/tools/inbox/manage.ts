// Inbox write tools that change conversation state or quick replies
// (scope conversations:write) and the quick-reply list (conversations:read).

import { z } from 'zod';

import { McpToolError } from '../../errors';
import { defineTool, type McpContext } from '../../types';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { loadConversation } from './common';

async function setAssignee(ctx: McpContext, conversationId: string, agentId: string | null) {
  const conv = await loadConversation(ctx, conversationId);
  if (agentId) {
    // The agent must be a member of THIS account.
    const { data } = await ctx.supabase
      .from('profiles')
      .select('user_id')
      .eq('user_id', agentId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!data) {
      throw new McpToolError(
        'not_found',
        'That team member was not found in this account. Use list_team_members for valid ids.',
        'agent_id'
      );
    }
  }
  const result = {
    conversation_id: conv.id,
    previous_agent_id: conv.assigned_agent_id,
    assigned_agent_id: agentId,
  };
  if (ctx.dryRun) return { would_change: conv.assigned_agent_id !== agentId, ...result };
  const { error } = await ctx.supabase
    .from('conversations')
    .update({ assigned_agent_id: agentId })
    .eq('id', conv.id)
    .eq('account_id', ctx.accountId);
  if (error) throw new McpToolError('internal', 'Failed to update the assignment.');
  return { changed: conv.assigned_agent_id !== agentId, ...result };
}

async function loadQuickReply(ctx: McpContext, id: string) {
  const { data } = await ctx.supabase
    .from('quick_replies')
    .select('id, title, kind, content_text, interactive_payload')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!data) {
    throw new McpToolError(
      'not_found',
      'Quick reply not found. Use list_quick_replies for valid ids.',
      'quick_reply_id'
    );
  }
  return data as {
    id: string;
    title: string;
    kind: 'text' | 'interactive';
    content_text: string | null;
    interactive_payload: unknown;
  };
}

const interactiveShape = z
  .record(z.string(), z.unknown())
  .describe('Interactive payload: {kind:"buttons"|"list", body, buttons|sections, ...}. Validated against Meta\'s limits.');

export const inboxManageTools = [
  defineTool({
    name: 'assign_conversation',
    title: 'Assign a conversation',
    description:
      'Assign a conversation to a team member (agent_id from list_team_members). The agent is notified in the dashboard. Use unassign_conversation to clear.',
    scope: 'conversations:write',
    tier: 'write',
    input: { conversation_id: z.string().uuid(), agent_id: z.string().uuid() },
    handler: (ctx, args) => setAssignee(ctx, args.conversation_id, args.agent_id),
  }),

  defineTool({
    name: 'unassign_conversation',
    title: 'Unassign a conversation',
    description: 'Remove the assignee from a conversation so it returns to the shared inbox.',
    scope: 'conversations:write',
    tier: 'write',
    input: { conversation_id: z.string().uuid() },
    handler: (ctx, args) => setAssignee(ctx, args.conversation_id, null),
  }),

  defineTool({
    name: 'set_conversation_status',
    title: 'Open, pend or close a conversation',
    description:
      'Set a conversation\'s status to open, pending (waiting on the customer or a teammate) or closed. Snoozing is not supported by this CRM; use pending instead.',
    scope: 'conversations:write',
    tier: 'write',
    input: {
      conversation_id: z.string().uuid(),
      status: z.enum(['open', 'pending', 'closed']),
    },
    handler: async (ctx, args) => {
      const conv = await loadConversation(ctx, args.conversation_id);
      const result = {
        conversation_id: conv.id,
        previous_status: conv.status,
        status: args.status,
      };
      if (ctx.dryRun) return { would_change: conv.status !== args.status, ...result };
      const { error } = await ctx.supabase
        .from('conversations')
        .update({ status: args.status, updated_at: new Date().toISOString() })
        .eq('id', conv.id)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError('internal', 'Failed to update the status.');
      return { changed: conv.status !== args.status, ...result };
    },
  }),

  defineTool({
    name: 'mark_conversation_read',
    title: 'Mark a conversation read',
    description: 'Reset a conversation\'s unread counter to zero.',
    scope: 'conversations:write',
    tier: 'write',
    input: { conversation_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const conv = await loadConversation(ctx, args.conversation_id);
      const result = { conversation_id: conv.id, previous_unread_count: conv.unread_count ?? 0 };
      if (ctx.dryRun) return { would_change: (conv.unread_count ?? 0) > 0, ...result };
      const { error } = await ctx.supabase
        .from('conversations')
        .update({ unread_count: 0 })
        .eq('id', conv.id)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError('internal', 'Failed to mark the conversation read.');
      return { changed: (conv.unread_count ?? 0) > 0, ...result };
    },
  }),

  defineTool({
    name: 'list_quick_replies',
    title: 'List quick replies',
    description:
      'List the account\'s saved quick replies (reusable text or interactive snippets). Returns id, title, kind and content. To send one, pass its text to send_text.',
    scope: 'conversations:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('quick_replies')
        .select('id, title, kind, content_text, interactive_payload, updated_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw new McpToolError('internal', 'Failed to list quick replies.');
      return {
        items: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          quick_reply_id: r.id,
          title: r.title,
          kind: r.kind,
          content_text: r.content_text,
          interactive_payload: r.interactive_payload,
          updated_at: r.updated_at,
        })),
      };
    },
  }),

  defineTool({
    name: 'create_quick_reply',
    title: 'Create a quick reply',
    description:
      'Save a reusable quick reply. kind "text" needs content_text; kind "interactive" needs interactive_payload (reply buttons or a list).',
    scope: 'conversations:write',
    tier: 'write',
    input: {
      title: z.string().min(1).max(100),
      kind: z.enum(['text', 'interactive']).default('text'),
      content_text: z.string().optional(),
      interactive_payload: interactiveShape.optional(),
    },
    handler: async (ctx, args) => {
      const row = buildQuickReplyContent(args.kind, args.content_text, args.interactive_payload);
      if (ctx.dryRun) return { would_create: { title: args.title.trim(), kind: args.kind } };
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no owning user to author the quick reply.');
      }
      const { data, error } = await ctx.supabase
        .from('quick_replies')
        .insert({
          account_id: ctx.accountId,
          user_id: ctx.createdBy,
          title: args.title.trim(),
          kind: args.kind,
          ...row,
        })
        .select('id')
        .single();
      if (error || !data) throw new McpToolError('internal', 'Failed to create the quick reply.');
      return { created: true, quick_reply_id: (data as { id: string }).id };
    },
  }),

  defineTool({
    name: 'update_quick_reply',
    title: 'Update a quick reply',
    description:
      'Edit a quick reply (id from list_quick_replies). Pass only what changes. To change kind, also pass the matching content (content_text or interactive_payload).',
    scope: 'conversations:write',
    tier: 'write',
    input: {
      quick_reply_id: z.string().uuid(),
      title: z.string().min(1).max(100).optional(),
      kind: z.enum(['text', 'interactive']).optional(),
      content_text: z.string().optional(),
      interactive_payload: interactiveShape.optional(),
    },
    handler: async (ctx, args) => {
      const existing = await loadQuickReply(ctx, args.quick_reply_id);
      const update: Record<string, unknown> = {};
      if (args.title !== undefined) update.title = args.title.trim();
      const touchesContent =
        args.kind !== undefined ||
        args.content_text !== undefined ||
        args.interactive_payload !== undefined;
      if (touchesContent) {
        const kind = args.kind ?? existing.kind;
        Object.assign(update, { kind }, buildQuickReplyContent(kind, args.content_text, args.interactive_payload));
      }
      if (Object.keys(update).length === 0) {
        throw new McpToolError('invalid_input', 'Nothing to update: pass title, kind or content.');
      }
      if (ctx.dryRun) return { would_update: Object.keys(update), quick_reply_id: existing.id };
      const { error } = await ctx.supabase
        .from('quick_replies')
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError('internal', 'Failed to update the quick reply.');
      return { updated: true, quick_reply_id: existing.id };
    },
  }),

  defineTool({
    name: 'delete_quick_reply',
    title: 'Delete a quick reply',
    description:
      'Permanently delete a quick reply (id from list_quick_replies). Cannot be undone; requires confirm: true.',
    scope: 'conversations:write',
    tier: 'destructive',
    input: { quick_reply_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const existing = await loadQuickReply(ctx, args.quick_reply_id);
      if (ctx.dryRun) return { would_delete: { quick_reply_id: existing.id, title: existing.title } };
      const { error } = await ctx.supabase
        .from('quick_replies')
        .delete()
        .eq('id', existing.id)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError('internal', 'Failed to delete the quick reply.');
      return { deleted: true, quick_reply_id: existing.id };
    },
  }),
];

/** Same rules as the quick-replies routes: exactly the content the kind needs. */
function buildQuickReplyContent(
  kind: 'text' | 'interactive',
  contentText: string | undefined,
  payload: Record<string, unknown> | undefined
): { content_text: string | null; interactive_payload: unknown } {
  if (kind === 'interactive') {
    const v = validateInteractivePayload(payload);
    if (!v.ok) throw new McpToolError('invalid_input', v.error, 'interactive_payload');
    return { content_text: null, interactive_payload: payload };
  }
  if (!contentText || !contentText.trim()) {
    throw new McpToolError('invalid_input', 'content_text is required for text quick replies.', 'content_text');
  }
  return { content_text: contentText, interactive_payload: null };
}
