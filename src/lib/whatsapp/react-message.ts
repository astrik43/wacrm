// ============================================================
// Send an agent reaction to a message and mirror it into
// `message_reactions`. Shared by POST /api/whatsapp/react and the MCP
// `send_reaction` tool. Callers own auth and the response shape; this
// throws `ReactError` carrying the HTTP status the route returns.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';

export class ReactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ReactError';
    this.status = status;
  }
}

/** Empty `emoji` removes the reaction. `db` may be RLS-scoped or service-role. */
export async function reactToMessage(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  // Resolve target message + its conversation; verify ownership.
  const { data: targetMessage, error: msgError } = await db
    .from('messages')
    .select('id, message_id, conversation_id')
    .eq('id', messageId)
    .maybeSingle();

  if (msgError || !targetMessage) {
    throw new ReactError('Message not found', 404);
  }

  if (!targetMessage.message_id) {
    // No Meta ID yet — usually a sending/failed agent message.
    throw new ReactError(
      'Cannot react to a message that has not been sent to WhatsApp',
      400
    );
  }

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('id, account_id, contact:contacts(phone, wa_user_id)')
    .eq('id', targetMessage.conversation_id)
    .eq('account_id', accountId)
    .maybeSingle();

  if (convError || !conversation) {
    throw new ReactError('Conversation not found', 404);
  }

  const contact = Array.isArray(conversation.contact)
    ? conversation.contact[0]
    : conversation.contact;
  // Phone number, or the business-scoped user ID (issue #519).
  const sendTarget = resolveContactSendTarget(contact);
  if (!sendTarget) {
    throw new ReactError('Contact has no phone number or WhatsApp user ID', 400);
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new ReactError('WhatsApp not configured.', 400);
  }

  const accessToken = decrypt(config.access_token);

  try {
    await sendReactionMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: sendTarget.target,
      targetMessageId: targetMessage.message_id,
      emoji,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[whatsapp/react] Meta send failed:', message);
    throw new ReactError(`Meta API error: ${message}`, 502);
  }

  // Mirror into DB. Empty emoji = removal.
  if (emoji === '') {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetMessage.id)
      .eq('actor_type', 'agent')
      .eq('actor_id', userId);

    if (delError) {
      console.error('[whatsapp/react] DB delete failed:', delError.message);
      throw new ReactError('Reaction sent to Meta but DB delete failed', 500);
    }
  } else {
    // Upsert: the unique constraint (message_id, actor_type, actor_id)
    // lets us swap emoji in a single statement.
    const { error: upsertError } = await db.from('message_reactions').upsert(
      {
        message_id: targetMessage.id,
        conversation_id: targetMessage.conversation_id,
        actor_type: 'agent',
        actor_id: userId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    );

    if (upsertError) {
      console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
      throw new ReactError('Reaction sent to Meta but DB upsert failed', 500);
    }
  }
}
