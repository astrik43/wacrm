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

const SECRET = 'flexype-secret-123';
const CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  webhook_token: 'tok',
  default_country_code: '91',
  is_active: true,
  flexype_secret: `enc:${SECRET}`,
};

function acr(phone = '+919029130001') {
  return JSON.stringify({
    event_type: 'ABANDONED_CHECKOUT',
    event_id: 'evt_1',
    store: { shopify_domain: 'qxm9zm-ei.myshopify.com' },
    payload: {
      session_id: 'sess-1',
      checkout_url: 'https://checkout.flexype.io/abc',
      user: { full_name: 'Dinesh Kumar', phone_with_dial_code: phone },
      cart_items: [{ title: 'Ring', price: 1599, quantity: 1 }],
    },
  });
}

function post(body: string, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-event-id': 'evt_1',
    'x-webhook-version': '2026-05',
  };
  if (secret !== null) headers['x-flexype-authorization'] = secret;
  return POST(
    new Request('http://localhost/api/flexype/webhook/tok', {
      method: 'POST',
      headers,
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

describe('POST /api/flexype/webhook/[token]', () => {
  it('accepts a delivery with the right secret and schedules the reminders', async () => {
    const res = await post(acr());
    expect(res.status).toBe(200);
    expect(h.process).not.toHaveBeenCalled(); // only after the 200

    await runAfter();

    expect(h.process).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG,
      expect.objectContaining({
        checkoutId: 'flexype:sess-1',
        phone: '919029130001',
      }),
      'evt_1'
    );
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: 'flexype/abandoned_checkout',
        shopify_webhook_id: 'evt_1',
        shop_domain: 'qxm9zm-ei.myshopify.com',
        status: 'received',
      })
    );
    expect(h.finish).toHaveBeenCalledWith(
      expect.anything(),
      'log-1',
      expect.objectContaining({ status: 'processed' })
    );
    expect(h.configUpdates[0]).toHaveProperty('flexype_last_webhook_at');
  });

  it('rejects a wrong or missing secret', async () => {
    expect((await post(acr(), 'nope')).status).toBe(401);
    expect((await post(acr(), null)).status).toBe(401);
    await runAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'rejected', detail: 'invalid_signature' })
    );
  });

  it('is not found when FlexyPe is off or the token is unknown', async () => {
    h.getConfig.mockResolvedValueOnce({
      config: { ...CONFIG, flexype_secret: null },
      error: false,
    });
    expect((await post(acr())).status).toBe(404);
    h.getConfig.mockResolvedValueOnce({ config: null, error: false });
    expect((await post(acr())).status).toBe(404);
  });

  it('asks FlexyPe to retry when the database is down', async () => {
    h.getConfig.mockResolvedValueOnce({ config: null, error: true });
    expect((await post(acr())).status).toBe(503);
  });

  it('rejects a body that is not JSON', async () => {
    expect((await post('{nope')).status).toBe(400);
  });

  it("records FlexyPe's Test delivery without sending anything", async () => {
    await post(acr('+919876543210'));
    await runAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      expect.anything(),
      'log-1',
      expect.objectContaining({ detail: 'test_event' })
    );
  });

  it('does nothing while the connection is paused', async () => {
    h.getConfig.mockResolvedValueOnce({
      config: { ...CONFIG, is_active: false },
      error: false,
    });
    await post(acr());
    await runAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      expect.anything(),
      'log-1',
      expect.objectContaining({ status: 'ignored', detail: 'connection_paused' })
    );
  });
});
