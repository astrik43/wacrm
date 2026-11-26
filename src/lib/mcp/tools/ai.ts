// ============================================================
// MCP 2.0 — "ai" tools (scopes ai:read / ai:write).
//
// Everything here reuses src/lib/ai/*: the same config save, chunk +
// embed pipeline, draft and playground code the dashboard routes call.
// Provider API keys are NEVER returned: reads expose only `has_api_key`.
// ============================================================

import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';
import { loadEmbeddingsKey } from '@/lib/ai/config';
import { AiConfigError, saveAiConfig } from '@/lib/ai/config-save';
import { chunkText } from '@/lib/ai/chunk';
import { draftConversationReply, runPlayground, sanitizePlaygroundMessages } from '@/lib/ai/draft';
import { ingestDocument } from '@/lib/ai/knowledge';
import { AiError } from '@/lib/ai/types';
import { clampUsageDays, summarizeAiUsage } from '@/lib/ai/usage-summary';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../types';

const MAX_DOC_CHARS = 200_000;
const MAX_FETCH_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;

const limitSchema = z.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 25).');
const cursorSchema = z.string().optional().describe('Opaque cursor from a previous next_cursor.');

function mapAiError(err: unknown): never {
  if (err instanceof McpToolError) throw err;
  if (err instanceof AiConfigError) {
    throw new McpToolError(err.status >= 500 ? 'internal' : 'invalid_input', err.message);
  }
  if (err instanceof AiError) {
    if (err.status === 404) throw new McpToolError('not_found', err.message);
    if (err.code === 'ai_not_configured') {
      throw new McpToolError('conflict', `${err.message} Call update_ai_config first.`);
    }
    if (err.status >= 500 && err.status !== 502) throw new McpToolError('internal', err.message);
    if (err.status === 502 || err.status === 429) throw new McpToolError('upstream_error', err.message);
    throw new McpToolError('invalid_input', err.message);
  }
  throw err;
}

