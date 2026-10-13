// ============================================================
// /api/shopify/config
//
//   GET    — this account's Shopify connection (safe columns only).
//   PUT    — connect, or update the secret / country code / pause.
//   DELETE — disconnect.
//
// Dashboard endpoints: cookie session, RLS client. Any member may see
// whether a store is connected; only admin+ may change it, and only
// admin+ is told the webhook URL — the URL token is half of what
// authenticates a delivery. The signing secret is write-only: it is
// encrypted on the way in and never returned.
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
import { generateWebhookToken, shopifyWebhookPath } from '@/lib/shopify/config';
import { encrypt } from '@/lib/whatsapp/encryption';

// `webhook_secret` is deliberately excluded — it never leaves the server.
const SAFE_COLUMNS =
  'id, webhook_token, shop_domain, default_country_code, is_active, last_webhook_at, created_at';

const MAX_SECRET_LEN = 256;

interface ConfigRow {
  id: string;
  webhook_token: string;
  shop_domain: string | null;
  default_country_code: string | null;
  is_active: boolean;
  last_webhook_at: string | null;
  created_at: string;
}

function present(row: ConfigRow, includeWebhookPath: boolean) {
  return {
    id: row.id,
    shop_domain: row.shop_domain,
    default_country_code: row.default_country_code,
    is_active: row.is_active,
    last_webhook_at: row.last_webhook_at,
    created_at: row.created_at,
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
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (findErr) {
      console.error('[PUT /api/shopify/config] lookup error:', findErr);
      return NextResponse.json(
        { error: 'Failed to save Shopify settings' },
        { status: 500 }
      );
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
