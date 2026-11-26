import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError, type ChatMessage } from '@/lib/ai/types'

/** Keep the tested transcript bounded, mirroring the live context window. */
export const PLAYGROUND_MAX_TURNS = 20

/** Normalise a client-supplied transcript to valid, bounded chat turns. */
export function sanitizePlaygroundMessages(raw: unknown[]): ChatMessage[] {
  return raw
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === 'object' &&
        ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
        typeof (m as ChatMessage).content === 'string' &&
        (m as ChatMessage).content.trim().length > 0,
    )
    .slice(-PLAYGROUND_MAX_TURNS)
}

/**
 * Draft a reply for a conversation using the account's BYO provider key.
 * Never sends or stores a message; records token usage (best-effort).
 * `db` may be the RLS client or the service role: the conversation is
 * always checked against `accountId` explicitly.
 * Throws AiError for expected failures.
 */
export async function draftConversationReply(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<{ draft: string }> {
  const { data: conversation, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (convErr) {
    console.error('[ai/draft] conversation lookup error:', convErr)
    throw new AiError('Failed to load conversation', {
      code: 'conversation_load_failed',
      status: 500,
    })
  }
  if (!conversation) {
    throw new AiError('Conversation not found', {
      code: 'conversation_not_found',
      status: 404,
    })
  }

  const config = await loadAiConfig(db, accountId).catch((err) => {
    // Decrypt failure — surface distinctly from "not configured".
    console.error('[ai/draft] loadAiConfig error:', err)
    throw new AiError('Stored API key could not be decrypted.', {
      code: 'key_decrypt_failed',
      status: 400,
    })
  })
  if (!config) {
    throw new AiError('AI assistant is not set up. Enable it in Settings → AI Assistant.', {
      code: 'ai_not_configured',
      status: 400,
    })
  }

  const messages = await buildConversationContext(db, conversationId)
  // Nothing to draft from — a brand-new thread with no customer text
  // would otherwise produce a nonsensical reply-to-nothing.
  if (messages.length === 0) {
    throw new AiError('No messages to draft from yet.', {
      code: 'no_messages',
      status: 400,
    })
  }

  // Ground the draft in the account's knowledge base (best-effort).
  const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))
  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    mode: 'draft',
    knowledge,
  })

  const { text, usage } = await generateReply({ config, systemPrompt, messages })

  // Record spend on the account's BYO key. Best-effort, fire-and-forget:
  // constructing the admin client throws if the service-role key is
  // unset — that must not fail the draft.
  try {
    void logAiUsage(supabaseAdmin(), {
      accountId,
      conversationId,
      mode: 'draft',
      provider: config.provider,
      model: config.model,
      usage,
    })
  } catch (logErr) {
    console.error('[ai/draft] usage log skipped:', logErr)
  }

  return { draft: text }
}

/**
 * Test-chat with the account's agent WITHOUT touching WhatsApp: same path
 * as auto-reply (KB retrieval + auto_reply prompt + provider), works even
 * when the master switch is off. Stateless; nothing is stored or logged.
 */
export async function runPlayground(
  db: SupabaseClient,
  accountId: string,
  messages: ChatMessage[],
): Promise<{ reply: string; handoff: boolean }> {
  const config = await loadAiConfig(db, accountId, { requireActive: false }).catch((err) => {
    console.error('[ai/playground] loadAiConfig error:', err)
    throw new AiError('Stored API key could not be decrypted.', {
      code: 'key_decrypt_failed',
      status: 400,
    })
  })
  if (!config) {
    throw new AiError('No agent configured yet. Add your provider key in Setup.', {
      code: 'ai_not_configured',
      status: 400,
    })
  }

  const knowledge = await retrieveKnowledge(db, accountId, config, latestUserMessage(messages))
  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    mode: 'auto_reply',
    knowledge,
  })
  const { text, handoff } = await generateReply({ config, systemPrompt, messages })
  return { reply: text, handoff }
}
