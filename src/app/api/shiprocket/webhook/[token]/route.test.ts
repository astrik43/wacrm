import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => Promise<void> | void)[],
  getConfig: vi.fn(),
  process: vi.fn(),
  configUpdates: [] as Record<string, unknown>[],
  record: vi.fn(),
  finish: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      Response.json(body, init),
  },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        h.configUpdates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

vi.mock('@/lib/shopify/config', () => ({
  getShopifyConfigByToken: h.getConfig,
}));

vi.mock('@/lib/shopify/process', () => ({
  processExternalCheckout: h.process,
}));

vi.mock('@/lib/shopify/webhook-log', () => ({
  recordWebhookEvent: h.record,
  finishWebhookEvent: h.finish,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

import { POST } from './route';

const SECRET = 'shiprocket-secret-123';
const CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  webhook_token: 'tok',
  default_country_code: '91',
  is_active: true,
  shiprocket_secret: `enc:${SECRET}`,
};

function cart(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    cart_id: 'cart-77',
    email: '9029130001@fastrr.com',
    phone_number: '9029130001',
    first_name: 'Dinesh',
    last_name: 'Kumar',
    checkout_url: 'https://estelleluxe.in/cart/c/abc',
    total_price: 1599,
    latest_stage: 'ADDRESS_ENTERED',
    items: [{ title: 'Ring', price: 1599, quantity: 1 }],
    ...overrides,
  });
}

function post(
  body: string,
  headers: Record<string, string> = { 'x-chatstrik-secret': SECRET }
): Promise<Response> {
  return POST(
    new Request('http://localhost/api/shiprocket/webhook/tok', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
    { params: Promise.resolve({ token: 'tok' }) }
  );
}

async function runAfter() {
  for (const cb of h.afterCallbacks.splice(0)) await cb();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.afterCallbacks.length = 0;
  h.configUpdates.length = 0;
  h.getConfig.mockResolvedValue({ config: CONFIG, error: false });
  h.record.mockResolvedValue('log-1');
  h.process.mockResolvedValue({
    orderRef: 'Dinesh Kumar',
    outcomes: [{ event: 'cart_reminder_1', status: 'scheduled' }],
  });
});

describe('POST /api/shiprocket/webhook/[token]', () => {
  it('accepts a cart with the right secret and schedules the reminders', async () => {
    const res = await post(cart());
    expect(res.status).toBe(200);
    expect(h.process).not.toHaveBeenCalled(); // only after the 200

    await runAfter();

    expect(h.process).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG,
      expect.objectContaining({
        checkoutId: 'shiprocket:cart-77',
        phone: '919029130001',
      }),
      null
    );
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: 'shiprocket/abandoned_cart',
        shop_domain: 'estelleluxe.in',
        status: 'received',
      })
    );
    expect(h.finish).toHaveBeenCalledWith(
      expect.anything(),
      'log-1',
      expect.objectContaining({ status: 'processed' })
    );
    expect(h.configUpdates[0]).toHaveProperty('shiprocket_last_webhook_at');
  });

  it('takes the secret as a Bearer token too', async () => {
    expect((await post(cart(), { authorization: `Bearer ${SECRET}` })).status).toBe(200);
  });

  it('rejects a wrong or missing secret', async () => {
    expect((await post(cart(), { 'x-chatstrik-secret': 'nope' })).status).toBe(401);
    expect((await post(cart(), {})).status).toBe(401);
    await runAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'rejected', detail: 'invalid_signature' })
    );
  });

  it('is not found when Shiprocket is off or the token is unknown', async () => {
    h.getConfig.mockResolvedValueOnce({
      config: { ...CONFIG, shiprocket_secret: null },
      error: false,
    });
    expect((await post(cart())).status).toBe(404);
    h.getConfig.mockResolvedValueOnce({ config: null, error: false });
    expect((await post(cart())).status).toBe(404);
  });

  it('asks Shiprocket to retry when the database is down', async () => {
    h.getConfig.mockResolvedValueOnce({ config: null, error: true });
    expect((await post(cart())).status).toBe(503);
  });

  it('rejects a body that is not JSON', async () => {
    expect((await post('{nope')).status).toBe(400);
  });

  it('sends nothing for a cart that already became an order', async () => {
    await post(cart({ latest_stage: 'ORDER_PLACED' }));
    await runAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      expect.anything(),
      'log-1',
      expect.objectContaining({ status: 'ignored', detail: 'checkout_completed' })
    );
  });

  it('does nothing while the connection is paused', async () => {
    h.getConfig.mockResolvedValueOnce({
      config: { ...CONFIG, is_active: false },
      error: false,
    });
    await post(cart());
    await runAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      expect.anything(),
      'log-1',
      expect.objectContaining({ status: 'ignored', detail: 'connection_paused' })
    );
  });
});
