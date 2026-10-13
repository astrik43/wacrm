// ============================================================
// GET /api/shopify/webhook-events/[id]
//
// One logged delivery including its payload, for the detail view in
// Settings → Shopify. Admin+ only.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

const COLUMNS =
  'id, received_at, topic, shopify_webhook_id, shop_domain, order_ref, status, detail, outcome, payload';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data, error } = await ctx.supabase
      .from('shopify_webhook_events')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('[GET /api/shopify/webhook-events/[id]] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load the webhook event' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ event: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
