import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { SupabaseClient } from '@supabase/supabase-js';

import { McpToolError } from './errors';
import { runTool } from './executor';
import { defineTool } from './types';

interface Row {
  tool: string;
  status: string;
  idempotency_key: string | null;
  args: unknown;
  result: unknown;
}

/** In-memory stand-in for the two queries audit.ts makes. */
function fakeDb() {
  const rows: Row[] = [];
  const db = {
    from: () => ({
      insert: async (row: Row) => {
        rows.push(row);
        return { error: null };
      },
      select: () => {
        const filters: Record<string, unknown> = {};
        const q = {
          eq: (k: string, v: unknown) => {
            filters[k] = v;
            return q;
          },
          limit: () => q,
          maybeSingle: async () => ({
            data:
              rows.find(
                (r) =>
                  r.tool === filters.tool &&
                  r.idempotency_key === filters.idempotency_key &&
                  r.status === filters.status
              ) ?? null,
          }),
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  return { db, rows };
}

function caller(db: SupabaseClient, scopes: string[] = ['tags:write']) {
  return { supabase: db, accountId: 'acc-1', keyId: 'key-1', scopes, createdBy: null };
}

const handler = vi.fn(async (_ctx: unknown, args: { name: string }) => ({ created: args.name }));
const write = defineTool({
  name: 'create_tag',
  description: 'x',
  scope: 'tags:write',
  tier: 'write',
  input: { name: z.string().min(1) },
  handler,
});
const destructive = defineTool({
  name: 'delete_tag',
  description: 'x',
  scope: 'tags:write',
  tier: 'destructive',
  input: { id: z.string() },
  handler: async (ctx, args) => ({ deleted: args.id, dryRun: ctx.dryRun }),
});
const read = defineTool({
  name: 'list_tags',
  description: 'x',
  scope: 'tags:read',
  tier: 'read',
  input: {},
  handler: async () => ({ tags: [] }),
});

describe('runTool', () => {
  it('refuses a key without the tool scope', async () => {
    const { db } = fakeDb();
    await expect(runTool(read, caller(db, ['tags:write']), {})).rejects.toMatchObject({
      code: 'missing_scope',
    });
  });

  it('rejects bad input with the offending field', async () => {
    const { db } = fakeDb();
    await expect(runTool(write, caller(db), { name: '' })).rejects.toMatchObject({
      code: 'invalid_input',
      field: 'name',
    });
  });

  it('does not audit a read', async () => {
    const { db, rows } = fakeDb();
    await runTool(read, caller(db, ['tags:read']), {});
    expect(rows).toHaveLength(0);
  });

  it('audits a write, redacting secrets', async () => {
    const { db, rows } = fakeDb();
    const secretive = defineTool({
      name: 'set_thing',
      description: 'x',
      scope: 'tags:write',
      tier: 'write',
      input: { api_key: z.string() },
      handler: async () => ({ ok: true }),
    });
    await runTool(secretive, caller(db), { api_key: 'sk-123' });
    expect(rows[0]).toMatchObject({ status: 'ok', args: { api_key: '[redacted]' } });
  });

  it('keeps customer phone numbers and emails out of the audit log', async () => {
    const { db, rows } = fakeDb();
    const sends = defineTool({
      name: 'send_thing',
      description: 'x',
      scope: 'tags:write',
      tier: 'write',
      input: { phone: z.string(), phones: z.array(z.string()), note: z.string() },
      handler: async () => ({ ok: true }),
    });
    await runTool(sends, caller(db), { phone: '919876543210', phones: ['919000000001'], note: 'hi' });
    expect(rows[0].args).toEqual({ phone: '[redacted]', phones: '[redacted]', note: 'hi' });
  });

  it('requires confirm for a destructive tool, but not for a dry run', async () => {
    const { db, rows } = fakeDb();
    await expect(runTool(destructive, caller(db), { id: 't1' })).rejects.toBeInstanceOf(McpToolError);
    await expect(runTool(destructive, caller(db), { id: 't1' })).rejects.toMatchObject({
      code: 'confirm_required',
    });
    expect(rows).toHaveLength(0);

    expect(await runTool(destructive, caller(db), { id: 't1', dry_run: true })).toEqual({
      dry_run: true,
      deleted: 't1',
      dryRun: true,
    });
    expect(rows[0].status).toBe('dry_run');

    expect(await runTool(destructive, caller(db), { id: 't1', confirm: true })).toMatchObject({
      deleted: 't1',
      dryRun: false,
    });
  });

  it('replays an idempotent call instead of acting twice', async () => {
    const { db } = fakeDb();
    handler.mockClear();
    const first = await runTool(write, caller(db), { name: 'vip', idempotency_key: 'k1' });
    const second = await runTool(write, caller(db), { name: 'vip', idempotency_key: 'k1' });
    expect(first).toEqual({ created: 'vip' });
    expect(second).toEqual({ created: 'vip', idempotent_replay: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not store or replay a dry run', async () => {
    const { db } = fakeDb();
    handler.mockClear();
    await runTool(write, caller(db), { name: 'vip', dry_run: true, idempotency_key: 'k2' });
    await runTool(write, caller(db), { name: 'vip', idempotency_key: 'k2' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('audits a failure and rethrows it', async () => {
    const { db, rows } = fakeDb();
    const boom = defineTool({
      name: 'boom',
      description: 'x',
      scope: 'tags:write',
      tier: 'write',
      input: {},
      handler: async () => {
        throw new McpToolError('not_found', 'no such tag');
      },
    });
    await expect(runTool(boom, caller(db), {})).rejects.toMatchObject({ code: 'not_found' });
    expect(rows[0]).toMatchObject({ status: 'error', error_code: 'not_found' });
  });
});
