// ============================================================
// Ops settings (one row per account, migration 056): the NDR switch
// and template, the staff-document template, and the tags the ERP
// sync may touch. Defaults apply when no row exists: NDR OFF.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_SYNC_TAGS = ['Order RTO', 'Blocked', 'Partial pay'];

export interface OpsSettings {
  ndr_enabled: boolean;
  ndr_template_name: string | null;
  ndr_template_language: string | null;
  staff_doc_template_name: string | null;
  staff_doc_template_language: string | null;
  sync_tags: string[];
}

export const DEFAULT_OPS_SETTINGS: OpsSettings = {
  ndr_enabled: false,
  ndr_template_name: null,
  ndr_template_language: null,
  staff_doc_template_name: null,
  staff_doc_template_language: null,
  sync_tags: DEFAULT_SYNC_TAGS,
};

const COLUMNS =
  'ndr_enabled, ndr_template_name, ndr_template_language, staff_doc_template_name, staff_doc_template_language, sync_tags';

/** The account's settings, or the defaults when it has none yet. Throws on a DB error. */
export async function getOpsSettings(
  db: SupabaseClient,
  accountId: string
): Promise<OpsSettings> {
  const { data, error } = await db
    .from('ops_settings')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`ops settings lookup failed: ${error.message}`);
  if (!data) return { ...DEFAULT_OPS_SETTINGS };
  const row = data as Partial<OpsSettings>;
  return {
    ndr_enabled: row.ndr_enabled === true,
    ndr_template_name: row.ndr_template_name ?? null,
    ndr_template_language: row.ndr_template_language ?? null,
    staff_doc_template_name: row.staff_doc_template_name ?? null,
    staff_doc_template_language: row.staff_doc_template_language ?? null,
    sync_tags:
      Array.isArray(row.sync_tags) && row.sync_tags.length > 0
        ? row.sync_tags
        : DEFAULT_SYNC_TAGS,
  };
}

/** Merge `patch` into the account's settings (creating the row). */
export async function saveOpsSettings(
  db: SupabaseClient,
  accountId: string,
  patch: Partial<OpsSettings>
): Promise<OpsSettings> {
  const next = { ...(await getOpsSettings(db, accountId)), ...patch };
  const { error } = await db
    .from('ops_settings')
    .upsert(
      { account_id: accountId, ...next, updated_at: new Date().toISOString() },
      { onConflict: 'account_id' }
    );
  if (error) throw new Error(`ops settings save failed: ${error.message}`);
  return next;
}

/** `#EL2204` / `EL2204` → the spellings an order name may be stored under. */
export function orderNameVariants(input: string): string[] {
  const bare = input.trim().replace(/^#/, '');
  if (!bare) return [];
  const set = new Set([`#${bare}`, bare, `#${bare.toUpperCase()}`, bare.toUpperCase()]);
  return [...set];
}

/** Split an array into chunks (PostgREST `in` filters ride in the URL). */
export function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Cap free text echoed back to the agent. */
export function excerpt(text: unknown, max = 200): string | null {
  if (typeof text !== 'string' || !text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
