// ============================================================
// Shopify Admin API client (server-only) — product image lookup and
// order tags.
//
// Order webhooks name the product but carry no picture. When the
// merchant has pasted the credentials of a Dev Dashboard app, we
// exchange them for a 24-hour access token (client-credentials
// grant), cache the token encrypted on the config row, and ask the
// Admin GraphQL API for the first line item's image. The same token
// tags an order when the customer answers on the COD confirmation
// page (needs the app's `write_orders` scope).
//
// Everything here is best-effort from the webhook's point of view:
// `fetchLineItemImage` never throws, because a missing picture must
// not cost the customer their order message.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import type { ShopifyConfigRow } from './config';
import type { LineItemRef } from './order-fields';

const API_VERSION = '2026-07';
const TIMEOUT_MS = 5000;
// Refresh a little early so a token can't expire mid-request.
const TOKEN_SAFETY_MS = 5 * 60 * 1000;
// JPG, bounded width: always within WhatsApp's 5 MB image limit.
const IMAGE = 'image { url(transform: {maxWidth: 1200, preferredContentType: JPG}) }';

/**
 * Only ever call a real Shopify admin host. The domain is learned
 * from a signed webhook header or typed by an admin; either way it
 * must not be able to point our server-side fetch somewhere else.
 */
export function isMyshopifyDomain(domain: string | null | undefined): domain is string {
  return (
    typeof domain === 'string' &&
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
  );
}

export type ShopifyApiErrorCode =
  | 'invalid_shop'
  | 'shop_not_permitted'
  | 'app_not_installed'
  | 'invalid_credentials'
  | 'unavailable';

export class ShopifyApiError extends Error {
  readonly code: ShopifyApiErrorCode;
  constructor(code: ShopifyApiErrorCode, message: string) {
    super(message);
    this.name = 'ShopifyApiError';
    this.code = code;
  }
}

export interface ShopifyAccessToken {
  token: string;
  /** ISO timestamp. */
  expiresAt: string;
  scopes: string[];
}

/**
 * Exchange app credentials for an access token. Throws
 * `ShopifyApiError` with a code the settings UI can explain.
 */
export async function requestAccessToken(
  shopDomain: string,
  clientId: string,
  clientSecret: string
): Promise<ShopifyAccessToken> {
  if (!isMyshopifyDomain(shopDomain)) {
    throw new ShopifyApiError(
      'invalid_shop',
      'Store domain must look like your-store.myshopify.com'
    );
  }

  let response: Response;
  try {
    response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ShopifyApiError('unavailable', 'Could not reach Shopify');
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    if (text.includes('shop_not_permitted')) {
      throw new ShopifyApiError(
        'shop_not_permitted',
        'This app and this store are not in the same Shopify organization'
      );
    }
    if (text.includes('app_not_installed')) {
      throw new ShopifyApiError(
        'app_not_installed',
        'The Shopify app is not installed on this store yet. Release a version of the app and install it on the store, then try again.'
      );
    }
    if (response.status >= 500) {
      throw new ShopifyApiError('unavailable', 'Shopify is unavailable');
    }
    throw new ShopifyApiError(
      'invalid_credentials',
      'Shopify rejected the client ID or secret'
    );
  }

  let body: { access_token?: unknown; scope?: unknown; expires_in?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ShopifyApiError('unavailable', 'Unexpected response from Shopify');
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new ShopifyApiError('unavailable', 'Unexpected response from Shopify');
  }
  const expiresIn =
    typeof body.expires_in === 'number' && body.expires_in > 0
      ? body.expires_in
      : 3600;
  return {
    token: body.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes:
      typeof body.scope === 'string'
        ? body.scope.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
  };
}

/** `write_products` implies read access. */
export function canReadProducts(scopes: string[]): boolean {
  return scopes.includes('read_products') || scopes.includes('write_products');
}

/** Adding a tag to an order is an order write. */
export function canWriteOrders(scopes: string[]): boolean {
  return scopes.includes('write_orders');
}

export function hasApiCredentials(config: ShopifyConfigRow): boolean {
  return Boolean(
    config.api_client_id &&
      config.api_client_secret &&
      isMyshopifyDomain(config.shop_domain)
  );
}

/**
 * A usable access token for this store: the cached one while it has
 * time left, otherwise a fresh one (stored back, encrypted). Returns
 * `null` when the store has no credentials or Shopify refuses them.
 */
