import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => Promise<void> | void)[],
  getConfig: vi.fn(),
  process: vi.fn(),
  configUpdates: [] as Record<string, unknown>[],
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
  h.getConfig.mockResolvedValue({ config: CONFIG, error: false });
  h.process.mockResolvedValue(undefined);
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
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('400s a signed body that is not JSON', async () => {
    expect((await post('not json')).status).toBe(400);
    expect(h.afterCallbacks).toHaveLength(0);
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
  });

  it('swallows a processing error after the acknowledgement', async () => {
    h.process.mockRejectedValue(new Error('boom'));
    expect((await post(BODY)).status).toBe(200);
    await expect(drainAfter()).resolves.toBeUndefined();
  });
});
