import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider } from '@/lib/ai/types'

/** An expected, user-facing failure (bad input / provider rejected the key). */
export class AiConfigError extends Error {
  readonly status: number
  readonly code?: string
  constructor(message: string, status = 400, code?: string) {
    super(message)
    this.name = 'AiConfigError'
    this.status = status
    this.code = code
  }
}

/** Raw (untrusted) input, same shape the settings form POSTs. */
export type AiConfigInput = Record<string, unknown>

/**
 * Upsert the account's AI config. Shared by POST /api/ai/config and the
 * MCP update_ai_config tool. Validates the key with the provider before
 * persisting, then stores keys AES-256-GCM-encrypted. When `api_key` is
 * omitted the stored key is reused. Throws AiConfigError.
 *
 * `db` may be RLS-scoped or the service role: every query filters by
 * `accountId`.
 */
export async function saveAiConfig(
  db: SupabaseClient,
  accountId: string,
  userId: string | null,
  body: AiConfigInput,
): Promise<void> {
  const bad = (m: string) => new AiConfigError(m, 400)

  const provider = body.provider as AiProvider
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw bad('provider must be "openai" or "anthropic"')
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) throw bad('model is required')

  const systemPrompt =
    typeof body.system_prompt === 'string' && body.system_prompt.trim()
      ? body.system_prompt.trim()
      : null
  const isActive = body.is_active === true
  const autoReplyEnabled = body.auto_reply_enabled === true

  let maxPer = Number(body.auto_reply_max_per_conversation)
  if (!Number.isFinite(maxPer)) maxPer = 3
  maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

  // Handoff routing target for auto-reply. A non-empty string must be a
  // member of this account (else the conversation would be assigned to a
  // stranger); an empty string / null means "leave unassigned" (the
  // shared queue). Absent → left unchanged on update below.
  const rawHandoff =
    typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
  const handoffProvided = 'handoff_agent_id' in body
  let handoffAgentId: string | null = null
  if (rawHandoff) {
    const { data: member } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('user_id', rawHandoff)
      .maybeSingle()
    if (!member) throw bad('handoff_agent_id must be a member of this account')
    handoffAgentId = rawHandoff
  }

  const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

  // Embeddings key (optional, for semantic KB search): a non-empty
  // string sets/replaces it; an explicit null clears it; absent leaves
  // it unchanged.
  const rawEmbeddingsKey =
    typeof body.embeddings_api_key === 'string' ? body.embeddings_api_key.trim() : ''
  const clearEmbeddingsKey = body.embeddings_api_key === null

  // Reuse the stored key when a fresh one wasn't sent.
  const { data: existing } = await db
    .from('ai_configs')
    .select('id, provider, model, api_key')
    .eq('account_id', accountId)
    .maybeSingle()

  let apiKeyPlain: string
  if (rawKey) {
    apiKeyPlain = rawKey
  } else if (existing?.api_key) {
    try {
      apiKeyPlain = decrypt(existing.api_key)
    } catch {
      throw bad('Stored API key could not be decrypted — re-enter your key.')
    }
  } else {
    throw bad('api_key is required')
  }

  // Only spend a provider round-trip when the credentials that affect
  // reachability actually changed.
  const credentialsChanged =
    !existing ||
    rawKey !== '' ||
    provider !== existing.provider ||
    model !== existing.model

  if (credentialsChanged) {
    try {
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt,
        isActive,
        autoReplyEnabled,
        autoReplyMaxPerConversation: maxPer,
        handoffAgentId: null,
        embeddingsApiKey: null,
      })
    } catch (err) {
      if (err instanceof AiError) throw new AiConfigError(err.message, 400, err.code)
      console.error('[ai/config POST] validation error:', err)
      throw bad('Could not validate the API key with the provider.')
    }
  }

  // Validate a new embeddings key before storing (a cheap 1-input embed).
  if (rawEmbeddingsKey) {
    try {
      await embedTexts(rawEmbeddingsKey, ['ping'])
    } catch (err) {
      if (err instanceof AiError) {
        throw new AiConfigError(`Embeddings key: ${err.message}`, 400, err.code)
      }
      console.error('[ai/config POST] embeddings validation error:', err)
      throw bad('Could not validate the embeddings key.')
    }
  }

  const encryptedKey = rawKey ? encrypt(rawKey) : null
  const shared: Record<string, unknown> = {
    provider,
    model,
    system_prompt: systemPrompt,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_max_per_conversation: maxPer,
  }
  // Only touch the handoff target when the caller actually sent the field.
  if (handoffProvided) shared.handoff_agent_id = handoffAgentId
  if (rawEmbeddingsKey) {
    shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
  } else if (clearEmbeddingsKey) {
    shared.embeddings_api_key = null
  }

  if (existing) {
    const { error: upErr } = await db
      .from('ai_configs')
      .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/config POST] update error:', upErr)
      throw new AiConfigError('Failed to save AI configuration', 500)
    }
  } else {
    const { error: insErr } = await db.from('ai_configs').insert({
      account_id: accountId,
      created_by: userId,
      api_key: encryptedKey, // non-null: rawKey is required when no existing row
      ...shared,
    })
    if (insErr) {
      console.error('[ai/config POST] insert error:', insErr)
      throw new AiConfigError('Failed to save AI configuration', 500)
    }
  }
}
