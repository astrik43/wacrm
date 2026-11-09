// ============================================================
// POST /api/shopify/tags/delivered — tag past delivered customers
// (admin+)
//
// Body: `{ after?: string }`. Reads one page of the store's orders from
// Shopify (oldest first) and tags the customers of the delivered ones
// "Order Delivered"; answers with that page's counts and the cursor of
// the next page (null when done). The settings page calls it in a loop.
// See src/lib/shopify/delivered-backfill.ts.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { hasApiCredentials } from '@/lib/shopify/admin-api';
import { getShopifyConfigByAccount } from '@/lib/shopify/config';
import { tagDeliveredCustomersPage } from '@/lib/shopify/delivered-backfill';

const MAX_CURSOR_LEN = 1000;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyDeliveredTags:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      after?: unknown;
    } | null;
    const after =
      typeof body?.after === 'string' && body.after
        ? body.after.slice(0, MAX_CURSOR_LEN)
        : null;

    const db = supabaseAdmin();
    const config = await getShopifyConfigByAccount(db, ctx.accountId);
    if (!config) {
      return NextResponse.json(
        { error: 'Shopify is not connected' },
        { status: 400 }
      );
    }
    if (!hasApiCredentials(config)) {
      return NextResponse.json(
        {
          error:
            'Add your Shopify app credentials (Product images & order tags) first',
        },
        { status: 400 }
      );
    }

    const result = await tagDeliveredCustomersPage(db, config, after);
    if (!result.ok) {
      // Shopify's own message names what is missing (a scope, or
      // access to protected customer data).
      const error = `Shopify refused: ${result.error}`;
      return NextResponse.json({ error }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
