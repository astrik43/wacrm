import { afterEach, describe, expect, it, vi } from 'vitest';

import { decrypt } from '@/lib/whatsapp/encryption';

import { McpToolError } from '../errors';
import { runTool, type CallerContext } from '../executor';
import { aiTools } from './ai';
import { fakeDb, type Row } from './settings/fake-db';

vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts: vi.fn(async () => [[0]]) }));
vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/draft', () => ({
  draftConversationReply: vi.fn(async () => ({ draft: 'Hello there' })),
  runPlayground: vi.fn(async () => ({ reply: 'Hi', handoff: false })),
  sanitizePlaygroundMessages: (raw: Array<{ role: string; content: string }>) => raw,
}));
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (u: string) => !/127\.|localhost|10\./.test(u)),
}));

const A = 'acct-a';
const B = 'acct-b';
const SECRET_KEY = 'sk-test-super-secret-key';

function tool(name: string) {
  const t = aiTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function caller(db: CallerContext['supabase'], accountId = A): CallerContext {
  return {
    supabase: db,
    accountId,
    keyId: 'key-1',
    scopes: ['ai:read', 'ai:write'],
    createdBy: 'user-1',
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('get_ai_config', () => {
  it('never returns the provider keys', async () => {
    const { db } = fakeDb({
      ai_configs: [
        { account_id: A, provider: 'openai', model: 'm', api_key: 'ENC1', embeddings_api_key: 'ENC2', is_active: true },
      ],
    });
    const out = (await runTool(tool('get_ai_config'), caller(db), {})) as Row;
    expect(out).toMatchObject({ configured: true, has_api_key: true, has_embeddings_key: true, model: 'm' });
    expect(JSON.stringify(out)).not.toContain('ENC1');
    expect(JSON.stringify(out)).not.toContain('ENC2');
  });

  it("does not read another account's config", async () => {
    const { db } = fakeDb({ ai_configs: [{ account_id: B, provider: 'openai', model: 'm', api_key: 'x' }] });
    expect(await runTool(tool('get_ai_config'), caller(db), {})).toEqual({ configured: false });
  });
});

describe('update_ai_config', () => {
  it('first-time setup needs a key', async () => {
    const { db } = fakeDb({});
    await expect(runTool(tool('update_ai_config'), caller(db), { is_active: true })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('dry run changes nothing and reports key state only', async () => {
    const { db, tables } = fakeDb({});
    const out = (await runTool(tool('update_ai_config'), caller(db), {
      provider: 'openai',
      model: 'gpt',
      api_key: SECRET_KEY,
      dry_run: true,
    })) as Row;
    expect(out.dry_run).toBe(true);
    expect(tables.ai_configs ?? []).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain(SECRET_KEY);
  });

  it('saves encrypted and never echoes the key', async () => {
    const { db, tables } = fakeDb({});
    const out = await runTool(tool('update_ai_config'), caller(db), {
      provider: 'anthropic',
      model: 'claude',
      api_key: SECRET_KEY,
      is_active: true,
    });
    const row = tables.ai_configs[0];
    expect(row.account_id).toBe(A);
    expect(row.api_key).not.toBe(SECRET_KEY);
    expect(decrypt(row.api_key as string)).toBe(SECRET_KEY);
    expect(JSON.stringify(out)).not.toContain(SECRET_KEY);
  });

  it('rejects a hand-off agent from another account', async () => {
    const { db } = fakeDb({
      ai_configs: [{ account_id: A, provider: 'openai', model: 'm', api_key: 'ENC' }],
      profiles: [{ account_id: B, user_id: '11111111-1111-4111-8111-111111111111' }],
    });
    await expect(
      runTool(tool('update_ai_config'), caller(db), {
        handoff_agent_id: '11111111-1111-4111-8111-111111111111',
      })
    ).rejects.toBeInstanceOf(McpToolError);
  });
});

describe('knowledge base', () => {
  const doc = '22222222-2222-4222-8222-222222222222';

  it('add_knowledge_document dry run reports chunks and saves nothing', async () => {
    const { db, tables } = fakeDb({});
    const out = (await runTool(tool('add_knowledge_document'), caller(db), {
      title: 'FAQ',
      content: 'Returns are accepted within 30 days.',
      dry_run: true,
    })) as Row;
    expect(out.chunks).toBeGreaterThan(0);
    expect(tables.ai_knowledge_documents ?? []).toHaveLength(0);
  });

  it('add_knowledge_document inserts under the account', async () => {
    const { db, tables } = fakeDb({});
    const out = (await runTool(tool('add_knowledge_document'), caller(db), {
      title: 'FAQ',
      content: 'Shipping takes 3 days.',
    })) as Row;
    expect(out.ok).toBe(true);
    expect(tables.ai_knowledge_documents[0]).toMatchObject({ account_id: A, title: 'FAQ' });
  });

  it('imports text from a public url and refuses private ones', async () => {
    const fetchMock = vi.fn(async () => new Response('<html><body><p>Open 9 to 5</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, tables } = fakeDb({});
    await runTool(tool('add_knowledge_document'), caller(db), { title: 'Hours', url: 'https://example.com/hours' });
    expect(tables.ai_knowledge_documents[0].content).toBe('Open 9 to 5');

    await expect(
      runTool(tool('add_knowledge_document'), caller(db), { title: 'x', url: 'https://127.0.0.1/a' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('needs exactly one of content or url', async () => {
    const { db } = fakeDb({});
    await expect(runTool(tool('add_knowledge_document'), caller(db), { title: 't' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('delete is scoped to the account, needs confirm, then deletes', async () => {
    const { db, tables } = fakeDb({
      ai_knowledge_documents: [{ id: doc, account_id: B, title: 'theirs', content: 'x' }],
    });
    await expect(
      runTool(tool('delete_knowledge_document'), caller(db), { document_id: doc, confirm: true })
    ).rejects.toMatchObject({ code: 'not_found' });

    tables.ai_knowledge_documents[0].account_id = A;
    await expect(
      runTool(tool('delete_knowledge_document'), caller(db), { document_id: doc })
    ).rejects.toMatchObject({ code: 'confirm_required' });
    const dry = (await runTool(tool('delete_knowledge_document'), caller(db), { document_id: doc, dry_run: true })) as Row;
    expect(dry.dry_run).toBe(true);
    expect(tables.ai_knowledge_documents).toHaveLength(1);
    await runTool(tool('delete_knowledge_document'), caller(db), { document_id: doc, confirm: true });
    expect(tables.ai_knowledge_documents).toHaveLength(0);
  });

  it('reindex dry run counts documents of this account only', async () => {
    const { db } = fakeDb({
      ai_knowledge_documents: [
        { id: 'a', account_id: A, content: 'one two three' },
        { id: 'b', account_id: B, content: 'other' },
      ],
    });
    const out = (await runTool(tool('reindex_knowledge'), caller(db), { dry_run: true })) as Row;
    expect(out.documents).toBe(1);
  });
});

describe('draft_reply and playground', () => {
  const conv = '33333333-3333-4333-8333-333333333333';

  it('draft_reply dry run is not_found for another account and never calls the model', async () => {
    const { db } = fakeDb({ conversations: [{ id: conv, account_id: B }] });
    await expect(
      runTool(tool('draft_reply'), caller(db), { conversation_id: conv, dry_run: true })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('draft_reply returns the draft', async () => {
    const { db } = fakeDb({ conversations: [{ id: conv, account_id: A }] });
    expect(await runTool(tool('draft_reply'), caller(db), { conversation_id: conv })).toEqual({ draft: 'Hello there' });
  });

  it('playground answers a single message; dry run does not call the model', async () => {
    const { db } = fakeDb({});
    expect(await runTool(tool('run_ai_playground'), caller(db), { message: 'Hi?' })).toEqual({
      reply: 'Hi',
      handoff: false,
    });
    const dry = (await runTool(tool('run_ai_playground'), caller(db), { message: 'Hi?', dry_run: true })) as Row;
    expect(dry.would_call_model).toBe(true);
  });
});

describe('get_ai_usage', () => {
  it('sums this account only', async () => {
    const now = new Date().toISOString();
    const base = { mode: 'draft', provider: 'openai', model: 'm', prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, created_at: now };
    const { db } = fakeDb({
      ai_usage_log: [
        { account_id: A, ...base },
        { account_id: A, ...base },
        { account_id: B, ...base },
      ],
    });
    const out = (await runTool(tool('get_ai_usage'), caller(db), { days: 7 })) as {
      totals: { calls: number; total_tokens: number };
    };
    expect(out.totals).toMatchObject({ calls: 2, total_tokens: 6 });
  });
});

describe('scopes', () => {
  it('refuses a write tool without ai:write', async () => {
    const { db } = fakeDb({});
    await expect(
      runTool(tool('reindex_knowledge'), { ...caller(db), scopes: ['ai:read'] }, {})
    ).rejects.toMatchObject({ code: 'missing_scope' });
  });
});
