// ============================================================
// GET /api/shopify/cron
//
// Sends the Shopify notifications whose delay has run out (cart
// reminders, any update with a delay) and retries order tags Shopify
// didn't take from the COD confirmation page.
//
// Nothing inside the app is scheduled: point an external scheduler at
// this URL once a minute, with the shared secret in `x-cron-secret`
// (`AUTOMATION_CRON_SECRET` — the same one the automations and flows
// crons use). Without it, delayed messages stay `scheduled` forever.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { retryCodTags } from '@/lib/shopify/cod-confirm';
import { runDueNotifications } from '@/lib/shopify/scheduled';

export const maxDuration = 60;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = supabaseAdmin();
  try {
    const notifications = await runDueNotifications(db);
    // Independent of the sends: one failing must not block the other.
    const tags = await retryCodTags(db).catch((err) => {
      console.error('[shopify cron] tag retry failed:', err);
      return { retried: 0, synced: 0 };
    });
    return NextResponse.json({ notifications, tags });
  } catch (err) {
    console.error('[shopify cron] failed:', err);
    return NextResponse.json({ error: 'cron run failed' }, { status: 500 });
  }
}
