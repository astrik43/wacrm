import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

import {
  addOrderTags,
  canReadProducts,
  canWriteOrders,
  fetchLineItemImage,
  getShopifyAccessToken,
  isMyshopifyDomain,
  requestAccessToken,
  ShopifyApiError,
} from './admin-api';
import type { ShopifyConfigRow } from './config';

const fetchMock = vi.fn();
const updates: Record<string, unknown>[] = [];

const db = {
  from: () => ({
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return { eq: async () => ({ error: null }) };
    },
  }),
} as unknown as SupabaseClient;

function config(overrides: Partial<ShopifyConfigRow> = {}): ShopifyConfigRow {
  return {
    id: 'cfg-1',
    account_id: 'acct-1',
    webhook_token: 'tok',
    webhook_secret: 'enc:whsec',
    shop_domain: 'acme.myshopify.com',
    default_country_code: '91',
    is_active: true,
    last_webhook_at: null,
    api_client_id: 'client-id',
    api_client_secret: 'enc:client-secret',
    api_access_token: 'enc:cached-token',
    api_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    api_scopes: 'read_products',
    flexype_secret: null,
    flexype_last_webhook_at: null,
    shiprocket_secret: null,
    shiprocket_last_webhook_at: null,
    test_mode: false,
    test_phones: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TOKEN_RESPONSE = {
  access_token: 'fresh-token',
  scope: 'read_products,read_orders',
  expires_in: 86399,
};

function image(url: string) {
  return { preview: { image: { url } } };
}

const REF = { variantId: '11', productId: '22' };

beforeEach(() => {
  updates.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isMyshopifyDomain', () => {
  it('accepts only Shopify admin hosts', () => {
    expect(isMyshopifyDomain('acme-store.myshopify.com')).toBe(true);
    expect(isMyshopifyDomain('acme.myshopify.com.evil.example')).toBe(false);
    expect(isMyshopifyDomain('evil.example/x.myshopify.com')).toBe(false);
    expect(isMyshopifyDomain('acme.com')).toBe(false);
    expect(isMyshopifyDomain('ACME.myshopify.com')).toBe(false);
    expect(isMyshopifyDomain(null)).toBe(false);
  });
});

describe('requestAccessToken', () => {
  it('exchanges the credentials and parses scopes and expiry', async () => {
    fetchMock.mockResolvedValue(json(TOKEN_RESPONSE));
    const issued = await requestAccessToken('acme.myshopify.com', 'id', 'secret');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.myshopify.com/admin/oauth/access_token');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe(
      'grant_type=client_credentials&client_id=id&client_secret=secret'
    );
    expect(issued.token).toBe('fresh-token');
    expect(issued.scopes).toEqual(['read_products', 'read_orders']);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now() + 86_000_000);
  });

  it('never calls a host that is not a Shopify store', async () => {
    await expect(
      requestAccessToken('evil.example', 'id', 'secret')
    ).rejects.toMatchObject({ code: 'invalid_shop' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies Shopify refusals', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Oauth error shop_not_permitted: nope', { status: 400 })
    );
    await expect(
      requestAccessToken('acme.myshopify.com', 'id', 'secret')
    ).rejects.toMatchObject({ code: 'shop_not_permitted' });

    fetchMock.mockResolvedValueOnce(
      new Response('<title>400 - Oauth error app_not_installed</title>', {
        status: 400,
      })
    );
    await expect(
      requestAccessToken('acme.myshopify.com', 'id', 'secret')
    ).rejects.toMatchObject({ code: 'app_not_installed' });

    fetchMock.mockResolvedValueOnce(new Response('invalid_client', { status: 401 }));
    await expect(
      requestAccessToken('acme.myshopify.com', 'id', 'bad')
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 503 }));
    await expect(
      requestAccessToken('acme.myshopify.com', 'id', 'secret')
    ).rejects.toMatchObject({ code: 'unavailable' });

    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      requestAccessToken('acme.myshopify.com', 'id', 'secret')
    ).rejects.toBeInstanceOf(ShopifyApiError);
  });
});

describe('canReadProducts', () => {
  it('accepts read or write access to products', () => {
    expect(canReadProducts(['read_products'])).toBe(true);
    expect(canReadProducts(['write_products'])).toBe(true);
    expect(canReadProducts(['read_orders'])).toBe(false);
  });
});

describe('getShopifyAccessToken', () => {
  it('reuses a cached token that still has time left', async () => {
    expect(await getShopifyAccessToken(db, config())).toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token and caches the new one encrypted', async () => {
    fetchMock.mockResolvedValue(json(TOKEN_RESPONSE));
    const token = await getShopifyAccessToken(
      db,
      config({ api_token_expires_at: new Date(Date.now() + 60_000).toISOString() })
    );
    expect(token).toBe('fresh-token');
    expect(updates[0]).toMatchObject({
      api_access_token: 'enc:fresh-token',
      api_scopes: 'read_products,read_orders',
    });
    expect(updates[0].api_token_expires_at).toEqual(expect.any(String));
  });

  it('returns null without credentials or when Shopify refuses', async () => {
    expect(
      await getShopifyAccessToken(db, config({ api_client_id: null }))
    ).toBeNull();
    expect(
      await getShopifyAccessToken(db, config({ shop_domain: null }))
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response('invalid_client', { status: 401 }));
    expect(
      await getShopifyAccessToken(db, config({ api_access_token: null }))
    ).toBeNull();
  });
});

