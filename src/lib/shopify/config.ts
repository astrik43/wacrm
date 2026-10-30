// ============================================================
// Shopify connection config (server-only).
//
// One row per account in `shopify_configs`. The webhook URL carries an
// unguessable token that selects the row; the row's signing secret
// then authenticates the delivery. Service-role client only — the
// webhook has no auth.uid().
// ============================================================

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ShopifyConfigRow {
  id: string;
  account_id: string;
  webhook_token: string;
  /** AES-256-GCM ciphertext — `decrypt()` before use. */
  webhook_secret: string;
  shop_domain: string | null;
  default_country_code: string | null;
  is_active: boolean;
  last_webhook_at: string | null;
  /** Dev Dashboard app credentials — set only when product images are on. */
  api_client_id: string | null;
  /** AES-256-GCM ciphertext. */
  api_client_secret: string | null;
  /** AES-256-GCM ciphertext of the cached 24-hour Admin API token. */
  api_access_token: string | null;
  api_token_expires_at: string | null;
  /** Comma-separated scopes of the app, as of the last token exchange. */
  api_scopes: string | null;
  /** AES-256-GCM ciphertext of the FlexyPe webhook secret; null = off. */
  flexype_secret: string | null;
  flexype_last_webhook_at: string | null;
  /** AES-256-GCM ciphertext of the Shiprocket Checkout webhook secret; null = off. */
  shiprocket_secret: string | null;
  shiprocket_last_webhook_at: string | null;
  /** Only test_phones get messages while this is on. */
  test_mode: boolean;
  test_phones: string[] | null;
}

const CONFIG_COLUMNS =
  'id, account_id, webhook_token, webhook_secret, shop_domain, default_country_code, is_active, last_webhook_at, api_client_id, api_client_secret, api_access_token, api_token_expires_at, api_scopes, flexype_secret, flexype_last_webhook_at, shiprocket_secret, shiprocket_last_webhook_at, test_mode, test_phones';

/** 32 url-safe characters (192 bits) — the path segment of the webhook URL. */
export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function shopifyWebhookPath(token: string): string {
  return `/api/shopify/webhook/${token}`;
}

/** Where FlexyPe delivers abandoned checkouts for the same account. */
export function flexypeWebhookPath(token: string): string {
  return `/api/flexype/webhook/${token}`;
}

/** Where Shiprocket Checkout (Fastrr) delivers abandoned carts. */
export function shiprocketWebhookPath(token: string): string {
  return `/api/shiprocket/webhook/${token}`;
}

/** The account's connection, for work that has no webhook token. */
export async function getShopifyConfigByAccount(
  db: SupabaseClient,
  accountId: string
): Promise<ShopifyConfigRow | null> {
  const { data, error } = await db
    .from('shopify_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[shopify] config lookup failed:', error.message);
    return null;
  }
  return (data as ShopifyConfigRow | null) ?? null;
}

/**
 * Look up the config a webhook URL token belongs to. `error` is set
 * only for a database failure, so the route can answer 503 (Shopify
 * retries) instead of 404 (it eventually drops the webhook).
 */
export async function getShopifyConfigByToken(
  db: SupabaseClient,
  token: string
): Promise<{ config: ShopifyConfigRow | null; error: boolean }> {
  // Tokens are base64url; anything else can't match and shouldn't
  // reach the query.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return { config: null, error: false };
  }
  const { data, error } = await db
    .from('shopify_configs')
    .select(CONFIG_COLUMNS)
    .eq('webhook_token', token)
    .maybeSingle();
  if (error) {
    console.error('[shopify] config lookup failed:', error.message);
    return { config: null, error: true };
  }
  return { config: (data as ShopifyConfigRow | null) ?? null, error: false };
}
