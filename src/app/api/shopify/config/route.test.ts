import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { DELETE, GET, PUT } from './route';

const ROW = {
  id: 'cfg-1',
  webhook_token: 'tok_abcdefghijklmnop',
  shop_domain: 'acme.myshopify.com',
  default_country_code: '91',
  is_active: true,
  last_webhook_at: null,
  created_at: '2026-10-12T00:00:00Z',
};

interface FakeState {
  existing: Record<string, unknown> | null;
  inserts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  deletes: number;
}

function fakeSupabase(state: FakeState) {
  return {
    from() {
      let wrote = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          state.inserts.push(row);
          wrote = true;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          state.updates.push(row);
          wrote = true;
          return builder;
        },
        delete: () => {
          state.deletes += 1;
          return builder;
        },
        maybeSingle: async () => ({ data: state.existing, error: null }),
        single: async () => ({ data: wrote ? ROW : state.existing, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return builder;
    },
  };
}

function ctx(state: FakeState, role: string) {
  return {
    supabase: fakeSupabase(state),
    accountId: 'acct-1',
    userId: 'user-1',
    role,
    account: { id: 'acct-1', name: 'Acme' },
  };
}

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/shopify/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

let state: FakeState;

beforeEach(() => {
  state = { existing: null, inserts: [], updates: [], deletes: 0 };
  mocks.getCurrentAccount.mockReset();
  mocks.requireRole.mockReset();
  mocks.requireRole.mockImplementation(async () => ctx(state, 'admin'));
});

describe('/api/shopify/config', () => {
  it('GET never returns the secret, and hides the URL from non-admins', async () => {
    state.existing = ROW;

    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'agent'));
    const agent = await (await GET()).json();
    expect(agent.config.webhook_path).toBeNull();
    expect(JSON.stringify(agent)).not.toContain('tok_abcdefghijklmnop');
    expect(JSON.stringify(agent)).not.toContain('webhook_secret');

    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'admin'));
    const admin = await (await GET()).json();
    expect(admin.config.webhook_path).toBe(
      '/api/shopify/webhook/tok_abcdefghijklmnop'
    );
    expect(JSON.stringify(admin)).not.toContain('webhook_secret');
  });

  it('GET returns null when no store is connected', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'viewer'));
    expect(await (await GET()).json()).toEqual({ config: null });
  });

  it('PUT requires admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const response = await put({ webhook_secret: 's' });
    expect(response.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(state.inserts).toEqual([]);
  });

  it('PUT connects with an encrypted secret and a fresh token', async () => {
    const response = await put({
      webhook_secret: '  shpss_abc  ',
      default_country_code: '+91',
    });
    expect(response.status).toBe(201);
    expect(state.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      created_by: 'user-1',
      webhook_secret: 'enc:shpss_abc',
      default_country_code: '91',
    });
    expect(state.inserts[0].webhook_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(await response.json())).not.toContain('shpss_abc');
  });

  it('PUT refuses to connect without a secret', async () => {
    const response = await put({ default_country_code: '91' });
    expect(response.status).toBe(400);
    expect(state.inserts).toEqual([]);
  });

  it('PUT validates the country code', async () => {
    for (const bad of ['0', '9999', 'in']) {
      const response = await put({ webhook_secret: 's', default_country_code: bad });
      expect(response.status).toBe(400);
    }
    expect(state.inserts).toEqual([]);
  });

  it('PUT updates an existing connection without touching the secret', async () => {
    state.existing = { id: 'cfg-1' };
    const response = await put({ is_active: false, default_country_code: '' });
    expect(response.status).toBe(200);
    expect(state.updates).toEqual([
      { default_country_code: null, is_active: false },
    ]);
  });

  it('DELETE requires admin and removes the connection', async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(state.deletes).toBe(1);
  });
});
