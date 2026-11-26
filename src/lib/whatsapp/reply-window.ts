// ============================================================
// WhatsApp customer-service window: free-form messages (text, media,
// interactive) may only be sent within 24 hours of the customer's last
// inbound message; outside it only an approved template is allowed.
// Same rule the inbox composer applies (message-thread.tsx).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReplyWindow {
  /** True when a free-form message can be sent right now. */
  open: boolean;
  last_customer_message_at: string | null;
  /** ISO deadline (last inbound + 24h); null when the customer never wrote. */
  expires_at: string | null;
  /** Seconds left, 0 when closed. */
  remaining_seconds: number;
}

/** Pure: compute the window from the last inbound timestamp. */
export function computeReplyWindow(
  lastCustomerMessageAt: string | null | undefined,
  now: Date = new Date()
): ReplyWindow {
  const last = lastCustomerMessageAt
    ? new Date(lastCustomerMessageAt).getTime()
    : NaN;
  if (Number.isNaN(last)) {
    return {
      open: false,
      last_customer_message_at: null,
      expires_at: null,
      remaining_seconds: 0,
    };
  }
  const expires = last + REPLY_WINDOW_MS;
  const remainingMs = expires - now.getTime();
  return {
    open: remainingMs > 0,
    last_customer_message_at: new Date(last).toISOString(),
    expires_at: new Date(expires).toISOString(),
    remaining_seconds: remainingMs > 0 ? Math.floor(remainingMs / 1000) : 0,
  };
}

/** Look up the conversation's latest inbound message and compute the window. */
export async function getReplyWindow(
  db: SupabaseClient,
  conversationId: string,
  now: Date = new Date()
): Promise<ReplyWindow> {
  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return computeReplyWindow(
    (data as { created_at?: string } | null)?.created_at,
    now
  );
}
