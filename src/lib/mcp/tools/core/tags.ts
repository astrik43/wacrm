// Tag tools. No phone numbers or emails are returned from here.
import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../../types';
import {
  DEFAULT_PAGE,
  auditUserId,
  cursorInput,
  fail,
  limitInput,
  requireContactIds,
  requireTag,
  uuid,
} from './helpers';

const MAX_BULK = 500;
const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3b82f6');

async function findTagByName(ctx: McpContext, name: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await ctx.supabase.from('tags').select('id, name').eq('account_id', ctx.accountId);
  if (error) fail('Could not load tags', error);
  const key = name.trim().toLowerCase();
  return ((data ?? []) as { id: string; name: string }[]).find((t) => t.name.trim().toLowerCase() === key) ?? null;
}

const bulkInput = {
  contact_ids: z.array(uuid).min(1).max(MAX_BULK).describe(`Contact ids (max ${MAX_BULK}) from search_contacts.`),
  tag_id: uuid.optional().describe('Tag id from list_tags. Give this or tag_name.'),
  tag_name: z.string().min(1).max(100).optional().describe('Tag name (case-insensitive). Give this or tag_id.'),
};

export const tagTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_tags',
    description: 'List the account\'s tags with colour and how many contacts carry each. Use the ids with add_tag_to_contacts, search_contacts etc.',
    scope: 'tags:read',
    tier: 'read',
    input: { limit: limitInput, cursor: cursorInput },
    handler: async (ctx, args) => {
      const limit = args.limit ?? DEFAULT_PAGE;
      let q = ctx.supabase
        .from('tags')
        .select('id, name, color, created_at, contact_tags(count)')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      const f = keysetFilter(decodeCursor(args.cursor ?? null));
      if (f) q = q.or(f);
      const { data, error } = await q;
      if (error) fail('Could not load tags', error);
      const { items, nextCursor } = buildPage((data ?? []) as { id: string; created_at: string }[], limit);
      return {
        items: items.map((t) => {
          const row = t as unknown as { id: string; name: string; color: string; created_at: string; contact_tags?: { count: number }[] };
          return { id: row.id, name: row.name, color: row.color, contact_count: row.contact_tags?.[0]?.count ?? 0, created_at: row.created_at };
        }),
        next_cursor: nextCursor,
      };
    },
  }),

  defineTool({
    name: 'create_tag',
    description: 'Create a tag. Names are unique per account, case-insensitive.',
    scope: 'tags:write',
    tier: 'write',
    input: { name: z.string().min(1).max(100), color: COLOR.optional() },
    handler: async (ctx, args) => {
      const name = args.name.trim();
      if (!name) throw new McpToolError('invalid_input', 'name is empty.', 'name');
      const existing = await findTagByName(ctx, name);
      if (existing) throw new McpToolError('conflict', `A tag named "${existing.name}" already exists (id ${existing.id}).`, 'name');
      if (ctx.dryRun) return { would_create: { name, color: args.color ?? '#3b82f6' } };
      const { data, error } = await ctx.supabase
        .from('tags')
        .insert({ account_id: ctx.accountId, user_id: await auditUserId(ctx), name, color: args.color ?? '#3b82f6' })
        .select('id, name, color')
        .single();
      if (error || !data) fail('Could not create the tag', error);
      return data;
    },
  }),

  defineTool({
    name: 'rename_tag',
    description: 'Rename a tag and/or change its colour. Contacts keep the tag. Use list_tags for the id.',
    scope: 'tags:write',
    tier: 'write',
    input: { tag_id: uuid, name: z.string().min(1).max(100).optional(), color: COLOR.optional() },
    handler: async (ctx, args) => {
      const tag = await requireTag(ctx, args.tag_id);
      const patch: Record<string, string> = {};
      if (args.name !== undefined) {
        const name = args.name.trim();
        const clash = await findTagByName(ctx, name);
        if (clash && clash.id !== tag.id) {
          throw new McpToolError('conflict', `A tag named "${clash.name}" already exists (id ${clash.id}).`, 'name');
        }
        patch.name = name;
      }
      if (args.color !== undefined) patch.color = args.color;
      if (Object.keys(patch).length === 0) throw new McpToolError('invalid_input', 'Give a name or a color to change.');
      if (ctx.dryRun) return { would_update: { id: tag.id, from: { name: tag.name, color: tag.color }, to: patch } };
      const { data, error } = await ctx.supabase
        .from('tags')
        .update(patch)
        .eq('id', tag.id)
        .eq('account_id', ctx.accountId)
        .select('id, name, color')
        .single();
      if (error || !data) fail('Could not update the tag', error);
      return data;
    },
  }),

  defineTool({
    name: 'delete_tag',
    description: 'Delete a tag and remove it from every contact. Cannot be undone. Use dry_run to see how many contacts are affected.',
    scope: 'tags:write',
    tier: 'destructive',
    input: { tag_id: uuid },
    handler: async (ctx, args) => {
      const tag = await requireTag(ctx, args.tag_id);
      const { count } = await ctx.supabase
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('tag_id', tag.id);
      if (ctx.dryRun) return { would_delete: { id: tag.id, name: tag.name }, contacts_affected: count ?? 0 };
      const { error } = await ctx.supabase.from('tags').delete().eq('id', tag.id).eq('account_id', ctx.accountId);
      if (error) fail('Could not delete the tag', error);
      return { deleted: true, id: tag.id, contacts_affected: count ?? 0 };
    },
  }),

  defineTool({
    name: 'add_tag_to_contacts',
    description:
      `Add one tag to up to ${MAX_BULK} contacts (give tag_id or tag_name; a missing name is created). Fires "tag added" automations, so a dry_run first is wise. Contacts that already have the tag are skipped.`,
    scope: 'tags:write',
    tier: 'write',
    input: bulkInput,
    handler: async (ctx, args) => {
      if (!args.tag_id === !args.tag_name) {
        throw new McpToolError('invalid_input', 'Give exactly one of tag_id or tag_name.', 'tag_id');
      }
      const contactIds = await requireContactIds(ctx, args.contact_ids);
      let tagId: string | null = null;
      let willCreateTag = false;
      if (args.tag_id) {
        tagId = (await requireTag(ctx, args.tag_id)).id;
      } else {
        const { tagIdByKey } = await resolveImportTagIds(ctx.supabase, {
          accountId: ctx.accountId,
          userId: ctx.dryRun ? '' : await auditUserId(ctx),
          tagNames: [args.tag_name as string],
          canCreateTags: !ctx.dryRun,
        });
        tagId = tagIdByKey.get((args.tag_name as string).trim().toLowerCase()) ?? null;
        willCreateTag = !tagId;
      }

      const already = new Set<string>();
      if (tagId) {
        for (let i = 0; i < contactIds.length; i += 200) {
          const { data, error } = await ctx.supabase
            .from('contact_tags')
            .select('contact_id')
            .eq('tag_id', tagId)
            .in('contact_id', contactIds.slice(i, i + 200));
          if (error) fail('Could not read existing tags', error);
          for (const r of data ?? []) already.add((r as { contact_id: string }).contact_id);
        }
      }
      const todo = contactIds.filter((id) => !already.has(id));
      if (ctx.dryRun) {
        return { would_add: todo.length, already_tagged: already.size, would_create_tag: willCreateTag };
      }
      if (!tagId) fail('Could not resolve the tag');

      let added = 0;
      let failed = 0;
      for (let i = 0; i < todo.length; i += 10) {
        const results = await Promise.allSettled(
          todo.slice(i, i + 10).map((contactId) =>
            addContactTagAndDispatch({ db: ctx.supabase, accountId: ctx.accountId, contactId, tagId: tagId as string })
          )
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value.added) added++;
          } else {
            failed++;
            console.error('[mcp/core] tag add failed:', r.reason);
          }
        }
      }
      return { tag_id: tagId, added, already_tagged: already.size, failed };
    },
  }),

  defineTool({
    name: 'remove_tag_from_contacts',
    description: `Remove one tag from up to ${MAX_BULK} contacts (give tag_id or tag_name of an existing tag). The tag itself is kept.`,
    scope: 'tags:write',
    tier: 'write',
    input: bulkInput,
    handler: async (ctx, args) => {
      if (!args.tag_id === !args.tag_name) {
        throw new McpToolError('invalid_input', 'Give exactly one of tag_id or tag_name.', 'tag_id');
      }
      const contactIds = await requireContactIds(ctx, args.contact_ids);
      let tag: { id: string } | null;
      if (args.tag_id) tag = await requireTag(ctx, args.tag_id);
      else {
        tag = await findTagByName(ctx, args.tag_name as string);
        if (!tag) throw new McpToolError('not_found', 'No tag with that name. Use list_tags.', 'tag_name');
      }
      const have: string[] = [];
      for (let i = 0; i < contactIds.length; i += 200) {
        const { data, error } = await ctx.supabase
          .from('contact_tags')
          .select('contact_id')
          .eq('tag_id', tag.id)
          .in('contact_id', contactIds.slice(i, i + 200));
        if (error) fail('Could not read existing tags', error);
        for (const r of data ?? []) have.push((r as { contact_id: string }).contact_id);
      }
      if (ctx.dryRun) return { would_remove: have.length, not_tagged: contactIds.length - have.length };
      for (let i = 0; i < have.length; i += 200) {
        const { error } = await ctx.supabase
          .from('contact_tags')
          .delete()
          .eq('tag_id', tag.id)
          .in('contact_id', have.slice(i, i + 200));
        if (error) fail('Could not remove the tag', error);
      }
      return { tag_id: tag.id, removed: have.length, not_tagged: contactIds.length - have.length };
    },
  }),
];
