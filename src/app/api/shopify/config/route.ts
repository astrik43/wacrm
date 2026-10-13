// ============================================================
// /api/shopify/config
//
//   GET    — this account's Shopify connection (safe columns only).
//   PUT    — connect, or update the secret / country code / pause /
//            Shopify app credentials (for product images).
//   DELETE — disconnect.
//
// Dashboard endpoints: cookie session, RLS client. Any member may see
// whether a store is connected; only admin+ may change it, and only
// admin+ is told the webhook URL — the URL token is half of what
// authenticates a delivery. The signing secret is write-only: it is
// encrypted on the way in and never returned.
//
// App credentials (client id + secret of a Dev Dashboard app) are
// checked against Shopify before they are saved, so a wrong secret or
// a store outside the app's organization is reported here rather than
// as silently missing pictures later. The secret and the access token
// are write-only too; only the client id is ever read back.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  canReadProducts,
  isMyshopifyDomain,
  requestAccessToken,
  ShopifyApiError,
} from '@/lib/shopify/admin-api';
import { generateWebhookToken, shopifyWebhookPath } from '@/lib/shopify/config';
import { encrypt } from '@/lib/whatsapp/encryption';

// `webhook_secret`, `api_client_secret` and `api_access_token` are
// deliberately excluded — they never leave the server.
const SAFE_COLUMNS =
  'id, webhook_token, shop_domain, default_country_code, is_active, last_webhook_at, created_at, api_client_id';

const MAX_SECRET_LEN = 256;

interface ConfigRow {
  id: string;
  webhook_token: string;
  shop_domain: string | null;
  default_country_code: string | null;
  is_active: boolean;
  last_webhook_at: string | null;
  created_at: string;
  api_client_id?: string | null;
}

