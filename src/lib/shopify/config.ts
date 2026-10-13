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
}

const CONFIG_COLUMNS =
  'id, account_id, webhook_token, webhook_secret, shop_domain, default_country_code, is_active, last_webhook_at';

/** 32 url-safe characters (192 bits) — the path segment of the webhook URL. */
export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function shopifyWebhookPath(token: string): string {
  return `/api/shopify/webhook/${token}`;
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
