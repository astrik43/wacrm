// ============================================================
// Server-side broadcast audience resolution, for callers that have an
// accountId and a service-role client (the MCP broadcast tools). The
// dashboard wizard resolves audiences with the browser client under RLS
// (hooks/use-broadcast-sending.ts); this is the same set of rules for a
// client that bypasses RLS, so EVERY query filters by account_id and
// every id the caller supplied is checked against the account first.
//
// Staff contacts (contacts.is_staff) are never part of an audience: not
// for "all", not for tags, not for explicit ids or phone lists.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { normalizeKey } from '@/lib/contacts/dedupe';
import type { CustomFieldOperator } from '@/lib/broadcasts/shared';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

export type AudienceType = 'all' | 'tags' | 'custom_field' | 'contacts' | 'phones';

export interface ServerAudience {
  type: AudienceType;
  /** tags: contacts carrying ANY of these tags. */
  tagIds?: string[];
  customField?: { fieldId: string; operator: CustomFieldOperator; value: string };
  contactIds?: string[];
  phones?: string[];
  /** Contacts carrying any of these tags are subtracted. */
  excludeTagIds?: string[];
}

export interface AudienceContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
}

export class AudienceError extends Error {
  readonly code: 'not_found' | 'invalid_input';
  constructor(code: 'not_found' | 'invalid_input', message: string) {
    super(message);
    this.name = 'AudienceError';
    this.code = code;
  }
}

export interface ResolvedAudience {
  contacts: AudienceContact[];
  /** Staff contacts the audience would have included. */
  staffExcluded: number;
  /** phones: valid numbers with no contact yet (created when `createMissing` is set). */
  unmatchedPhones: number;
  /** phones: numbers that are not valid E.164. */
  invalidPhones: number;
  /** True when more contacts matched than `cap`; `contacts` holds the first `cap`. */
  capped: boolean;
}

export interface ResolveOptions {
  /** Most contacts to return. */
  cap: number;
  /** Create contacts for unknown `phones` (a real send). Needs the audit user. */
  createMissing?: { auditUserId: string };
}

const PAGE = 1000;
const ID_CHUNK = 100;
const SELECT = 'id, name, phone, email, company, is_staff';

type Row = Record<string, unknown>;

async function pageAll(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  max = Infinity,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; out.length < max; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function assertTagsInAccount(db: SupabaseClient, accountId: string, tagIds: string[]) {
  const unique = [...new Set(tagIds)];
  for (const part of chunks(unique, ID_CHUNK)) {
    const { data } = await db.from('tags').select('id').eq('account_id', accountId).in('id', part);
    if ((data ?? []).length !== part.length) {
      throw new AudienceError('not_found', 'One or more tag ids were not found. Call list_tags for valid ids.');
    }
  }
  return unique;
}

async function contactIdsWithTags(db: SupabaseClient, tagIds: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const rows = await pageAll((from, to) =>
    db.from('contact_tags').select('contact_id').in('tag_id', tagIds).order('id').range(from, to),
  );
  for (const r of rows) ids.add(r.contact_id as string);
  return ids;
}

async function contactIdsWithCustomValue(
  db: SupabaseClient,
  accountId: string,
  filter: NonNullable<ServerAudience['customField']>,
): Promise<Set<string>> {
  const { data: field } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', filter.fieldId)
    .maybeSingle();
  if (!field) {
    throw new AudienceError('not_found', 'Custom field not found. Call list_custom_fields for valid ids.');
  }
  const rows = await pageAll((from, to) => {
    let q = db.from('contact_custom_values').select('contact_id').eq('custom_field_id', filter.fieldId);
    if (filter.operator === 'is') q = q.eq('value', filter.value);
    else if (filter.operator === 'is_not') q = q.neq('value', filter.value);
    else q = q.ilike('value', `%${filter.value}%`);
    return q.order('id').range(from, to);
  });
  return new Set(rows.map((r) => r.contact_id as string));
}

async function contactsByIds(db: SupabaseClient, accountId: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const part of chunks(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('contacts')
      .select(SELECT)
      .eq('account_id', accountId)
      .in('id', part);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
  }
  return out;
}

function toContact(r: Row): AudienceContact {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    company: (r.company as string | null) ?? null,
  };
}