function present(row: ConfigRow, includeWebhookPath: boolean) {
  return {
    id: row.id,
    shop_domain: row.shop_domain,
    default_country_code: row.default_country_code,
    is_active: row.is_active,
    last_webhook_at: row.last_webhook_at,
    created_at: row.created_at,
    has_api_credentials: Boolean(row.api_client_id),
    api_client_id: includeWebhookPath ? (row.api_client_id ?? null) : null,
    webhook_path: includeWebhookPath
      ? shopifyWebhookPath(row.webhook_token)
      : null,
  };
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('shopify_configs')
      .select(SAFE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[GET /api/shopify/config] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load Shopify settings' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      config: data
        ? present(data as ConfigRow, hasMinRole(ctx.role, 'admin'))
        : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyConfig:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      webhook_secret?: unknown;
      default_country_code?: unknown;
      is_active?: unknown;
      api_client_id?: unknown;
      api_client_secret?: unknown;
      shop_domain?: unknown;
    } | null;

    const patch: Record<string, unknown> = {};

    if (body?.webhook_secret !== undefined) {
      const secret =
        typeof body.webhook_secret === 'string'
          ? body.webhook_secret.trim()
          : '';
      if (!secret || secret.length > MAX_SECRET_LEN) {
        return NextResponse.json(
          { error: "'webhook_secret' must be a non-empty string" },
          { status: 400 }
        );
      }
      patch.webhook_secret = encrypt(secret);
    }

    if (body?.default_country_code !== undefined) {
      const raw = body.default_country_code;
      if (raw === null || raw === '') {
        patch.default_country_code = null;
      } else {
        const code = typeof raw === 'string' ? raw.replace(/^\+/, '').trim() : '';
        if (!/^[1-9][0-9]{0,2}$/.test(code)) {
          return NextResponse.json(
            { error: "'default_country_code' must be 1-3 digits, e.g. 91" },
            { status: 400 }
          );
        }
        patch.default_country_code = code;
      }
    }

    if (body?.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') {
        return NextResponse.json(
          { error: "'is_active' must be a boolean" },
          { status: 400 }
        );
      }
      patch.is_active = body.is_active;
    }

    const { data: existing, error: findErr } = await ctx.supabase
      .from('shopify_configs')
      .select('id, shop_domain')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (findErr) {
      console.error('[PUT /api/shopify/config] lookup error:', findErr);
      return NextResponse.json(
        { error: 'Failed to save Shopify settings' },
        { status: 500 }
      );
    }

    if (body?.api_client_id === null) {
      // Turn product images off.
      patch.api_client_id = null;
      patch.api_client_secret = null;
      patch.api_access_token = null;
      patch.api_token_expires_at = null;
    } else if (
      body?.api_client_id !== undefined ||
      body?.api_client_secret !== undefined
    ) {
      const clientId =
        typeof body.api_client_id === 'string' ? body.api_client_id.trim() : '';
      const clientSecret =
        typeof body.api_client_secret === 'string'
          ? body.api_client_secret.trim()
          : '';
      if (
        !clientId ||
        !clientSecret ||
        clientId.length > MAX_SECRET_LEN ||
        clientSecret.length > MAX_SECRET_LEN
      ) {
        return NextResponse.json(
          { error: 'Enter both the client ID and the client secret' },
          { status: 400 }
        );
      }

      // The store is normally known from its first webhook; before
      // that, the admin can type it.
      const typedDomain =
        typeof body.shop_domain === 'string'
          ? body.shop_domain
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, '')
              .replace(/\/.*$/, '')
          : '';
      const shopDomain =
        typedDomain || (existing?.shop_domain as string | null) || '';
      if (!isMyshopifyDomain(shopDomain)) {
        return NextResponse.json(
          {
            error:
              'Enter your store domain (your-store.myshopify.com), or send a test webhook from Shopify first',
          },
          { status: 400 }
        );
      }

      try {
        const issued = await requestAccessToken(
          shopDomain,
          clientId,
          clientSecret
        );
        if (!canReadProducts(issued.scopes)) {
          return NextResponse.json(
            {
              error:
                'The Shopify app is missing the read_products access scope. Add it, release a new version and approve it on the store.',
            },
            { status: 400 }
          );
        }
        patch.api_client_id = clientId;
        patch.api_client_secret = encrypt(clientSecret);
        patch.api_access_token = encrypt(issued.token);
        patch.api_token_expires_at = issued.expiresAt;
        patch.shop_domain = shopDomain;
      } catch (err) {
        if (err instanceof ShopifyApiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: err.code === 'unavailable' ? 502 : 400 }
          );
        }
        throw err;
      }
    }

    if (!existing) {
      if (!patch.webhook_secret) {
        return NextResponse.json(
          { error: "'webhook_secret' is required to connect a store" },
          { status: 400 }
        );
      }
      const { data, error } = await ctx.supabase
        .from('shopify_configs')
        .insert({
          ...patch,
          account_id: ctx.accountId,
          created_by: ctx.userId,
          webhook_token: generateWebhookToken(),
        })
        .select(SAFE_COLUMNS)
        .single();
      if (error || !data) {
        console.error('[PUT /api/shopify/config] insert error:', error);
        return NextResponse.json(
          { error: 'Failed to save Shopify settings' },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { config: present(data as ConfigRow, true) },
        { status: 201 }
      );
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from('shopify_configs')
      .update(patch)
      .eq('id', existing.id)
      .eq('account_id', ctx.accountId)
      .select(SAFE_COLUMNS)
      .single();
    if (error || !data) {
      console.error('[PUT /api/shopify/config] update error:', error);
      return NextResponse.json(
        { error: 'Failed to save Shopify settings' },
        { status: 500 }
      );
    }
    return NextResponse.json({ config: present(data as ConfigRow, true) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');

    // Removing the row invalidates the webhook URL. Event mappings are
    // kept so reconnecting doesn't mean re-mapping six templates.
    const { error } = await ctx.supabase
      .from('shopify_configs')
      .delete()
      .eq('account_id', ctx.accountId);
    if (error) {
      console.error('[DELETE /api/shopify/config] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to disconnect Shopify' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
