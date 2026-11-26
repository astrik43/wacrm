import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createMcpServer } from './server';
import { ALL_TOOLS } from './tools';
import { defineTool } from './types';

const db = {
  from: () => ({ insert: async () => ({ error: null }) }),
} as unknown as SupabaseClient;

const TOOLS = [
  defineTool({
    name: 'list_tags',
    description: 'List tags',
    scope: 'tags:read',
    tier: 'read',
    input: {},
    handler: async () => ({ tags: ['vip'] }),
  }),
  defineTool({
    name: 'delete_tag',
    description: 'Delete a tag',
    scope: 'tags:write',
    tier: 'destructive',
    input: { id: z.string() },
    handler: async (_c, a) => ({ deleted: a.id }),
  }),
];

async function connect(scopes: string[]) {
  const server = createMcpServer(
    { supabase: db, accountId: 'acc-1', keyId: 'key-1', scopes, createdBy: null },
    TOOLS
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

describe('createMcpServer', () => {
  it('lists only the tools the key can use, with the safety arguments added', async () => {
    const client = await connect(['tags:read']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_tags']);

    const all = await connect(['tags:read', 'tags:write']);
    const del = (await all.listTools()).tools.find((t) => t.name === 'delete_tag')!;
    expect(Object.keys(del.inputSchema.properties ?? {}).sort()).toEqual([
      'confirm',
      'dry_run',
      'id',
      'idempotency_key',
    ]);
    expect(del.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it('runs a tool and returns JSON', async () => {
    const client = await connect(['tags:read']);
    const res = await client.callTool({ name: 'list_tags', arguments: {} });
    expect(JSON.parse((res.content as { text: string }[])[0].text)).toEqual({ tags: ['vip'] });
  });

  it('turns a refusal into a structured error result', async () => {
    const client = await connect(['tags:write']);
    const res = await client.callTool({ name: 'delete_tag', arguments: { id: 't1' } });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as { text: string }[])[0].text)).toMatchObject({
      code: 'confirm_required',
      field: 'confirm',
    });
  });
});

describe('registry', () => {
  it('has unique snake_case names, descriptions and a tier', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(['read', 'write', 'destructive']).toContain(t.tier);
    }
  });

  it('only uses scopes that exist', async () => {
    const { isApiScope } = await import('@/lib/api-keys/scopes');
    for (const t of ALL_TOOLS) if (t.scope) expect(isApiScope(t.scope)).toBe(true);
  });

  it('a read tool never asks for a write scope, and a write tool never for a read scope', () => {
    for (const t of ALL_TOOLS) {
      if (!t.scope) continue;
      const isWriteScope = /:(write|send|manage)$/.test(t.scope);
      if (t.tier === 'read') expect(isWriteScope, `${t.name} is read but needs ${t.scope}`).toBe(false);
      else expect(isWriteScope, `${t.name} is ${t.tier} but needs ${t.scope}`).toBe(true);
    }
  });
});
