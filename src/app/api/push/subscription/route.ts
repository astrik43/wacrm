// ============================================================
// /api/push/subscription — this device's Web Push subscription.
//
//   GET     whether push is configured, and the public key a browser
//           needs to subscribe (read at runtime, so the key isn't baked
//           into the build)
//   POST    save { endpoint, keys: { p256dh, auth } } for the caller
//   DELETE  remove { endpoint } for the caller
//
// Any member may use it: notifications are for whoever reads the inbox.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { vapidConfig } from '@/lib/push/web-push';

const MAX_ENDPOINT = 2048;
const KEY_RE = /^[A-Za-z0-9_-]{8,256}={0,2}$/;

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    await getCurrentAccount();
    const vapid = vapidConfig();
    return NextResponse.json({
      enabled: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    } | null;
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (
      !validEndpoint(endpoint) ||
      typeof p256dh !== 'string' ||
      typeof auth !== 'string' ||
      !KEY_RE.test(p256dh) ||
      !KEY_RE.test(auth)
    ) {
      return NextResponse.json(
        { error: 'Invalid push subscription' },
        { status: 400 }
      );
    }

    const { error } = await supabaseAdmin()
      .from('push_subscriptions')
      .upsert(
        {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          endpoint,
          p256dh,
          auth,
          user_agent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
        },
        { onConflict: 'endpoint' }
      );
    if (error) {
      console.error('[push] subscription save failed:', error.message);
      return NextResponse.json(
        { error: 'Could not save this device' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown;
    } | null;
    if (!validEndpoint(body?.endpoint)) {
      return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400 });
    }
    await supabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', body.endpoint)
      .eq('user_id', ctx.userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