export async function getShopifyAccessToken(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  options: { forceRefresh?: boolean } = {}
): Promise<string | null> {
  if (!hasApiCredentials(config)) return null;

  try {
    if (
      !options.forceRefresh &&
      config.api_access_token &&
      config.api_token_expires_at &&
      Date.parse(config.api_token_expires_at) - Date.now() > TOKEN_SAFETY_MS
    ) {
      return decrypt(config.api_access_token);
    }

    const issued = await requestAccessToken(
      config.shop_domain!,
      config.api_client_id!,
      decrypt(config.api_client_secret!)
    );
    const { error } = await db
      .from('shopify_configs')
      .update({
        api_access_token: encrypt(issued.token),
        api_token_expires_at: issued.expiresAt,
        api_scopes: issued.scopes.join(','),
      })
      .eq('id', config.id);
    if (error) {
      // The token still works for this request; we just pay for
      // another exchange next time.
      console.error('[shopify] could not cache access token:', error.message);
    }
    return issued.token;
  } catch (err) {
    console.error(
      '[shopify] access token unavailable:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function imageUrlAt(value: unknown): string | null {
  const url = (value as { preview?: { image?: { url?: unknown } } } | null)
    ?.preview?.image?.url;
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

async function queryImage(
  shopDomain: string,
  token: string,
  ref: LineItemRef
): Promise<{ status: number; url: string | null }> {
  const declarations: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string> = {};
  if (ref.variantId) {
    declarations.push('$variantId: ID!');
    selections.push(
      `productVariant(id: $variantId) { media(first: 1) { nodes { preview { ${IMAGE} } } } }`
    );
    variables.variantId = `gid://shopify/ProductVariant/${ref.variantId}`;
  }
  if (ref.productId) {
    declarations.push('$productId: ID!');
    selections.push(
      `product(id: $productId) { featuredMedia { preview { ${IMAGE} } } }`
    );
    variables.productId = `gid://shopify/Product/${ref.productId}`;
  }

  const response = await fetch(
    `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        query: `query LineItemImage(${declarations.join(', ')}) { ${selections.join(' ')} }`,
        variables,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!response.ok) return { status: response.status, url: null };

  const body = (await response.json()) as {
    data?: {
      productVariant?: { media?: { nodes?: unknown[] } } | null;
      product?: { featuredMedia?: unknown } | null;
    };
  };
  // The variant's own picture (the colour the customer chose) beats
  // the product's featured image.
  const url =
    imageUrlAt(body.data?.productVariant?.media?.nodes?.[0]) ??
    imageUrlAt(body.data?.product?.featuredMedia);
  return { status: response.status, url };
}

/**
 * Picture link for an order's first line item, or `null` — no
 * credentials, no image on the product, Shopify down, anything.
 * Never throws.
 */
export async function fetchLineItemImage(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  ref: LineItemRef | null
): Promise<string | null> {
  if (!ref || !hasApiCredentials(config)) return null;

  try {
    let token = await getShopifyAccessToken(db, config);
    if (!token) return null;

    let result = await queryImage(config.shop_domain!, token, ref);
    if (result.status === 401) {
      // Cached token was revoked (credentials rotated, app reinstalled).
      token = await getShopifyAccessToken(db, config, { forceRefresh: true });
      if (!token) return null;
      result = await queryImage(config.shop_domain!, token, ref);
    }
    if (result.status >= 400) {
      console.error('[shopify] product image lookup failed:', result.status);
    }
    return result.url;
  } catch (err) {
    console.error(
      '[shopify] product image lookup threw:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

const TAGS_ADD = `mutation AddOrderTags($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { message } }
}`;

async function mutateTags(
  shopDomain: string,
  token: string,
  orderId: string,
  tags: string[]
): Promise<{ status: number; error: string | null }> {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        query: TAGS_ADD,
        variables: { id: `gid://shopify/Order/${orderId}`, tags },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    return { status: response.status, error: `shopify_http_${response.status}` };
  }

  const body = (await response.json()) as {
    errors?: { message?: unknown; extensions?: { code?: unknown } }[];
    data?: { tagsAdd?: { userErrors?: { message?: unknown }[] } | null };
  };
  const top = body.errors?.[0];
  if (top) {
    // What Shopify answers when the app was never given write_orders.
    if (top.extensions?.code === 'ACCESS_DENIED') {
      return { status: 200, error: 'missing_write_orders_scope' };
    }
    return {
      status: 200,
      error: typeof top.message === 'string' ? top.message : 'shopify_error',
    };
  }
  const userError = body.data?.tagsAdd?.userErrors?.[0]?.message;
  if (typeof userError === 'string' && userError) {
    return { status: 200, error: userError };
  }
  return { status: 200, error: null };
}

export type AddTagsResult = { ok: true } | { ok: false; error: string };

/**
 * Add tags to a Shopify order (existing tags are kept; adding one
 * twice is a no-op). Needs the app's `write_orders` scope. Never
 * throws — the caller records the error and retries later.
 */
export async function addOrderTags(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  orderId: string,
  tags: string[]
): Promise<AddTagsResult> {
  if (!/^\d+$/.test(orderId)) return { ok: false, error: 'invalid_order_id' };
  if (!hasApiCredentials(config)) return { ok: false, error: 'no_app_credentials' };

  try {
    let token = await getShopifyAccessToken(db, config);
    if (!token) return { ok: false, error: 'no_access_token' };

    let result = await mutateTags(config.shop_domain!, token, orderId, tags);
    // 401: the cached token was revoked. Access denied: it may simply
    // predate the merchant adding write_orders — a token keeps the
    // scopes it was issued with for its whole 24 hours.
    if (result.status === 401 || result.error === 'missing_write_orders_scope') {
      token = await getShopifyAccessToken(db, config, { forceRefresh: true });
      if (!token) return { ok: false, error: 'no_access_token' };
      result = await mutateTags(config.shop_domain!, token, orderId, tags);
    }
    return result.error
      ? { ok: false, error: result.error.slice(0, 300) }
      : { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: (err instanceof Error ? err.message : 'unknown_error').slice(0, 300),
    };
  }
}
