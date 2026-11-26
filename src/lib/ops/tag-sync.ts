// ============================================================
// ERP tag sync, wacrm side. wacrm never calls the ERP: the agent
// reads the ERP with its own tools, reads wacrm's tag state here, and
// sends back a diff (apply_tag_changes). Targets are contact ids or
// order numbers; phone numbers never appear.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';

import { chunk, orderNameVariants } from './settings';

type Row = Record<string, unknown>;

export const MAX_TAG_TARGETS = 500;

export interface TagTargets {
  contact_ids?: string[];
  order_numbers?: string[];
}

export interface ResolvedTargets {
  /** Contacts that belong to the account. */
  contacts: Map<string, { isStaff: boolean }>;
  unresolved: { contact_ids: string[]; order_numbers: string[] };
}

/** Turn contact ids / order numbers into verified contacts of the account. */
export async function resolveTargets(
  db: SupabaseClient,
  accountId: string,
  targets: TagTargets
): Promise<ResolvedTargets> {
  const contacts = new Map<string, { isStaff: boolean }>();
  const unresolved = { contact_ids: [] as string[], order_numbers: [] as string[] };

  const wantedIds = new Set(targets.contact_ids ?? []);
  const orderIds = new Map<string, string>(); // order name variant → requested number
  for (const n of targets.order_numbers ?? []) {
    for (const v of orderNameVariants(n)) orderIds.set(v, n);
  }

  // Order numbers → contact ids (stored link first, phone as fallback).
  const byOrder = new Map<string, string | null>();
  for (const part of chunk([...orderIds.keys()], 200)) {
    const { data, error } = await db
      .from('shopify_orders')
      .select('order_name, contact_id, phone')
      .eq('account_id', accountId)
      .in('order_name', part);
    if (error) throw new Error(`order lookup failed: ${error.message}`);
    for (const r of (data as Row[] | null) ?? []) {
      const requested = orderIds.get(r.order_name as string);
      if (!requested) continue;
      let contactId = (r.contact_id as string | null) ?? null;
      if (!contactId && typeof r.phone === 'string' && r.phone) {
        const digits = r.phone.replace(/^\+/, '');
        const { data: c } = await db
          .from('contacts')
          .select('id')
          .eq('account_id', accountId)
          .in('phone', [digits, `+${digits}`])
          .limit(1);
        contactId = (((c as Row[] | null) ?? [])[0]?.id as string | undefined) ?? null;
      }
      if (!byOrder.has(requested) || !byOrder.get(requested)) byOrder.set(requested, contactId);
    }
  }
  for (const n of targets.order_numbers ?? []) {
    const id = byOrder.get(n);
    if (id) wantedIds.add(id);
    else unresolved.order_numbers.push(n);
  }

  // Verify every id belongs to the account.
  const requestedIds = [...wantedIds];
  for (const part of chunk(requestedIds)) {
    const { data, error } = await db
      .from('contacts')
      .select('id, is_staff')
      .eq('account_id', accountId)
      .in('id', part);
    if (error) throw new Error(`contact lookup failed: ${error.message}`);
    for (const r of (data as Row[] | null) ?? []) {
      contacts.set(r.id as string, { isStaff: r.is_staff === true });
    }
  }
  for (const id of targets.contact_ids ?? []) {
    if (!contacts.has(id)) unresolved.contact_ids.push(id);
  }
  return { contacts, unresolved };
}

/** Which of `contactIds` already carry `tagId`. */
export async function contactsWithTag(
  db: SupabaseClient,
  tagId: string,
  contactIds: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(contactIds)) {
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', tagId)
      .in('contact_id', part);
    if (error) throw new Error(`tag lookup failed: ${error.message}`);
    for (const r of (data as Row[] | null) ?? []) out.add(r.contact_id as string);
  }
  return out;
}

/** Existing account tags by lowercase name. */
export async function loadTagIds(
  db: SupabaseClient,
  accountId: string
): Promise<Map<string, { id: string; name: string }>> {
  const { data, error } = await db.from('tags').select('id, name').eq('account_id', accountId);
  if (error) throw new Error(`tag lookup failed: ${error.message}`);
  const out = new Map<string, { id: string; name: string }>();
  for (const r of (data as { id: string; name: string }[] | null) ?? []) {
    out.set(r.name.trim().toLowerCase(), { id: r.id, name: r.name });
  }
  return out;
}

/** Find a tag by name, creating it when missing. */
export async function ensureTagId(
  db: SupabaseClient,
  accountId: string,
  name: string
): Promise<string | null> {
  const userId = await resolveAuditUserId(db, accountId);
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId,
    tagNames: [name],
    canCreateTags: true,
  });
  return tagIdByKey.get(name.trim().toLowerCase()) ?? null;
}

export interface ApplyTotals {
  added: number;
  removed: number;
  already_tagged: number;
  not_tagged: number;
}

/** Apply one tag to / from a set of contacts. Honours `dryRun` (counts only). */
export async function applyTagToContacts(
  db: SupabaseClient,
  accountId: string,
  tagId: string | null,
  mode: 'add' | 'remove',
  contactIds: string[],
  dryRun: boolean
): Promise<{ changed: number; unchanged: number }> {
  if (contactIds.length === 0) return { changed: 0, unchanged: 0 };
  // A tag that does not exist yet has no holders.
  const have = tagId ? await contactsWithTag(db, tagId, contactIds) : new Set<string>();
  const todo = contactIds.filter((id) => (mode === 'add' ? !have.has(id) : have.has(id)));
  if (!dryRun && tagId) {
    if (mode === 'add') {
      for (const contactId of todo) {
        await addContactTagAndDispatch({ db, accountId, contactId, tagId });
      }
    } else {
      for (const part of chunk(todo)) {
        const { error } = await db
          .from('contact_tags')
          .delete()
          .eq('tag_id', tagId)
          .in('contact_id', part);
        if (error) throw new Error(`tag removal failed: ${error.message}`);
      }
    }
  }
  return { changed: todo.length, unchanged: contactIds.length - todo.length };
}
