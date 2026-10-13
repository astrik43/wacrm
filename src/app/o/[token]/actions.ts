'use server';

// ============================================================
// Server Action behind the two buttons on /o/[token].
//
// Reachable by a direct POST from anyone, so it trusts nothing but
// the token: `decideCodOrder` looks the order up by it and records
// only a first decision. Rate-limited per token to bound replays.
// ============================================================

import { refresh } from 'next/cache';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { decideCodOrder, isCodDecision } from '@/lib/shopify/cod-confirm';

export async function submitCodDecision(
  token: string,
  decision: string
): Promise<void> {
  if (typeof token !== 'string' || !isCodDecision(decision)) return;

  const limit = checkRateLimit(
    `shopify:codConfirm:${token}`,
    RATE_LIMITS.invitationRedeem
  );
  if (limit.success) {
    await decideCodOrder(supabaseAdmin(), token, decision);
  }
  // Re-render with whatever now stands, including "already answered".
  refresh();
}
