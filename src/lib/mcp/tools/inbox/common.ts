// Shared helpers for the inbox tools.

import { McpToolError } from '../../errors';
import type { McpContext } from '../../types';
import { SendMessageError } from '@/lib/whatsapp/send-message';

export interface ConversationRow {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  unread_count: number | null;
  last_message_text: string | null;
  last_message_at: string | null;
  created_at: string;
}

const CONVERSATION_COLUMNS =
  'id, contact_id, status, assigned_agent_id, unread_count, last_message_text, last_message_at, created_at';

/** Load a conversation by id, scoped to the account. Another account's id -> not_found. */
export async function loadConversation(
  ctx: McpContext,
  conversationId: string
): Promise<ConversationRow> {
  const { data, error } = await ctx.supabase
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', conversationId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new McpToolError('internal', 'Failed to load the conversation.');
  if (!data) {
    throw new McpToolError(
      'not_found',
      'Conversation not found. Use list_conversations_filtered to get valid ids.',
      'conversation_id'
    );
  }
  return data as ConversationRow;
}

/** Load a message and verify (through its conversation) that it belongs to the account. */
export async function loadMessage(ctx: McpContext, messageId: string) {
  const { data: message } = await ctx.supabase
    .from('messages')
    .select(
      'id, conversation_id, sender_type, content_type, media_url, media_type, message_id, template_name, created_at'
    )
    .eq('id', messageId)
    .maybeSingle();
  if (!message) {
    throw new McpToolError('not_found', 'Message not found.', 'message_id');
  }
  const { data: conv } = await ctx.supabase
    .from('conversations')
    .select('id')
    .eq('id', message.conversation_id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!conv) {
    throw new McpToolError('not_found', 'Message not found.', 'message_id');
  }
  return message as {
    id: string;
    conversation_id: string;
    sender_type: string;
    content_type: string;
    media_url: string | null;
    media_type: string | null;
    message_id: string | null;
    template_name: string | null;
    created_at: string;
  };
}

/** Map the send core's error onto an MCP error code. */
export function mapSendError(err: unknown): never {
  if (err instanceof McpToolError) throw err;
  if (err instanceof SendMessageError) {
    switch (err.code) {
      case 'not_found':
        throw new McpToolError('not_found', err.message);
      case 'bad_request':
        throw new McpToolError('invalid_input', err.message);
      case 'whatsapp_not_configured':
        throw new McpToolError('conflict', err.message);
      case 'template_malformed':
        throw new McpToolError('conflict', err.message, 'template_name');
      default:
        throw new McpToolError('upstream_error', err.message);
    }
  }
  throw err;
}

/** The Meta body (recipient redacted) an agent can inspect in a dry run. */
export function redactedMetaBody(rest: Record<string, unknown>) {
  return { messaging_product: 'whatsapp', to: '<recipient>', ...rest };
}
