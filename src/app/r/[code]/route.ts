// ============================================================
// GET /r/<code> — the CRM's own redirect for WhatsApp URL buttons.
//
// A template button set to https://<this CRM>/r/{{1}} gets a signed
// link code as {{1}} (see src/lib/shopify/link-codes.ts). This looks
// up the shipment or order the code names and redirects to its link as
// it is now:
//
//   t… → the shipment's tracking link (falling back to the order's
//        status page while the courier hasn't given one yet)
//   s… → the order's status page
//   c… → the abandoned checkout's cart link (FlexyPe or Shopify)
//
// Public — customers open it from WhatsApp. Anything unknown, unsigned
// or without a link gets a plain "link not available" page, never a
// redirect.
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  isRedirectableUrl,
  linkCodeMatches,
  parseLinkCode,
  type ParsedLinkCode,
} from '@/lib/shopify/link-codes';

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not available</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f6f4;color:#222}main{max-width:22rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;color:#666;font-size:.95rem;line-height:1.45}</style></head><body><main><h1>This link isn't available yet</h1><p>Tracking details appear once your parcel is handed to the courier, and a cart link stops working once its checkout expires. Please try again a little later, or reply to our WhatsApp message.</p></main></body></html>`;

function notAvailable(status = 404): Response {
  return new Response(NOT_FOUND_HTML, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

type Db = ReturnType<typeof supabaseAdmin>;

async function orderStatusUrl(
  db: Db,
  accountId: string,
  orderId: string | null
): Promise<string | null> {
  if (!orderId) return null;
  const { data } = await db
    .from('shopify_orders')
    .select('fields')
    .eq('account_id', accountId)
    .eq('shopify_order_id', orderId)
    .maybeSingle();
  const url = (data as { fields?: { order_status_url?: unknown } } | null)
    ?.fields?.order_status_url;
  return isRedirectableUrl(url) ? url : null;
}

/** Where the code leads, or null. Every candidate row's signature is checked. */
async function resolve(db: Db, parsed: ParsedLinkCode): Promise<string | null> {
  if (parsed.kind === 't') {
    const { data } = await db
      .from('shopify_fulfillments')
      .select('account_id, shopify_order_id, tracking_url')
      .eq('shopify_fulfillment_id', parsed.id)
      .limit(5);
    const rows =
      (data as
        | { account_id: string; shopify_order_id: string | null; tracking_url: string | null }[]
        | null) ?? [];
    const row = rows.find((r) => linkCodeMatches(parsed, r.account_id));
    if (!row) return null;
    if (isRedirectableUrl(row.tracking_url)) return row.tracking_url;
    return orderStatusUrl(db, row.account_id, row.shopify_order_id);
  }

  if (parsed.kind === 'c') {
    const { data } = await db
      .from('shopify_checkouts')
      .select('account_id, fields')
      .eq('shopify_checkout_id', parsed.id)
      .limit(5);
    const rows =
      (data as
        | { account_id: string; fields: { checkout_url?: unknown } | null }[]
        | null) ?? [];
    const row = rows.find((r) => linkCodeMatches(parsed, r.account_id));
    const url = row?.fields?.checkout_url;
    return isRedirectableUrl(url) ? url : null;
  }

  const { data } = await db
    .from('shopify_orders')
    .select('account_id')
    .eq('shopify_order_id', parsed.id)
    .limit(5);
  const rows = (data as { account_id: string }[] | null) ?? [];
  const row = rows.find((r) => linkCodeMatches(parsed, r.account_id));
  return row ? orderStatusUrl(db, row.account_id, parsed.id) : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const limit = checkRateLimit(
    `shopify:link:${clientIp(request)}`,
    RATE_LIMITS.publicLink
  );
  if (!limit.success) return notAvailable(429);

  const { code } = await params;
  const parsed = parseLinkCode(decodeURIComponent(code));
  if (!parsed) return notAvailable();

  try {
    const target = await resolve(supabaseAdmin(), parsed);
    if (!target) return notAvailable();
    // 302 + no-store: the link must follow the shipment as it changes.
    return NextResponse.redirect(target, {
      status: 302,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[shopify link] lookup failed:', err);
    return notAvailable(503);
  }
}
