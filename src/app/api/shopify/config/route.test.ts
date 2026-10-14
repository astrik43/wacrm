import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  requestAccessToken: vi.fn(),
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
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

vi.mock('@/lib/shopify/admin-api', () => {
  class ShopifyApiError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    ShopifyApiError,
    requestAccessToken: mocks.requestAccessToken,
    canReadProducts: (scopes: string[]) => scopes.includes('read_products'),
    canWriteOrders: (scopes: string[]) => scopes.includes('write_orders'),
    isMyshopifyDomain: (d: unknown) =>
      typeof d === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d),
  };
});

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { ShopifyApiError } from '@/lib/shopify/admin-api';
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
  mocks.requestAccessToken.mockReset();
  mocks.requestAccessToken.mockResolvedValue({
    token: 'shpat_token',
    expiresAt: '2026-10-14T00:00:00.000Z',
    scopes: ['read_products'],
  });
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

  it('PUT checks app credentials with Shopify and stores them encrypted', async () => {
    state.existing = { id: 'cfg-1', shop_domain: 'acme.myshopify.com' };
    const response = await put({
      api_client_id: ' client-id ',
      api_client_secret: ' client-secret ',
    });

    expect(response.status).toBe(200);
    expect(mocks.requestAccessToken).toHaveBeenCalledWith(
      'acme.myshopify.com',
      'client-id',
      'client-secret'
    );
    expect(state.updates).toEqual([
      {
        api_client_id: 'client-id',
        api_client_secret: 'enc:client-secret',
        api_access_token: 'enc:shpat_token',
        api_token_expires_at: '2026-10-14T00:00:00.000Z',
        api_scopes: 'read_products',
        shop_domain: 'acme.myshopify.com',
      },
    ]);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('client-secret');
    expect(text).not.toContain('shpat_token');
  });

  it('PUT takes a typed store domain when no webhook has arrived yet', async () => {
    state.existing = { id: 'cfg-1', shop_domain: null };

    const missing = await put({ api_client_id: 'a', api_client_secret: 'b' });
    expect(missing.status).toBe(400);
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();

    const typed = await put({
      api_client_id: 'a',
      api_client_secret: 'b',
      shop_domain: 'https://Acme.myshopify.com/admin',
    });
    expect(typed.status).toBe(200);
    expect(mocks.requestAccessToken).toHaveBeenCalledWith(
      'acme.myshopify.com',
      'a',
      'b'
    );
  });

  it('PUT saves nothing when Shopify refuses the credentials or the scope is missing', async () => {
    state.existing = { id: 'cfg-1', shop_domain: 'acme.myshopify.com' };

    mocks.requestAccessToken.mockRejectedValueOnce(
      new ShopifyApiError('shop_not_permitted', 'Not in the same organization')
    );
    const refused = await put({ api_client_id: 'a', api_client_secret: 'b' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'shop_not_permitted' });

    mocks.requestAccessToken.mockResolvedValueOnce({
      token: 't',
      expiresAt: 'x',
      scopes: ['read_orders'],
    });
    const noScope = await put({ api_client_id: 'a', api_client_secret: 'b' });
    expect(noScope.status).toBe(400);

    const half = await put({ api_client_id: 'a' });
    expect(half.status).toBe(400);

    expect(state.updates).toEqual([]);
  });

  it('PUT clears the credentials and cached token when asked', async () => {
    state.existing = { id: 'cfg-1', shop_domain: 'acme.myshopify.com' };
    const response = await put({ api_client_id: null });
    expect(response.status).toBe(200);
    expect(state.updates).toEqual([
      {
        api_client_id: null,
        api_client_secret: null,
        api_access_token: null,
        api_token_expires_at: null,
        api_scopes: null,
      },
    ]);
  });

  it('GET reports whether credentials are set, and the client id to admins only', async () => {
    state.existing = { ...ROW, api_client_id: 'client-id' };

    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'agent'));
    const agent = await (await GET()).json();
    expect(agent.config).toMatchObject({
      has_api_credentials: true,
      api_client_id: null,
    });

    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'admin'));
    const admin = await (await GET()).json();
    expect(admin.config.api_client_id).toBe('client-id');
  });

  it('GET says whether the app may tag orders, once its scopes are known', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'admin'));
    state.existing = { ...ROW, api_client_id: 'client-id' };
    expect((await (await GET()).json()).config.can_tag_orders).toBeNull();

    state.existing = { ...ROW, api_client_id: 'client-id', api_scopes: 'read_products' };
    expect((await (await GET()).json()).config.can_tag_orders).toBe(false);

    state.existing = {
      ...ROW,
      api_client_id: 'client-id',
      api_scopes: 'read_products,write_orders',
    };
    expect((await (await GET()).json()).config.can_tag_orders).toBe(true);
  });

  it('PUT switches FlexyPe on with a fresh encrypted secret, and off', async () => {
    state.existing = ROW;
    expect((await put({ flexype: 'generate' })).status).toBe(200);
    expect(state.updates[0].flexype_secret).toMatch(/^enc:[A-Za-z0-9_-]{32}$/);

    expect((await put({ flexype: null })).status).toBe(200);
    expect(state.updates[1]).toEqual({ flexype_secret: null });

    expect((await put({ flexype: 'yes' })).status).toBe(400);
  });

  it('GET shows the FlexyPe URL and secret to admins only', async () => {
    state.existing = {
      ...ROW,
      flexype_secret: 'enc:fx-secret',
      flexype_last_webhook_at: '2026-10-14T10:00:00Z',
    };

    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'agent'));
    const agent = await (await GET()).json();
    expect(agent.config.flexype).toEqual({
      enabled: true,
      last_webhook_at: '2026-10-14T10:00:00Z',
      webhook_path: null,
      secret: null,
    });
    expect(JSON.stringify(agent)).not.toContain('fx-secret');

    mocks.getCurrentAccount.mockResolvedValue(ctx(state, 'admin'));
    const admin = await (await GET()).json();
    expect(admin.config.flexype).toMatchObject({
      webhook_path: '/api/flexype/webhook/tok_abcdefghijklmnop',
      secret: 'fx-secret',
    });

    state.existing = ROW;
    expect((await (await GET()).json()).config.flexype.enabled).toBe(false);
  });

  it('DELETE requires admin and removes the connection', async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(state.deletes).toBe(1);
  });
});
