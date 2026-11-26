// ERP tag sync. wacrm never calls the ERP: the agent reads the ERP
// with its own MCP, reads wacrm's state with get_tag_state, computes
// the difference, and writes it back with apply_tag_changes.

import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';
import { chunk, getOpsSettings, saveOpsSettings } from '@/lib/ops/settings';
import {
  MAX_TAG_TARGETS,
  applyTagToContacts,
  ensureTagId,
  loadTagIds,
  resolveTargets,
} from '@/lib/ops/tag-sync';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';

type Row = Record<string, unknown>;

const targetShape = {
  tag: z.string().min(1).max(100).describe('Tag name; must be one of the sync tags (get_ops_settings).'),
  contact_ids: z.array(z.string().uuid()).max(MAX_TAG_TARGETS).optional(),
  order_numbers: z
    .array(z.string().min(1).max(40))
    .max(MAX_TAG_TARGETS)
    .optional()
    .describe('Order numbers such as #EL2204; resolved to the order’s contact.'),
};
const targetGroup = z.object(targetShape);
type Group = z.infer<typeof targetGroup>;

const count = (g: Group[]) =>
  g.reduce((n, x) => n + (x.contact_ids?.length ?? 0) + (x.order_numbers?.length ?? 0), 0);

export const tagSyncTools = [
  defineTool({
    name: 'get_tag_state',
    title: 'Which contacts carry these tags',
    description:
      'For each tag name (usually the sync tags: Order RTO, Blocked, Partial pay), list the contacts that carry it: contact_id, when it was added and their recent order numbers. No phone numbers or names. Staff are left out. Compare with the ERP, then call apply_tag_changes with the difference. Pages with cursor.',
    scope: 'ops:read',
    tier: 'read',
    input: {
      tags: z.array(z.string().min(1).max(100)).min(1).max(10).describe('Tag names.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
      cursor: z.string().optional(),
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? 50;
      const known = await loadTagIds(ctx.supabase, ctx.accountId);
      const wanted: { id: string; name: string }[] = [];
      const unknownTags: string[] = [];
      for (const name of args.tags) {
        const hit = known.get(name.trim().toLowerCase());
        if (hit) wanted.push(hit);
        else unknownTags.push(name);
      }
      if (wanted.length === 0) return { items: [], next_cursor: null, unknown_tags: unknownTags };
      const nameById = new Map(wanted.map((t) => [t.id, t.name]));

      let q = ctx.supabase
        .from('contact_tags')
        .select('id, created_at, contact_id, tag_id, contacts!inner(account_id, is_staff)')
        .eq('contacts.account_id', ctx.accountId)
        .eq('contacts.is_staff', false)
        .in('tag_id', [...nameById.keys()]);
      const filter = keysetFilter(decodeCursor(args.cursor ?? null));
      if (filter) q = q.or(filter);
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (error) throw new McpToolError('internal', 'Could not read tag state.');
      const page = buildPage((data as { created_at: string; id: string }[]) ?? [], limit);
      const rows = page.items as unknown as Row[];

      const orders = new Map<string, string[]>();
      for (const part of chunk([...new Set(rows.map((r) => r.contact_id as string))])) {
        const { data: found } = await ctx.supabase
          .from('shopify_orders')
          .select('order_name, contact_id, created_at')
          .eq('account_id', ctx.accountId)
          .in('contact_id', part)
          .order('created_at', { ascending: false });
        for (const o of (found as Row[] | null) ?? []) {
          const list = orders.get(o.contact_id as string) ?? [];
          if (list.length < 5 && o.order_name) list.push(o.order_name as string);
          orders.set(o.contact_id as string, list);
        }
      }
      return {
        items: rows.map((r) => ({
          tag: nameById.get(r.tag_id as string),
          contact_id: r.contact_id,
          tagged_at: r.created_at,
          order_numbers: orders.get(r.contact_id as string) ?? [],
        })),
        next_cursor: page.nextCursor,
        unknown_tags: unknownTags,
      };
    },
  }),

  defineTool({
    name: 'apply_tag_changes',
    title: 'Apply ERP tag differences',
    description:
      'Add and remove sync tags on contacts, given contact ids or order numbers (resolved to the order’s contact). Adds fire "tag added" automations like a manual tag. Only the configured sync tags are allowed (get_ops_settings); staff are skipped. At most 500 targets per call. Always run with dry_run first: it returns the counts without changing anything. Order numbers or ids that cannot be matched come back under unresolved.',
    scope: 'ops:write',
    tier: 'write',
    input: {
      add: z.array(targetGroup).max(10).optional().describe('Tags to add, each with its contact_ids / order_numbers.'),
      remove: z.array(targetGroup).max(10).optional().describe('Tags to remove, same shape.'),
    },
    handler: async (ctx, args) => {
      const add = args.add ?? [];
      const remove = args.remove ?? [];
      if (add.length + remove.length === 0) {
        throw new McpToolError('invalid_input', 'Pass at least one entry in add or remove.');
      }
      if (count(add) + count(remove) > MAX_TAG_TARGETS) {
        throw new McpToolError(
          'invalid_input',
          `At most ${MAX_TAG_TARGETS} contacts / orders per call. Split the change into batches.`
        );
      }
      const settings = await getOpsSettings(ctx.supabase, ctx.accountId);
      const allowed = new Set(settings.sync_tags.map((t) => t.trim().toLowerCase()));
      for (const g of [...add, ...remove]) {
        if (!allowed.has(g.tag.trim().toLowerCase())) {
          throw new McpToolError(
            'invalid_input',
            `"${g.tag}" is not a sync tag. Allowed: ${settings.sync_tags.join(', ')}. Change them with update_ops_settings.`,
            'tag'
          );
        }
      }

      const known = await loadTagIds(ctx.supabase, ctx.accountId);
      const report = {
        dry_run: ctx.dryRun,
        added: 0,
        removed: 0,
        already_tagged: 0,
        not_tagged: 0,
        skipped_staff: 0,
        tags_to_create: [] as string[],
        unresolved: { contact_ids: [] as string[], order_numbers: [] as string[] },
      };

      for (const mode of ['add', 'remove'] as const) {
        for (const g of mode === 'add' ? add : remove) {
          const targets = await resolveTargets(ctx.supabase, ctx.accountId, g);
          report.unresolved.contact_ids.push(...targets.unresolved.contact_ids);
          report.unresolved.order_numbers.push(...targets.unresolved.order_numbers);
          const customers: string[] = [];
          for (const [id, c] of targets.contacts) {
            if (c.isStaff) report.skipped_staff++;
            else customers.push(id);
          }

          let tagId = known.get(g.tag.trim().toLowerCase())?.id ?? null;
          if (!tagId && mode === 'add' && !ctx.dryRun) {
            tagId = await ensureTagId(ctx.supabase, ctx.accountId, g.tag);
          }
          if (!tagId && mode === 'add' && ctx.dryRun && !report.tags_to_create.includes(g.tag)) {
            report.tags_to_create.push(g.tag);
          }
          const result = await applyTagToContacts(
            ctx.supabase,
            ctx.accountId,
            tagId,
            mode,
            [...new Set(customers)],
            ctx.dryRun
          );
          if (mode === 'add') {
            report.added += result.changed;
            report.already_tagged += result.unchanged;
          } else {
            report.removed += result.changed;
            report.not_tagged += result.unchanged;
          }
        }
      }
      return report;
    },
  }),

  defineTool({
    name: 'get_ops_settings',
    title: 'Get ops settings',
    description:
      'Show the ops configuration: the sync tags the ERP tag sync may change, the staff document template (used outside the 24-hour window) and the NDR switch.',
    scope: 'ops:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const s = await getOpsSettings(ctx.supabase, ctx.accountId);
      return {
        sync_tags: s.sync_tags,
        staff_doc_template: {
          name: s.staff_doc_template_name,
          language: s.staff_doc_template_language,
        },
        ndr: {
          enabled: s.ndr_enabled,
          template_name: s.ndr_template_name,
          template_language: s.ndr_template_language,
        },
      };
    },
  }),

  defineTool({
    name: 'update_ops_settings',
    title: 'Update ops settings',
    description:
      'Change the sync tags (the tag names apply_tag_changes may touch) and/or the staff document template used by send_document_to_staff outside the 24-hour window (an APPROVED utility template with a DOCUMENT header). NDR settings use update_ndr_settings.',
    scope: 'ops:write',
    tier: 'write',
    input: {
      sync_tags: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
      staff_doc_template_name: z.string().min(1).max(512).optional(),
      staff_doc_template_language: z.string().min(2).max(10).optional(),
    },
    handler: async (ctx, args) => {
      const current = await getOpsSettings(ctx.supabase, ctx.accountId);
      const patch = {
        ...(args.sync_tags
          ? { sync_tags: [...new Set(args.sync_tags.map((t) => t.trim()).filter(Boolean))] }
          : {}),
        ...(args.staff_doc_template_name
          ? { staff_doc_template_name: args.staff_doc_template_name }
          : {}),
        ...(args.staff_doc_template_language
          ? { staff_doc_template_language: args.staff_doc_template_language }
          : {}),
      };
      if (Object.keys(patch).length === 0) {
        throw new McpToolError('invalid_input', 'Pass at least one setting to change.');
      }
      if (args.staff_doc_template_name) {
        const resolved = await resolveTemplateRow(
          ctx.supabase,
          ctx.accountId,
          args.staff_doc_template_name,
          args.staff_doc_template_language ?? current.staff_doc_template_language
        );
        if (!resolved.row || resolved.malformed) {
          throw new McpToolError(
            'not_found',
            `Template "${args.staff_doc_template_name}" was not found. Run sync_templates first.`,
            'staff_doc_template_name'
          );
        }
        if (resolved.row.status !== 'APPROVED' || resolved.row.header_type !== 'document') {
          throw new McpToolError(
            'invalid_input',
            'The staff document template must be APPROVED and have a DOCUMENT header.',
            'staff_doc_template_name'
          );
        }
      }
      if (ctx.dryRun) return { dry_run: true, would_set: patch };
      const saved = await saveOpsSettings(ctx.supabase, ctx.accountId, patch);
      return {
        sync_tags: saved.sync_tags,
        staff_doc_template: {
          name: saved.staff_doc_template_name,
          language: saved.staff_doc_template_language,
        },
      };
    },
  }),
];
