import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
  UnauthorizedError: class UnauthorizedError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));

import { POST } from './route';

interface Row {
  id: string;
  name: string;
  language: string;
  meta_template_id: string | null;
}

/**
 * Just enough of the Supabase query builder for the sync route:
 * whatsapp_config lookup, per-template lookup / insert / update, the
 * stale-row listing and the chunked delete.
 */
function fakeDb(rows: Row[]) {
  let nextId = 100;
  const deleted: string[] = [];

  function templates() {
    const filters: Record<string, unknown> = {};
    let notNullMeta = false;
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      },
      not: () => {
        notNullMeta = true;
        return q;
      },
      maybeSingle: async () => ({
        data:
          rows.find(
            (r) => r.name === filters.name && r.language === filters.language
          ) ?? null,
        error: null,
      }),
      update: (patch: Partial<Row>) => ({
        eq: async (_col: string, id: string) => {
          Object.assign(rows.find((r) => r.id === id)!, patch);
          return { error: null };
        },
      }),
      insert: async (row: Row) => {
        rows.push({ ...row, id: String(nextId++) });
        return { error: null };
      },
      delete: () => ({
        in: async (_col: string, ids: string[]) => {
          deleted.push(...ids);
          for (const id of ids) {
            rows.splice(
              rows.findIndex((r) => r.id === id),
              1
            );
          }
          return { error: null };
        },
      }),
      then: (resolve: (v: unknown) => void) =>
        resolve({
          data: rows.filter((r) => !notNullMeta || r.meta_template_id),
          error: null,
        }),
    };
    return q;
  }

  const supabase = {
    from: (table: string) => {
      if (table === 'whatsapp_config') {
        const q = {
          select: () => q,
          eq: () => q,
          single: async () => ({
            data: { waba_id: 'WABA_NEW', access_token: 'enc' },
            error: null,
          }),
        };
        return q;
      }
      return templates();
    },
  };
  return { supabase, rows, deleted };
}

function metaPage(data: unknown[], next?: string): Response {
  return Response.json({ data, paging: next ? { next } : {} });
}

const tpl = (id: string, name: string) => ({
  id,
  name,
  language: 'en',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'hi' }],
});

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  db = fakeDb([
    // From the previously connected WABA.
    { id: '1', name: 'old_only', language: 'en', meta_template_id: 'OLD1' },
    // Same name on both: the new WABA's copy replaces it.
    { id: '2', name: 'shared', language: 'en', meta_template_id: 'OLD2' },
    // A local draft that was never submitted.
    { id: '3', name: 'draft', language: 'en', meta_template_id: null },
  ]);
  mocks.requireRole.mockResolvedValue({
    supabase: db.supabase,
    accountId: 'account-1',
    userId: 'user-1',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/whatsapp/templates/sync', () => {
  it('removes rows that are not on the connected WABA and keeps drafts', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          metaPage([tpl('NEW1', 'shared'), tpl('NEW2', 'fresh')])
        )
    );

    const res = await POST();
    const body = await res.json();

    expect(body).toMatchObject({
      success: true,
      total: 2,
      inserted: 1,
      updated: 1,
      removed: 1,
      truncated: false,
    });
    expect(db.deleted).toEqual(['1']);
    expect(db.rows.map((r) => [r.name, r.meta_template_id]).sort()).toEqual([
      ['draft', null],
      ['fresh', 'NEW2'],
      ['shared', 'NEW1'],
    ]);
  });

  it('removes nothing when the Meta listing was cut off at the page cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          metaPage([tpl('NEW1', 'shared')], 'https://graph.facebook.com/next')
        )
    );

    const body = await (await POST()).json();

    expect(body.truncated).toBe(true);
    expect(body.removed).toBe(0);
    expect(db.deleted).toEqual([]);
  });

  it('removes nothing when Meta returns an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: 'expired' } }, { status: 401 })
        )
    );

    const res = await POST();

    expect(res.status).toBe(502);
    expect(db.deleted).toEqual([]);
    expect(db.rows).toHaveLength(3);
  });
});
