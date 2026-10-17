// ============================================================
// Web Push to the account's devices (installed app or browser).
//
// Keys come from the environment at runtime:
//   VAPID_PUBLIC_KEY   handed to browsers when they subscribe
//   VAPID_PRIVATE_KEY  signs every push
//   VAPID_SUBJECT      contact for the push services (mailto:/https:)
// Without them push is simply off: subscribing reports it, and sends
// are skipped.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export interface PushPayload {
  title: string;
  body: string;
  /** Path the notification opens, e.g. /inbox?c=<id>. */
  url: string;
  /** Notifications with the same tag replace each other (one per chat). */
  tag?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost';
  return { publicKey, privateKey, subject };
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A push service saying this device is gone for good. */
function isGone(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

/**
 * Send `payload` to every device subscribed in the account. Returns how
 * many accepted it. Never throws — a push problem must not affect the
 * message that triggered it.
 */
export async function sendPushToAccount(
  db: SupabaseClient,
  accountId: string,
  payload: PushPayload,
  options: { userId?: string } = {}
): Promise<number> {
  const vapid = vapidConfig();
  if (!vapid) return 0;
  try {
    let query = db
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('account_id', accountId);
    if (options.userId) query = query.eq('user_id', options.userId);
    const { data, error } = await query;
    if (error) {
      console.error('[push] loading subscriptions failed:', error.message);
      return 0;
    }
    const rows = (data ?? []) as SubscriptionRow[];
    if (rows.length === 0) return 0;

    const body = JSON.stringify(payload);
    const gone: string[] = [];
    const delivered: string[] = [];
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            body,
            {
              vapidDetails: vapid,
              TTL: 60 * 60,
              urgency: 'high',
              topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
            }
          );
          delivered.push(row.id);
        } catch (err) {
          if (isGone(err)) gone.push(row.id);
          else console.error('[push] send failed:', (err as Error)?.message ?? err);
        }
      })
    );

    if (gone.length > 0) {
      await db.from('push_subscriptions').delete().in('id', gone);
    }
    if (delivered.length > 0) {
      await db
        .from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .in('id', delivered);
    }
    return delivered.length;
  } catch (err) {
    console.error('[push] sendPushToAccount failed:', err);
    return 0;
  }
}