/** Strip an HTML page down to readable text (no scripts/styles/tags). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Fetch a public https page as text. SSRF-guarded, no redirects, size-capped. */
async function fetchPageText(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new McpToolError('invalid_input', 'url must be a valid https:// URL', 'url');
  }
  if (parsed.protocol !== 'https:') {
    throw new McpToolError('invalid_input', 'url must be a valid https:// URL', 'url');
  }
  if (!(await isDeliverableUrl(parsed.toString()))) {
    throw new McpToolError('invalid_input', 'url must point to a public address', 'url');
  }
  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/html,text/plain;q=0.9' },
    });
  } catch {
    throw new McpToolError('upstream_error', 'Could not fetch that URL. Check it is reachable, or pass the text as content.');
  }
  if (!res.ok) {
    throw new McpToolError('upstream_error', `That URL responded ${res.status}. Pass the text as content instead.`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (type && !/text\/|html|xml|json/i.test(type)) {
    throw new McpToolError('invalid_input', 'That URL is not a text/HTML page. Pass the text as content instead.', 'url');
  }
  const raw = (await res.text()).slice(0, MAX_FETCH_BYTES);
  return /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw.trim();
}

async function requireDocument(ctx: McpContext, id: string) {
  const { data, error } = await ctx.supabase
    .from('ai_knowledge_documents')
    .select('id, title, content')
    .eq('account_id', ctx.accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new McpToolError('internal', 'Failed to load the document');
  if (!data) throw new McpToolError('not_found', 'Knowledge document not found. Use list_knowledge_documents for ids.', 'document_id');
  return data as { id: string; title: string; content: string };
}

export const aiTools: AnyMcpTool[] = [
  defineTool({
    name: 'get_ai_config',
    title: 'Get AI assistant config',
    description:
      'Read the AI assistant setup: provider, model, persona (system prompt), on/off switches, auto-reply cap and hand-off agent. Provider API keys are never returned, only has_api_key / has_embeddings_key. Call before update_ai_config.',
    scope: 'ai:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('ai_configs')
        .select(
          'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key'
        )
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error) throw new McpToolError('internal', 'Failed to load the AI configuration');
      if (!data) return { configured: false };
      const { api_key, embeddings_api_key, ...safe } = data as Record<string, unknown>;
      return {
        configured: true,
        has_api_key: !!api_key,
        has_embeddings_key: !!embeddings_api_key,
        ...safe,
      };
    },
  }),

  defineTool({
    name: 'update_ai_config',
    title: 'Update AI assistant config',
    description:
      'Create or change the AI assistant setup. Send only the fields to change; omitted fields keep their current value. The first setup needs provider, model and api_key. A new api_key is verified with the provider before saving (a tiny paid call on the account key). The key is stored encrypted and never echoed back. handoff_agent_id must be a team member id (use list_team_members); null leaves hand-offs unassigned. embeddings_api_key (OpenAI-compatible) turns on semantic knowledge search; null clears it. Use dry_run to preview the field changes without verifying or saving.',
    scope: 'ai:write',
    tier: 'write',
    input: {
      provider: z.enum(['openai', 'anthropic']).optional(),
      model: z.string().min(1).max(100).optional(),
      api_key: z.string().min(1).optional().describe('Provider API key. Write-only.'),
      embeddings_api_key: z.string().min(1).nullable().optional().describe('OpenAI-compatible embeddings key, or null to clear. Write-only.'),
      system_prompt: z.string().max(8000).nullable().optional().describe('Persona / instructions. null resets to the default.'),
      is_active: z.boolean().optional().describe('Master switch (enables drafts and auto-reply).'),
      auto_reply_enabled: z.boolean().optional(),
      auto_reply_max_per_conversation: z.number().int().min(1).max(20).optional(),
      handoff_agent_id: z.string().uuid().nullable().optional(),
    },
    handler: async (ctx, args) => {
      const { data: existing, error } = await ctx.supabase
        .from('ai_configs')
        .select(
          'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key'
        )
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error) throw new McpToolError('internal', 'Failed to load the AI configuration');
      const cur = (existing ?? null) as Record<string, unknown> | null;

      if (!cur && !(args.provider && args.model && args.api_key)) {
        throw new McpToolError('invalid_input', 'First-time setup needs provider, model and api_key.');
      }

      const body: Record<string, unknown> = {
        provider: args.provider ?? cur?.provider,
        model: args.model ?? cur?.model,
        system_prompt: args.system_prompt !== undefined ? args.system_prompt : cur?.system_prompt ?? null,
        is_active: args.is_active ?? cur?.is_active ?? false,
        auto_reply_enabled: args.auto_reply_enabled ?? cur?.auto_reply_enabled ?? false,
        auto_reply_max_per_conversation:
          args.auto_reply_max_per_conversation ?? cur?.auto_reply_max_per_conversation ?? 3,
      };
      if (args.api_key) body.api_key = args.api_key;
      if (args.embeddings_api_key !== undefined) body.embeddings_api_key = args.embeddings_api_key;
      if (args.handoff_agent_id !== undefined) body.handoff_agent_id = args.handoff_agent_id ?? '';

      // Plain-value changes only (keys are reported as a flag, never a value).
      const next: Record<string, unknown> = {
        provider: body.provider,
        model: body.model,
        system_prompt: body.system_prompt,
        is_active: body.is_active,
        auto_reply_enabled: body.auto_reply_enabled,
        auto_reply_max_per_conversation: body.auto_reply_max_per_conversation,
        handoff_agent_id:
          args.handoff_agent_id !== undefined ? args.handoff_agent_id : (cur?.handoff_agent_id ?? null),
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, to] of Object.entries(next)) {
        const from = cur?.[k] ?? null;
        if ((to ?? null) !== from) changes[k] = { from, to: to ?? null };
      }
      const keyChanges = {
        api_key: args.api_key ? 'will be replaced' : 'unchanged',
        embeddings_api_key:
          args.embeddings_api_key === undefined
            ? 'unchanged'
            : args.embeddings_api_key === null
              ? 'will be cleared'
              : 'will be replaced',
      };

      if (ctx.dryRun) {
        if (typeof body.handoff_agent_id === 'string' && body.handoff_agent_id) {
          const { data: member } = await ctx.supabase
            .from('profiles')
            .select('user_id')
            .eq('account_id', ctx.accountId)
            .eq('user_id', body.handoff_agent_id)
            .maybeSingle();
          if (!member) throw new McpToolError('not_found', 'handoff_agent_id is not a member of this account', 'handoff_agent_id');
        }
        return { dry_run: true, changes, keys: keyChanges };
      }

      try {
        await saveAiConfig(ctx.supabase, ctx.accountId, ctx.createdBy, body);
      } catch (err) {
        mapAiError(err);
      }
      return { ok: true, changed: Object.keys(changes), keys: keyChanges, has_api_key: true };
    },
  }),

  defineTool({
    name: 'list_knowledge_documents',
    title: 'List knowledge documents',
    description:
      'List the knowledge-base documents the AI assistant answers from (id, title, size, dates), newest first. Use the ids with delete_knowledge_document. Returns { items, next_cursor }.',
    scope: 'ai:read',
    tier: 'read',
    input: { limit: limitSchema, cursor: cursorSchema },
    handler: async (ctx, args) => {
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('ai_knowledge_documents')
        .select('id, title, created_at, updated_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      const f = keysetFilter(decodeCursor(args.cursor ?? null));
      if (f) q = q.or(f);
      const { data, error } = await q;
      if (error) throw new McpToolError('internal', 'Failed to load the knowledge base');
      const page = buildPage((data ?? []) as Array<{ created_at: string; id: string }>, limit);
      return { items: page.items, next_cursor: page.nextCursor };
    },
  }),

  defineTool({
    name: 'add_knowledge_document',
    title: 'Add knowledge document',
    description:
      'Add a document to the AI knowledge base from text (content) or from a public https page (url): exactly one of them. The text is chunked and, when an embeddings key is set, embedded for semantic search. If indexing partly fails the document is still saved (keyword search works) and a warning says to run reindex_knowledge. Use dry_run to see how many chunks it would create without saving. Max 200,000 characters.',
    scope: 'ai:write',
    tier: 'write',
    input: {
      title: z.string().min(1).max(200),
      content: z.string().min(1).optional().describe('The document text.'),
      url: z.string().optional().describe('A public https page to import as text instead of content.'),
    },
    handler: async (ctx, args) => {
      if (!!args.content === !!args.url) {
        throw new McpToolError('invalid_input', 'Provide exactly one of content or url.');
      }
      const title = args.title.trim();
      const text = (args.content ?? (await fetchPageText(args.url as string))).trim().slice(0, MAX_DOC_CHARS);
      if (!title || !text) throw new McpToolError('invalid_input', 'title and non-empty content are required.');
      const chunks = chunkText(text).length;

      if (ctx.dryRun) {
        return { dry_run: true, title, characters: text.length, chunks, source: args.url ? 'url' : 'text' };
      }

      const { data: doc, error } = await ctx.supabase
        .from('ai_knowledge_documents')
        .insert({ account_id: ctx.accountId, created_by: ctx.createdBy, title, content: text })
        .select('id')
        .single();
      if (error || !doc) throw new McpToolError('internal', 'Failed to save the document');

      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(ctx.supabase, ctx.accountId);
      let warning: string | undefined;
      try {
        await ingestDocument(ctx.supabase, ctx.accountId, { embeddingsApiKey }, doc.id, text);
        if (corrupt) {
          warning = 'Saved with keyword search only: the embeddings key could not be decrypted. Re-enter it with update_ai_config, then run reindex_knowledge.';
        }
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'indexing failed';
        warning = `Saved, but semantic indexing failed (${message}). Keyword search still works; run reindex_knowledge to retry.`;
      }
      return { ok: true, id: doc.id, chunks, ...(warning ? { warning } : {}) };
    },
  }),

  defineTool({
    name: 'delete_knowledge_document',
    title: 'Delete knowledge document',
    description:
      'Permanently delete a knowledge-base document and its chunks, so the assistant stops using it. Cannot be undone. Get the id from list_knowledge_documents. Needs confirm: true (or dry_run: true to preview).',
    scope: 'ai:write',
    tier: 'destructive',
    input: { document_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const doc = await requireDocument(ctx, args.document_id);
      if (ctx.dryRun) {
        return { dry_run: true, would_delete: { id: doc.id, title: doc.title, characters: doc.content.length } };
      }
      const { error } = await ctx.supabase
        .from('ai_knowledge_documents')
        .delete()
        .eq('account_id', ctx.accountId)
        .eq('id', doc.id);
      if (error) throw new McpToolError('internal', 'Failed to delete the document');
      return { ok: true, deleted: doc.id };
    },
  }),

  defineTool({
    name: 'reindex_knowledge',
    title: 'Reindex knowledge base',
    description:
      'Re-chunk and re-embed knowledge documents. Run it after adding an embeddings key (existing documents were stored keyword-only) or when add_knowledge_document warned that indexing failed. Optionally one document_id; default is every document. Embedding calls use the account embeddings key. Use dry_run to see how many documents and chunks.',
    scope: 'ai:write',
    tier: 'write',
    input: { document_id: z.string().uuid().optional().describe('Only this document (default: all).') },
    handler: async (ctx, args) => {
      let docs: Array<{ id: string; content: string }>;
      if (args.document_id) {
        docs = [await requireDocument(ctx, args.document_id)];
      } else {
        const { data, error } = await ctx.supabase
          .from('ai_knowledge_documents')
          .select('id, content')
          .eq('account_id', ctx.accountId);
        if (error) throw new McpToolError('internal', 'Failed to load documents');
        docs = (data ?? []) as Array<{ id: string; content: string }>;
      }
      if (ctx.dryRun) {
        return {
          dry_run: true,
          documents: docs.length,
          chunks: docs.reduce((n, d) => n + chunkText(d.content).length, 0),
        };
      }
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(ctx.supabase, ctx.accountId);
      if (corrupt) {
        throw new McpToolError(
          'conflict',
          'The embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter it with update_ai_config). Nothing was reindexed.'
        );
      }
      let reindexed = 0;
      for (const doc of docs) {
        try {
          await ingestDocument(ctx.supabase, ctx.accountId, { embeddingsApiKey }, doc.id, doc.content);
          reindexed += 1;
        } catch (err) {
          const message = err instanceof AiError ? err.message : String(err);
          return { ok: false, reindexed, total: docs.length, error: `Reindexed ${reindexed}, then hit an error: ${message}` };
        }
      }
      return { ok: true, reindexed, total: docs.length };
    },
  }),

  defineTool({
    name: 'draft_reply',
    title: 'Draft a reply',
    description:
      "Draft a suggested reply for a conversation with the account's AI assistant. Returns text only: nothing is sent or stored (send it with the inbox send tools after review). It is write-tier because it calls the paid model on the account's own provider key and logs token usage. Needs the AI assistant set up (get_ai_config) and a conversation_id with customer messages. dry_run checks the conversation and setup without calling the model.",
    scope: 'ai:write',
    tier: 'write',
    input: { conversation_id: z.string().uuid() },
    handler: async (ctx, args) => {
      if (ctx.dryRun) {
        const { data: conv } = await ctx.supabase
          .from('conversations')
          .select('id')
          .eq('account_id', ctx.accountId)
          .eq('id', args.conversation_id)
          .maybeSingle();
        if (!conv) throw new McpToolError('not_found', 'Conversation not found.', 'conversation_id');
        const { data: cfg } = await ctx.supabase
          .from('ai_configs')
          .select('is_active')
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        return { dry_run: true, would_call_model: true, ai_ready: !!cfg && cfg.is_active === true };
      }
      try {
        return await draftConversationReply(ctx.supabase, ctx.accountId, args.conversation_id);
      } catch (err) {
        return mapAiError(err);
      }
    },
  }),

  defineTool({
    name: 'run_ai_playground',
    title: 'Test the AI assistant',
    description:
      "Ask the AI assistant a test question exactly as a customer would (knowledge-base retrieval + auto-reply prompt) without touching WhatsApp. Stateless: pass the running transcript in messages (role user|assistant, last 20 kept) or just message. Works before the master switch is on. Write-tier because it calls the paid model on the account's own provider key. dry_run validates the input without calling the model.",
    scope: 'ai:write',
    tier: 'write',
    input: {
      message: z.string().min(1).max(4000).optional().describe('A single test question.'),
      messages: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
        .max(40)
        .optional()
        .describe('Transcript so far, ending with the user turn to answer.'),
    },
    handler: async (ctx, args) => {
      const raw = [...(args.messages ?? []), ...(args.message ? [{ role: 'user', content: args.message }] : [])];
      const messages = sanitizePlaygroundMessages(raw);
      if (messages.length === 0) throw new McpToolError('invalid_input', 'Send message or messages to test the assistant.');
      if (ctx.dryRun) return { dry_run: true, would_call_model: true, turns: messages.length };
      try {
        return await runPlayground(ctx.supabase, ctx.accountId, messages);
      } catch (err) {
        return mapAiError(err);
      }
    },
  }),

  defineTool({
    name: 'get_ai_usage',
    title: 'AI usage',
    description:
      'Token usage of the AI assistant over the last N days (1-90, default 30): totals, split by auto-reply vs draft and by model, plus a per-day series. Tokens only: the log records no money because calls bill the account\'s own provider key, so multiply by the provider price for cost.',
    scope: 'ai:read',
    tier: 'read',
    input: { days: z.number().int().min(1).max(90).optional() },
    handler: async (ctx, args) => {
      try {
        return await summarizeAiUsage(ctx.supabase, ctx.accountId, clampUsageDays(args.days));
      } catch {
        throw new McpToolError('internal', 'Failed to load AI usage');
      }
    },
  }),
];
