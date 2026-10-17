import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  upserts: [] as { row: Record<string, unknown>; options: unknown }[],
  deletes: [] as unknown[][],
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.account,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth' }, { status: 401 })),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from() {
      const filters: unknown[][] = [];
      const builder: Record<string, unknown> = {
        upsert: async (row: Record<string, unknown>, options: unknown) => {
          mocks.upserts.push({ row, options });
          return { error: null };
        },
        delete: () => builder,
        eq: (...args: unknown[]) => {
          filters.push(args);
          if (filters.length === 2) mocks.deletes.push(...filters);
          return builder;
        },
      };
      return builder;
    },
  }),
}));

import { DELETE, GET, POST } from './route';

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

function req(method: string, body?: unknown) {
  return new Request('http://localhost/api/push/subscription', {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone)' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upserts = [];
  mocks.deletes = [];
  mocks.account.mockResolvedValue({ accountId: 'acct-1', userId: 'u-1', role: 'agent' });
  vi.stubEnv('VAPID_PUBLIC_KEY', 'BPUBLICKEY');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'private');
});
afterEach(() => vi.unstubAllEnvs());

describe('/api/push/subscription', () => {
  it('gives the public key, never the private one', async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ enabled: true, publicKey: 'BPUBLICKEY' });

    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    expect(await (await GET()).json()).toEqual({ enabled: false, publicKey: null });
  });

  it("saves this device for the signed-in member", async () => {
    const res = await POST(req('POST', SUB));
    expect(res.status).toBe(200);
    expect(mocks.upserts[0]).toEqual({
      row: {
        account_id: 'acct-1',
        user_id: 'u-1',
        endpoint: SUB.endpoint,
        p256dh: SUB.keys.p256dh,
        auth: SUB.keys.auth,
        user_agent: 'Mozilla/5.0 (iPhone)',
      },
      options: { onConflict: 'endpoint' },
    });
  });

  it('rejects a malformed subscription or a non-https endpoint', async () => {
    expect((await POST(req('POST', { ...SUB, endpoint: 'http://x.test/a' }))).status).toBe(400);
    expect((await POST(req('POST', { endpoint: SUB.endpoint, keys: { p256dh: '<script>', auth: 'x' } }))).status).toBe(400);
    expect((await POST(req('POST', null))).status).toBe(400);
    expect(mocks.upserts).toEqual([]);
  });

  it("removes only the caller's own device", async () => {
    await DELETE(req('DELETE', { endpoint: SUB.endpoint }));
    expect(mocks.deletes).toEqual([
      ['endpoint', SUB.endpoint],
      ['user_id', 'u-1'],
    ]);
  });

  it('requires a signed-in member', async () => {
    mocks.account.mockRejectedValue(new Error('no session'));
    expect((await POST(req('POST', SUB))).status).toBe(401);
  });
});
