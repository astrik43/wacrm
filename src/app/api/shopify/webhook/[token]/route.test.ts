import crypto from 'crypto';
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
  processShopifyWebhook: h.process,
}));

vi.mock('@/lib/shopify/webhook-log', () => ({
  recordWebhookEvent: h.record,
  finishWebhookEvent: h.finish,
  orderRefOf: (payload: { name?: string } | null) => payload?.name ?? null,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

import { POST } from './route';

const SECRET = 'shpss_secret';
const CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  webhook_token: 'tok',
  webhook_secret: `enc:${SECRET}`,
  shop_domain: null,
  default_country_code: '91',
  is_active: true,
  last_webhook_at: null,
};
const BODY = JSON.stringify({ id: 1001, name: '#1042' });

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

function post(
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return POST(
    new Request('http://localhost/api/shopify/webhook/tok', {
      method: 'POST',
      headers: {
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'wh-1',
        'x-shopify-shop-domain': 'acme.myshopify.com',
        'x-shopify-hmac-sha256': sign(body),
        ...headers,
      },
      body,
    }),
    { params: Promise.resolve({ token: 'tok' }) }
  );
}

async function drainAfter() {
  for (const cb of h.afterCallbacks.splice(0)) await cb();
}

beforeEach(() => {
  h.afterCallbacks.length = 0;
  h.configUpdates.length = 0;
  h.getConfig.mockReset();
  h.process.mockReset();
  h.record.mockReset();
  h.finish.mockReset();
  h.getConfig.mockResolvedValue({ config: CONFIG, error: false });
  h.process.mockResolvedValue({
    orderRef: '#1042',
    outcomes: [{ event: 'order_created', status: 'sent' }],
  });
  h.record.mockResolvedValue('log-1');
});

describe('POST /api/shopify/webhook/[token]', () => {
  it('404s an unknown token and 503s a database failure', async () => {
    h.getConfig.mockResolvedValueOnce({ config: null, error: false });
    expect((await post(BODY)).status).toBe(404);

    h.getConfig.mockResolvedValueOnce({ config: null, error: true });
    expect((await post(BODY)).status).toBe(503);
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('401s a bad or missing signature without processing', async () => {
    expect(
      (await post(BODY, { 'x-shopify-hmac-sha256': sign(BODY, 'wrong') })).status
    ).toBe(401);
    expect((await post(BODY, { 'x-shopify-hmac-sha256': '' })).status).toBe(401);
    await drainAfter();
    expect(h.process).not.toHaveBeenCalled();
  });

  it('logs a rejected delivery without keeping its unverified payload', async () => {
    await post(BODY, { 'x-shopify-hmac-sha256': sign(BODY, 'wrong') });
    await drainAfter();
    expect(h.record).toHaveBeenCalledTimes(1);
    const logged = h.record.mock.calls[0][1];
    expect(logged).toMatchObject({
      account_id: 'acct-1',
      topic: 'orders/create',
      status: 'rejected',
      detail: 'invalid_signature',
    });
    expect(logged).not.toHaveProperty('payload');
  });

  it('400s a signed body that is not JSON', async () => {
    expect((await post('not json')).status).toBe(400);
    await drainAfter();
    expect(h.process).not.toHaveBeenCalled();
    expect(h.record.mock.calls[0][1]).toMatchObject({
      status: 'rejected',
      detail: 'invalid_json',
    });
  });

  it('acknowledges first, then processes the delivery', async () => {
    const response = await post(BODY);
    expect(response.status).toBe(200);
    expect(h.process).not.toHaveBeenCalled();

    await drainAfter();
    expect(h.process).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG,
      'orders/create',
      { id: 1001, name: '#1042' },
      'wh-1'
    );
    expect(h.configUpdates[0]).toMatchObject({
      shop_domain: 'acme.myshopify.com',
    });
    expect(h.configUpdates[0].last_webhook_at).toEqual(expect.any(String));
  });

  it('logs an accepted delivery with its payload and what it led to', async () => {
    await post(BODY);
    await drainAfter();

    expect(h.record.mock.calls[0][1]).toEqual({
      account_id: 'acct-1',
      topic: 'orders/create',
      shopify_webhook_id: 'wh-1',
      shop_domain: 'acme.myshopify.com',
      status: 'received',
      order_ref: '#1042',
      payload: { id: 1001, name: '#1042' },
    });
    expect(h.finish).toHaveBeenCalledWith(expect.anything(), 'log-1', {
      status: 'processed',
      detail: null,
      order_ref: '#1042',
      outcome: [{ event: 'order_created', status: 'sent' }],
    });
  });

  it('logs why a delivery produced no customer update', async () => {
    h.process.mockResolvedValue({
      orderRef: '#9999',
      note: 'order_already_cancelled',
      outcomes: [],
    });
    await post(BODY);
    await drainAfter();
    expect(h.finish.mock.calls[0][2]).toMatchObject({
      status: 'processed',
      detail: 'order_already_cancelled',
      outcome: [],
    });
  });

  it('acknowledges but does not process an unknown topic or a paused store', async () => {
    expect((await post(BODY, { 'x-shopify-topic': 'products/update' })).status).toBe(200);
    await drainAfter();

    h.getConfig.mockResolvedValueOnce({
      config: { ...CONFIG, is_active: false },
      error: false,
    });
    expect((await post(BODY)).status).toBe(200);
    await drainAfter();

    expect(h.process).not.toHaveBeenCalled();
    expect(h.finish.mock.calls.map((c) => c[2])).toEqual([
      { status: 'ignored', detail: 'unsupported_topic' },
      { status: 'ignored', detail: 'connection_paused' },
    ]);
  });

  it('swallows a processing error after the acknowledgement and logs it', async () => {
    h.process.mockRejectedValue(new Error('boom'));
    expect((await post(BODY)).status).toBe(200);
    await expect(drainAfter()).resolves.toBeUndefined();
    expect(h.finish.mock.calls[0][2]).toEqual({ status: 'error', detail: 'boom' });
  });

  it('still processes when the log itself cannot be written', async () => {
    h.record.mockResolvedValue(null);
    await post(BODY);
    await drainAfter();
    expect(h.process).toHaveBeenCalledTimes(1);
  });
});
