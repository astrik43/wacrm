// Contact, custom-field, import and export tools. These are the ONLY core
// tools allowed to return phone numbers and emails.
import { z } from 'zod';

import {
  CONTACT_SELECT,
  ContactError,
  findOrCreateContact,
  serializeContact,
  setContactTags,
} from '@/lib/api/v1/contacts';
import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';
import { dedupeByPhone, findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';
import { assignImportedContactTags, resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../../types';
import {
  DEFAULT_PAGE,
  auditUserId,
  cursorInput,
  fail,
  limitInput,
  requireContact,
  requireTag,
  safeSearch,
  uuid,
} from './helpers';

const MAX_EXPORT = 5000;
const MAX_IMPORT = 1000;

// ── Filters shared by search_contacts and export_contacts ─────────
const filterInput = {
  query: z.string().max(100).optional().describe('Matches name, phone, email or company (substring).'),
  tag_id: uuid.optional().describe('Only contacts with this tag (id from list_tags).'),
  custom_field_id: uuid.optional().describe('With custom_field_value: only contacts whose value for this field matches.'),
  custom_field_value: z.string().max(200).optional().describe('Substring match on the custom field value (needs custom_field_id).'),
  created_after: z.string().datetime().optional().describe('ISO timestamp, inclusive.'),
  created_before: z.string().datetime().optional().describe('ISO timestamp, exclusive.'),
  is_staff: z.boolean().optional().describe('true = only staff contacts, false = only customers. Omit for both.'),
};
type Filters = {
  query?: string;
  tag_id?: string;
  custom_field_id?: string;
  custom_field_value?: string;
  created_after?: string;
  created_before?: string;
  is_staff?: boolean;
};

/** Build the (account-scoped) contacts query. Verifies tag / field ids first. */
async function contactsQuery(ctx: McpContext, f: Filters) {
  if (f.custom_field_value !== undefined && !f.custom_field_id) {
    throw new McpToolError('invalid_input', 'custom_field_value needs custom_field_id (see list_custom_fields).', 'custom_field_id');
  }
  if (f.tag_id) await requireTag(ctx, f.tag_id);

  let idFilter: string[] | null = null;
  if (f.custom_field_id) {
    await requireCustomField(ctx, f.custom_field_id);
    let vq = ctx.supabase.from('contact_custom_values').select('contact_id').eq('custom_field_id', f.custom_field_id).limit(5000);
    if (f.custom_field_value !== undefined) vq = vq.ilike('value', `%${safeSearch(f.custom_field_value)}%`);
    const { data, error } = await vq;
    if (error) fail('Could not filter by custom field', error);
    idFilter = ((data ?? []) as { contact_id: string }[]).map((r) => r.contact_id);
  }

  const columns: string = f.tag_id ? `${CONTACT_SELECT}, tag_filter:contact_tags!inner(tag_id)` : CONTACT_SELECT;
  // Dynamic select string defeats the typed parser; the shape is fixed by CONTACT_SELECT.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = ctx.supabase
    .from('contacts')
    .select(columns)
    .eq('account_id', ctx.accountId);
  if (f.tag_id) q = q.eq('tag_filter.tag_id', f.tag_id);
  if (idFilter) q = q.in('id', idFilter.length ? idFilter : ['00000000-0000-0000-0000-000000000000']);
  if (f.query) {
    const s = safeSearch(f.query);
    if (s) q = q.or(`name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%`);
  }
  if (f.created_after) q = q.gte('created_at', f.created_after);
  if (f.created_before) q = q.lt('created_at', f.created_before);
  if (f.is_staff !== undefined) q = f.is_staff ? q.eq('is_staff', true) : q.neq('is_staff', true);
  return { query: q };
}

function shapeContact(row: Record<string, unknown>) {
  return { ...serializeContact(row), is_staff: row.is_staff === true };
}

async function requireCustomField(ctx: McpContext, id: string): Promise<{ id: string; field_name: string }> {
  const { data, error } = await ctx.supabase
    .from('custom_fields')
    .select('id, field_name')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) fail('Could not look up the custom field', error);
  if (!data) throw new McpToolError('not_found', 'Custom field not found. Use list_custom_fields for ids.', 'custom_field_id');
  return data as { id: string; field_name: string };
}

function mapContactError(e: unknown): never {
  if (e instanceof ContactError) {
    throw new McpToolError(e.status === 400 ? 'invalid_input' : 'internal', e.message, e.status === 400 ? 'phone' : undefined);
  }
  throw e;
}

function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const nullableText = (max: number) => z.string().max(max).nullable().optional();

export const contactTools: AnyMcpTool[] = [
  defineTool({
    name: 'search_contacts',
    description:
      'Search contacts by free text (name/phone/email/company), tag, custom field value and created date. Returns contacts with phone numbers, tags and is_staff, newest first. Page with cursor. Use the returned id with every other contact tool.',
    scope: 'contacts:read',
    tier: 'read',
    input: { ...filterInput, limit: limitInput, cursor: cursorInput },
    handler: async (ctx, args) => {
      const limit = args.limit ?? DEFAULT_PAGE;
      let q = (await contactsQuery(ctx, args)).query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      const f = keysetFilter(decodeCursor(args.cursor ?? null));
      if (f) q = q.or(f);
      const { data, error } = await q;
      if (error) fail('Could not search contacts', error);
      const { items, nextCursor } = buildPage((data ?? []) as { id: string; created_at: string }[], limit);
      return { items: items.map((r) => shapeContact(r as unknown as Record<string, unknown>)), next_cursor: nextCursor };
    },
  }),

  defineTool({
    name: 'get_contact',
    description:
      'Get one contact with tags, custom field values, recent notes, open deals, recent Shopify orders and the last message. contact_id comes from search_contacts.',
    scope: 'contacts:read',
    tier: 'read',
    input: { contact_id: uuid },
    handler: async (ctx, args) => {
      const { data, error } = await ctx.supabase
        .from('contacts')
        .select(CONTACT_SELECT)
        .eq('id', args.contact_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error) fail('Could not load the contact', error);
      if (!data) throw new McpToolError('not_found', 'Contact not found in this account. Use search_contacts.', 'contact_id');
      const id = args.contact_id;
      const [values, notes, deals, orders, convo] = await Promise.all([
        ctx.supabase
          .from('contact_custom_values')
          .select('value, custom_fields!inner(id, field_name, account_id)')
          .eq('contact_id', id)
          .eq('custom_fields.account_id', ctx.accountId),
        ctx.supabase
          .from('contact_notes')
          .select('id, note_text, created_at')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', id)
          .order('created_at', { ascending: false })
          .limit(5),
        ctx.supabase
          .from('deals')
          .select('id, title, value, currency, status, stage_id')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', id)
          .eq('status', 'active')
          .limit(10),
        ctx.supabase
          .from('shopify_orders')
          .select('id, order_name, cancelled_at, created_at')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', id)
          .order('created_at', { ascending: false })
          .limit(5),
        ctx.supabase
          .from('conversations')
          .select('id, status, last_message_text, last_message_at')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', id)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(1),
      ]);
      const custom_values = ((values.data ?? []) as unknown as { value: string | null; custom_fields: { id: string; field_name: string } | null }[])
        .filter((v) => v.custom_fields)
        .map((v) => ({ field_id: v.custom_fields!.id, field_name: v.custom_fields!.field_name, value: v.value }));
      return {
        ...shapeContact(data as Record<string, unknown>),
        custom_values,
        recent_notes: (notes.data ?? []).map((n) => ({ id: n.id, text: n.note_text, created_at: n.created_at })),
        open_deals: deals.data ?? [],
        recent_orders: orders.data ?? [],
        last_conversation: (convo.data ?? [])[0] ?? null,
      };
    },
  }),

  defineTool({
    name: 'create_contact',
    description:
      'Create a contact from a phone number in international format (e.g. +14155550123). Fails with conflict (and the existing id) if that number already exists. Optional tags are names (missing tags are created).',
    scope: 'contacts:write',
    tier: 'write',
    input: {
      phone: z.string().min(5).max(30),
      name: z.string().max(200).optional(),
      email: z.string().email().max(200).optional(),
      company: z.string().max(200).optional(),
      tags: z.array(z.string().min(1).max(100)).max(20).optional().describe('Tag names to apply.'),
    },
    handler: async (ctx, args) => {
      const phone = sanitizePhoneForMeta(args.phone);
      if (!isValidE164(phone)) {
        throw new McpToolError('invalid_input', "phone must be a valid international number like +14155550123.", 'phone');
      }
      const existing = await findExistingContact(ctx.supabase, ctx.accountId, phone);
      if (existing) throw new McpToolError('conflict', `A contact with this number already exists (id ${existing.id}). Use update_contact.`, 'phone');
      if (ctx.dryRun) {
        return { would_create: { phone, name: args.name ?? phone, email: args.email ?? null, company: args.company ?? null, tags: args.tags ?? [] } };
      }
      const userId = await auditUserId(ctx);
      try {
        const { id, created } = await findOrCreateContact(ctx.supabase, ctx.accountId, userId, {
          phone,
          name: args.name,
          email: args.email,
          company: args.company,
        });
        if (!created) throw new McpToolError('conflict', `A contact with this number already exists (id ${id}).`, 'phone');
        if (args.tags?.length) await setContactTags(ctx.supabase, ctx.accountId, userId, id, args.tags);
        return { id, created: true };
      } catch (e) {
        return mapContactError(e);
      }
    },
  }),

  defineTool({
    name: 'update_contact',
    description:
      "Update a contact's name, email or company (null clears email/company). If `tags` is given, the contact's tags are REPLACED by exactly that list of names; omit it to leave tags alone. Use add_tag_to_contacts for adding without replacing.",
    scope: 'contacts:write',
    tier: 'write',
    input: {
      contact_id: uuid,
      name: z.string().min(1).max(200).optional(),
      email: z.string().email().max(200).nullable().optional(),
      company: nullableText(200),
      tags: z.array(z.string().min(1).max(100)).max(50).optional(),
    },
    handler: async (ctx, args) => {
      await requireContact(ctx, args.contact_id);
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.email !== undefined) patch.email = args.email;
      if (args.company !== undefined) patch.company = args.company;
      if (Object.keys(patch).length === 0 && args.tags === undefined) {
        throw new McpToolError('invalid_input', 'Nothing to update: give name, email, company or tags.');
      }
      if (ctx.dryRun) return { would_update: { id: args.contact_id, fields: patch, tags: args.tags ?? 'unchanged' } };
      if (Object.keys(patch).length > 0) {
        const { error } = await ctx.supabase
          .from('contacts')
          .update(patch)
          .eq('id', args.contact_id)
          .eq('account_id', ctx.accountId);
        if (error) fail('Could not update the contact', error);
      }
      if (args.tags !== undefined) {
        try {
          await setContactTags(ctx.supabase, ctx.accountId, await auditUserId(ctx), args.contact_id, args.tags);
        } catch (e) {
          return mapContactError(e);
        }
      }
      return { id: args.contact_id, updated: true };
    },
  }),

  defineTool({
    name: 'delete_contact',
    description:
      'Permanently delete a contact with their notes, tags and conversation history. Cannot be undone. Fails with conflict if the contact still has deals (delete or move those first).',
    scope: 'contacts:write',
    tier: 'destructive',
    input: { contact_id: uuid },
    handler: async (ctx, args) => {
      const c = await requireContact(ctx, args.contact_id, 'id, name');
      if (ctx.dryRun) return { would_delete: { id: c.id, name: c.name ?? null } };
      const { error } = await ctx.supabase
        .from('contacts')
        .delete()
        .eq('id', args.contact_id)
        .eq('account_id', ctx.accountId);
      if (error) {
        if ((error as { code?: string }).code === '23503') {
          throw new McpToolError('conflict', 'This contact still has deals. Delete or reassign them first.', 'contact_id');
        }
        fail('Could not delete the contact', error);
      }
      return { deleted: true, id: args.contact_id };
    },
  }),

  defineTool({
    name: 'import_contacts',
    description:
      `Bulk create contacts from JSON rows (or CSV text with a phone header and optional name,email,company,tags columns), max ${MAX_IMPORT} per call. Duplicates by phone inside the batch are skipped; numbers that already exist are skipped unless update_existing is true. Invalid numbers are skipped. Always run with dry_run first: it reports would_create / would_update / skipped counts. Tags are applied without firing "tag added" automations (same as the dashboard import).`,
    scope: 'contacts:write',
    tier: 'write',
    input: {
      rows: z
        .array(
          z.object({
            phone: z.string().max(30),
            name: z.string().max(200).optional(),
            email: z.string().max(200).optional(),
            company: z.string().max(200).optional(),
            tags: z.array(z.string().max(100)).max(20).optional(),
          })
        )
        .max(MAX_IMPORT)
        .optional(),
      csv: z.string().max(500_000).optional().describe('CSV text instead of rows.'),
      update_existing: z.boolean().optional().describe('Update name/email/company of existing contacts when the row provides them (default false: skip).'),
    },
    handler: async (ctx, args) => {
      if (!args.rows === !args.csv) throw new McpToolError('invalid_input', 'Give exactly one of rows or csv.', 'rows');
      let rows: { phone: string; name?: string; email?: string; company?: string; tagNames: string[] }[];
      if (args.csv) {
        const parsed = parseContactCsv(args.csv);
        if (!parsed.hasPhoneColumn) throw new McpToolError('invalid_input', 'The CSV needs a "phone" column header.', 'csv');
        rows = parsed.rows;
      } else {
        rows = (args.rows ?? []).map((r) => ({ ...r, tagNames: r.tags ?? [] }));
      }
      if (rows.length > MAX_IMPORT) throw new McpToolError('invalid_input', `Max ${MAX_IMPORT} rows per call.`, 'rows');

      const { unique, duplicates, invalid } = dedupeByPhone(rows);
      const valid = unique.filter((r) => isValidE164(sanitizePhoneForMeta(r.phone)));
      let skipped_invalid = invalid + (unique.length - valid.length);
      let wouldCreate = 0;
      let wouldUpdate = 0;
      let skipped_existing = 0;
      const toCreate: typeof valid = [];
      const toUpdate: { id: string; row: (typeof valid)[number] }[] = [];

      for (let i = 0; i < valid.length; i += 10) {
        const found = await Promise.all(
          valid.slice(i, i + 10).map((r) => findExistingContact(ctx.supabase, ctx.accountId, sanitizePhoneForMeta(r.phone)))
        );
        found.forEach((ex, j) => {
          const row = valid[i + j];
          if (!ex) {
            wouldCreate++;
            toCreate.push(row);
          } else if (args.update_existing) {
            wouldUpdate++;
            toUpdate.push({ id: ex.id, row });
          } else skipped_existing++;
        });
      }
      const summary = {
        rows_received: rows.length,
        skipped_duplicate_in_batch: duplicates,
        skipped_invalid_phone: skipped_invalid,
        skipped_existing,
      };
      if (ctx.dryRun) return { ...summary, would_create: wouldCreate, would_update: wouldUpdate };

      const userId = await auditUserId(ctx);
      const tagNames = [...new Set([...toCreate, ...toUpdate.map((u) => u.row)].flatMap((r) => r.tagNames))];
      const { tagIdByKey } = await resolveImportTagIds(ctx.supabase, { accountId: ctx.accountId, userId, tagNames, canCreateTags: true });
      const assignments: { contactId: string; tagNames: string[] }[] = [];
      let created = 0;
      let updated = 0;

      for (const row of toCreate) {
        const phone = sanitizePhoneForMeta(row.phone);
        const { data, error } = await ctx.supabase
          .from('contacts')
          .insert({
            account_id: ctx.accountId,
            user_id: userId,
            phone,
            name: row.name || phone,
            email: row.email || null,
            company: row.company || null,
          })
          .select('id')
          .single();
        if (error || !data) {
          if (isUniqueViolation(error)) skipped_existing++;
          else skipped_invalid++;
          continue;
        }
        created++;
        if (row.tagNames.length) assignments.push({ contactId: data.id as string, tagNames: row.tagNames });
      }
      for (const { id, row } of toUpdate) {
        const patch: Record<string, string> = {};
        if (row.name) patch.name = row.name;
        if (row.email) patch.email = row.email;
        if (row.company) patch.company = row.company;
        if (Object.keys(patch).length > 0) {
          const { error } = await ctx.supabase.from('contacts').update(patch).eq('id', id).eq('account_id', ctx.accountId);
          if (error) {
            skipped_invalid++;
            continue;
          }
        }
        updated++;
        if (row.tagNames.length) assignments.push({ contactId: id, tagNames: row.tagNames });
      }
      await assignImportedContactTags(ctx.supabase, assignments, tagIdByKey);
      return { ...summary, skipped_invalid_phone: skipped_invalid, skipped_existing, created, updated };
    },
  }),

  defineTool({
    name: 'export_contacts',
    description: `Export contacts as CSV text (columns: phone,name,email,company,tags,created_at,is_staff), same filters as search_contacts, capped at ${MAX_EXPORT} rows (truncated=true when more exist; narrow the filters).`,
    scope: 'contacts:read',
    tier: 'read',
    input: { ...filterInput, max_rows: z.number().int().min(1).max(MAX_EXPORT).optional() },
    handler: async (ctx, args) => {
      const cap = args.max_rows ?? MAX_EXPORT;
      const lines = ['phone,name,email,company,tags,created_at,is_staff'];
      let count = 0;
      let cursor = null as ReturnType<typeof decodeCursor>;
      let truncated = false;
      while (count < cap) {
        const pageSize = Math.min(1000, cap - count);
        let q = (await contactsQuery(ctx, args)).query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(pageSize + 1);
        const f = keysetFilter(cursor);
        if (f) q = q.or(f);
        const { data, error } = await q;
        if (error) fail('Could not export contacts', error);
        const { items, nextCursor } = buildPage((data ?? []) as { id: string; created_at: string }[], pageSize);
        for (const r of items) {
          const c = shapeContact(r as unknown as Record<string, unknown>);
          lines.push(
            [c.phone, c.name, c.email, c.company, c.tags.map((t) => t.name).join(';'), c.created_at, c.is_staff]
              .map(csvCell)
              .join(',')
          );
          count++;
        }
        if (!nextCursor) break;
        cursor = decodeCursor(nextCursor);
        if (count >= cap) truncated = true;
      }
      return { csv: lines.join('\n'), row_count: count, truncated };
    },
  }),

  defineTool({
    name: 'list_custom_fields',
    description: 'List the custom contact fields defined in this account. Use the ids with set_contact_custom_value and search_contacts.',
    scope: 'contacts:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('custom_fields')
        .select('id, field_name, field_type, created_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: true });
      if (error) fail('Could not load custom fields', error);
      return { items: data ?? [], next_cursor: null };
    },
  }),

  defineTool({
    name: 'create_custom_field',
    description: 'Define a new custom contact field (text). Names are unique per account, case-insensitive.',
    scope: 'contacts:write',
    tier: 'write',
    input: { name: z.string().min(1).max(100) },
    handler: async (ctx, args) => {
      const name = args.name.trim();
      if (!name) throw new McpToolError('invalid_input', 'name is empty.', 'name');
      const { data: all, error: readErr } = await ctx.supabase
        .from('custom_fields')
        .select('id, field_name')
        .eq('account_id', ctx.accountId);
      if (readErr) fail('Could not load custom fields', readErr);
      const clash = ((all ?? []) as { id: string; field_name: string }[]).find(
        (f) => f.field_name.trim().toLowerCase() === name.toLowerCase()
      );
      if (clash) throw new McpToolError('conflict', `A field named "${clash.field_name}" already exists (id ${clash.id}).`, 'name');
      if (ctx.dryRun) return { would_create: { name, type: 'text' } };
      const { data, error } = await ctx.supabase
        .from('custom_fields')
        .insert({ account_id: ctx.accountId, user_id: await auditUserId(ctx), field_name: name, field_type: 'text' })
        .select('id, field_name, field_type')
        .single();
      if (error || !data) fail('Could not create the custom field', error);
      return data;
    },
  }),

  defineTool({
    name: 'set_contact_custom_value',
    description: 'Set a contact\'s value for a custom field, or clear it with value=null. Get field ids from list_custom_fields.',
    scope: 'contacts:write',
    tier: 'write',
    input: { contact_id: uuid, custom_field_id: uuid, value: z.string().max(2000).nullable() },
    handler: async (ctx, args) => {
      await requireContact(ctx, args.contact_id);
      const field = await requireCustomField(ctx, args.custom_field_id);
      if (ctx.dryRun) return { would_set: { contact_id: args.contact_id, field: field.field_name, value: args.value } };
      if (args.value === null) {
        const { error } = await ctx.supabase
          .from('contact_custom_values')
          .delete()
          .eq('contact_id', args.contact_id)
          .eq('custom_field_id', field.id);
        if (error) fail('Could not clear the value', error);
        return { cleared: true, field: field.field_name };
      }
      const { error } = await ctx.supabase
        .from('contact_custom_values')
        .upsert({ contact_id: args.contact_id, custom_field_id: field.id, value: args.value }, { onConflict: 'contact_id,custom_field_id' });
      if (error) fail('Could not set the value', error);
      return { set: true, field: field.field_name, value: args.value };
    },
  }),
];