export async function resolveServerAudience(
  db: SupabaseClient,
  accountId: string,
  audience: ServerAudience,
  options: ResolveOptions,
): Promise<ResolvedAudience> {
  let rows: Row[] = [];
  let unmatchedPhones = 0;
  let invalidPhones = 0;

  if (audience.type === 'all') {
    // Staff filtered in SQL: "all" can be the whole address book.
    rows = await pageAll(
      (from, to) =>
        db
          .from('contacts')
          .select(SELECT)
          .eq('account_id', accountId)
          .eq('is_staff', false)
          .order('created_at')
          .order('id')
          .range(from, to),
      options.cap + 1,
    );
  } else if (audience.type === 'tags') {
    if (!audience.tagIds || audience.tagIds.length === 0) {
      throw new AudienceError('invalid_input', "audience.tag_ids is required for type 'tags'");
    }
    const tagIds = await assertTagsInAccount(db, accountId, audience.tagIds);
    rows = await contactsByIds(db, accountId, [...(await contactIdsWithTags(db, tagIds))]);
  } else if (audience.type === 'custom_field') {
    if (!audience.customField?.fieldId || !audience.customField.value) {
      throw new AudienceError('invalid_input', "audience.custom_field needs field_id and value for type 'custom_field'");
    }
    const ids = await contactIdsWithCustomValue(db, accountId, audience.customField);
    rows = await contactsByIds(db, accountId, [...ids]);
  } else if (audience.type === 'contacts') {
    const ids = [...new Set(audience.contactIds ?? [])];
    if (ids.length === 0) {
      throw new AudienceError('invalid_input', "audience.contact_ids is required for type 'contacts'");
    }
    rows = await contactsByIds(db, accountId, ids);
    if (rows.length !== ids.length) {
      throw new AudienceError('not_found', 'One or more contact ids were not found in this account.');
    }
  } else if (audience.type === 'phones') {
    const byKey = new Map<string, string>();
    for (const phone of audience.phones ?? []) {
      const key = normalizeKey(phone);
      if (key && !byKey.has(key)) byKey.set(key, phone);
    }
    if (byKey.size === 0) {
      throw new AudienceError('invalid_input', "audience.phones is required for type 'phones'");
    }
    const found = new Set<string>();
    for (const part of chunks([...byKey.keys()], ID_CHUNK)) {
      const { data, error } = await db
        .from('contacts')
        .select(`${SELECT}, phone_normalized`)
        .eq('account_id', accountId)
        .in('phone_normalized', part);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) {
        rows.push(r);
        found.add(r.phone_normalized as string);
      }
    }
    for (const [key, phone] of byKey) {
      if (found.has(key)) continue;
      if (!options.createMissing) {
        if (isValidE164(sanitizePhoneForMeta(phone))) unmatchedPhones++;
        else invalidPhones++;
        continue;
      }
      try {
        const { id } = await findOrCreateContact(db, accountId, options.createMissing.auditUserId, { phone });
        const [created] = await contactsByIds(db, accountId, [id]);
        if (created) rows.push(created);
        unmatchedPhones++;
      } catch {
        invalidPhones++;
      }
    }
  }

  // Exclude tags (account-checked), then staff, then de-duplicate.
  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const excludeIds = await assertTagsInAccount(db, accountId, audience.excludeTagIds);
    const excluded = await contactIdsWithTags(db, excludeIds);
    rows = rows.filter((r) => !excluded.has(r.id as string));
  }

  let staffExcluded = 0;
  const seen = new Set<string>();
  const contacts: AudienceContact[] = [];
  for (const r of rows) {
    const id = r.id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (r.is_staff === true) {
      staffExcluded++;
      continue;
    }
    contacts.push(toContact(r));
  }

  const capped = contacts.length > options.cap;
  return {
    contacts: capped ? contacts.slice(0, options.cap) : contacts,
    staffExcluded,
    unmatchedPhones,
    invalidPhones,
    capped,
  };
}
