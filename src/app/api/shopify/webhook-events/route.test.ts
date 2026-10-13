import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET as LIST } from './route';
import { GET as DETAIL } from './[id]/route';

const ID = '11111111-2222-3333-4444-555555555555';
let selected: string[];
let limits: number[];
let row: Record<string, unknown> | null;

function fakeSupabase() {
  return {
    from() {
      const builder: Record<string, unknown> = {
        select: (columns: string) => {
          selected.push(columns);
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        limit: async (n: number) => {
          limits.push(n);
          return { data: row ? [row] : [], error: null };
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return builder;
    },
  };
}

beforeEach(() => {
  selected = [];
  limits = [];
  row = { id: ID, topic: 'orders/create', status: 'processed' };
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({
    supabase: fakeSupabase(),
    accountId: 'acct-1',
    userId: 'u-1',
    role: 'admin',
  });
});

describe('/api/shopify/webhook-events', () => {
  it('is admin-only', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const list = await LIST(new Request('http://localhost/api/shopify/webhook-events'));
    const detail = await DETAIL(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: ID }),
    });
    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('lists recent deliveries without their payloads, with a capped limit', async () => {
    const response = await LIST(
      new Request('http://localhost/api/shopify/webhook-events?limit=5000')
    );
    expect(await response.json()).toEqual({ events: [row] });
    expect(selected[0]).not.toContain('payload');
    expect(limits).toEqual([200]);

    await LIST(new Request('http://localhost/api/shopify/webhook-events'));
    expect(limits[1]).toBe(50);
  });

  it('returns one delivery with its payload', async () => {
    row = { id: ID, topic: 'orders/create', payload: { id: 1 } };
    const response = await DETAIL(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: ID }),
    });
    expect(await response.json()).toEqual({ event: row });
    expect(selected[0]).toContain('payload');
  });

  it('404s an unknown or malformed id', async () => {
    row = null;
    const missing = await DETAIL(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: ID }),
    });
    expect(missing.status).toBe(404);

    const malformed = await DETAIL(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(malformed.status).toBe(404);
  });
});
