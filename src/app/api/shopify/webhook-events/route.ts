// ============================================================
// GET /api/shopify/webhook-events
//
// The webhook log for Settings → Shopify: the most recent deliveries
// Shopify made to this account, newest first, without their payloads
// (those are fetched one at a time from ./[id]). Admin+ only — the
// rows describe customers' orders — enforced here and by RLS.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

const COLUMNS =
  'id, received_at, topic, shopify_webhook_id, order_ref, status, detail, outcome';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const requested = Number(new URL(request.url).searchParams.get('limit'));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const { data, error } = await ctx.supabase
      .from('shopify_webhook_events')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('[GET /api/shopify/webhook-events] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load the webhook log' },
        { status: 500 }
      );
    }

    return NextResponse.json({ events: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
