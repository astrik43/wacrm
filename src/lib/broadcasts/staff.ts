// Staff contacts (contacts.is_staff, migration 055) are the team, not
// customers: they must never be part of a broadcast audience or its
// reach count. Staff are few, so the audience counts in the wizard
// fetch their ids once and subtract them.

import type { SupabaseClient } from '@supabase/supabase-js';

const PAGE = 1000;

/**
 * Ids of the staff contacts. The browser client is already scoped to
 * the caller's account by RLS; a service-role caller passes `accountId`.
 */
export async function fetchStaffContactIds(
  db: SupabaseClient,
  accountId?: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    let q = db.from('contacts').select('id').eq('is_staff', true);
    if (accountId) q = q.eq('account_id', accountId);
    const { data } = await q.range(from, from + PAGE - 1);
    const rows = (data ?? []) as { id: string }[];
    for (const r of rows) ids.add(r.id);
    if (rows.length < PAGE) break;
  }
  return ids;
}