describe('fetchLineItemImage', () => {
  it('prefers the variant picture and asks for a bounded JPG', async () => {
    fetchMock.mockResolvedValue(
      json({
        data: {
          productVariant: { media: { nodes: [image('https://cdn.shopify.com/v.jpg')] } },
          product: { featuredMedia: image('https://cdn.shopify.com/p.jpg') },
        },
      })
    );
    expect(await fetchLineItemImage(db, config(), REF)).toBe(
      'https://cdn.shopify.com/v.jpg'
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(
      /^https:\/\/acme\.myshopify\.com\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/
    );
    expect(init.headers['X-Shopify-Access-Token']).toBe('cached-token');
    const body = JSON.parse(init.body);
    expect(body.variables).toEqual({
      variantId: 'gid://shopify/ProductVariant/11',
      productId: 'gid://shopify/Product/22',
    });
    expect(body.query).toContain('preferredContentType: JPG');
  });

  it('falls back to the product picture', async () => {
    fetchMock.mockResolvedValue(
      json({
        data: {
          productVariant: { media: { nodes: [] } },
          product: { featuredMedia: image('https://cdn.shopify.com/p.jpg') },
        },
      })
    );
    expect(await fetchLineItemImage(db, config(), REF)).toBe(
      'https://cdn.shopify.com/p.jpg'
    );
  });

  it('queries only what it has ids for', async () => {
    fetchMock.mockResolvedValue(
      json({ data: { product: { featuredMedia: image('https://cdn.shopify.com/p.jpg') } } })
    );
    await fetchLineItemImage(db, config(), { variantId: null, productId: '22' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables).toEqual({ productId: 'gid://shopify/Product/22' });
    expect(body.query).not.toContain('productVariant');
  });

  it('returns null for a product with no picture or a deleted product', async () => {
    fetchMock.mockResolvedValue(
      json({ data: { productVariant: null, product: { featuredMedia: null } } })
    );
    expect(await fetchLineItemImage(db, config(), REF)).toBeNull();
  });

  it('gets a fresh token once when the cached one was revoked', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(
        json({ data: { product: { featuredMedia: image('https://cdn.shopify.com/p.jpg') } } })
      );
    expect(await fetchLineItemImage(db, config(), REF)).toBe(
      'https://cdn.shopify.com/p.jpg'
    );
    expect(fetchMock.mock.calls[2][1].headers['X-Shopify-Access-Token']).toBe(
      'fresh-token'
    );
  });

  it('never throws and never calls out without credentials', async () => {
    expect(await fetchLineItemImage(db, config(), null)).toBeNull();
    expect(
      await fetchLineItemImage(db, config({ api_client_secret: null }), REF)
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await fetchLineItemImage(db, config(), REF)).toBeNull();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    expect(await fetchLineItemImage(db, config(), REF)).toBeNull();
  });
});

describe('canWriteOrders', () => {
  it('needs the write_orders scope', () => {
    expect(canWriteOrders(['read_products', 'write_orders'])).toBe(true);
    expect(canWriteOrders(['read_orders', 'read_products'])).toBe(false);
  });
});

describe('addOrderTags', () => {
  const OK = { data: { tagsAdd: { userErrors: [] } } };
  const DENIED = {
    errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
  };

  it('adds the tags to the order by its global id', async () => {
    fetchMock.mockResolvedValue(json(OK));
    expect(
      await addOrderTags(db, config(), '18949134254390001', ['WHATSAPP CONFIRMED'])
    ).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.myshopify.com/admin/api/2026-07/graphql.json');
    expect(init.headers['X-Shopify-Access-Token']).toBe('cached-token');
    const body = JSON.parse(init.body);
    expect(body.query).toContain('tagsAdd');
    expect(body.variables).toEqual({
      id: 'gid://shopify/Order/18949134254390001',
      tags: ['WHATSAPP CONFIRMED'],
    });
  });

  it('gets a fresh token once when the cached one predates write_orders', async () => {
    fetchMock
      .mockResolvedValueOnce(json(DENIED))
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json(OK));
    expect(await addOrderTags(db, config(), '1', ['WHATSAPP CONFIRMED'])).toEqual({
      ok: true,
    });
    expect(fetchMock.mock.calls[2][1].headers['X-Shopify-Access-Token']).toBe(
      'fresh-token'
    );
  });

  it('reports a missing scope, a Shopify error and an outage without throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(json(DENIED))
      .mockResolvedValueOnce(json(TOKEN_RESPONSE))
      .mockResolvedValueOnce(json(DENIED));
    expect(await addOrderTags(db, config(), '1', ['x'])).toEqual({
      ok: false,
      error: 'missing_write_orders_scope',
    });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      json({ data: { tagsAdd: { userErrors: [{ message: 'Order not found' }] } } })
    );
    expect(await addOrderTags(db, config(), '1', ['x'])).toEqual({
      ok: false,
      error: 'Order not found',
    });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await addOrderTags(db, config(), '1', ['x'])).toEqual({
      ok: false,
      error: 'timeout',
    });
  });

  it('never calls out for a bad order id or without credentials', async () => {
    expect(await addOrderTags(db, config(), '1; drop', ['x'])).toEqual({
      ok: false,
      error: 'invalid_order_id',
    });
    expect(
      await addOrderTags(db, config({ api_client_id: null }), '1', ['x'])
    ).toEqual({ ok: false, error: 'no_app_credentials' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
