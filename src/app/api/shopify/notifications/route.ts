// ============================================================
// GET /api/shopify/notifications
//
// Recent Shopify-triggered sends for the Activity list in Settings →
// Shopify: one row per order update with its outcome (sent, skipped
// with a reason, failed with a reason). Any member may read it.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

const COLUMNS =
  'id, event, order_name, shopify_order_id, status, reason, created_at';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const requested = Number(new URL(request.url).searchParams.get('limit'));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const { data, error } = await ctx.supabase
      .from('shopify_notifications')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('[GET /api/shopify/notifications] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load activity' },
        { status: 500 }
      );
    }

    return NextResponse.json({ notifications: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
