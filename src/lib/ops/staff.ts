// ============================================================
// Staff-contact helpers: the flag lives on contacts.is_staff
// (migration 055). Staff are internal team members, never customers.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `phone` (digits-only or with a leading +) belongs to a staff
 * contact of the account. Fails open (false) on any error: an order
 * update to a team member is harmless, a dropped customer update is not.
 */
export async function isStaffPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string | null
): Promise<boolean> {
  if (!phone) return false;
  try {
    const digits = phone.replace(/^\+/, '');
    const { data, error } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_staff', true)
      .in('phone', [digits, `+${digits}`])
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Timestamp of the contact's latest inbound message in a conversation, or null. */
export async function lastInboundAt(
  db: SupabaseClient,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`message lookup failed: ${error.message}`);
  return ((data as { created_at: string }[] | null) ?? [])[0]?.created_at ?? null;
}

export function withinWindow(lastInbound: string | null, now = Date.now()): boolean {
  if (!lastInbound) return false;
  const t = Date.parse(lastInbound);
  return Number.isFinite(t) && now - t < WINDOW_MS;
}

/** The newest conversation of a contact (account-scoped), or null. */
export async function latestConversationId(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  return ((data as { id: string }[] | null) ?? [])[0]?.id ?? null;
}
