// ============================================================
// POST /api/push/test — send a test notification to the caller's own
// devices, so they can check notifications arrive on their phone.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit';
import { sendPushToAccount, vapidConfig } from '@/lib/push/web-push';

export async function POST() {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`push:test:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    if (!vapidConfig()) {
      return NextResponse.json(
        { error: 'Push notifications are not configured on the server' },
        { status: 503 }
      );
    }
    const sent = await sendPushToAccount(
      supabaseAdmin(),
      ctx.accountId,
      {
        title: 'Test notification',
        body: 'Notifications are working on this device.',
        url: '/inbox',
        tag: 'test',
      },
      { userId: ctx.userId }
    );
    return NextResponse.json({ sent });
  } catch (err) {
    return toErrorResponse(err);
  }
}
