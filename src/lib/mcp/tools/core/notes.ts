// Contact notes. Notes live in contact_notes (account_id scoped).
import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../../types';
import { DEFAULT_PAGE, auditUserId, cursorInput, fail, limitInput, requireContact, uuid } from './helpers';

const NOTE_TEXT = z.string().min(1).max(5000);
const NOTE_COLUMNS = 'id, contact_id, note_text, user_id, created_at';

async function requireNote(ctx: McpContext, noteId: string): Promise<{ id: string; contact_id: string; note_text: string }> {
  const { data, error } = await ctx.supabase
    .from('contact_notes')
    .select('id, contact_id, note_text')
    .eq('id', noteId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) fail('Could not look up the note', error);
  if (!data) throw new McpToolError('not_found', 'Note not found in this account. Use list_contact_notes for ids.', 'note_id');
  return data as { id: string; contact_id: string; note_text: string };
}

function shape(row: Record<string, unknown>) {
  return { id: row.id, contact_id: row.contact_id, text: row.note_text, author_user_id: row.user_id, created_at: row.created_at };
}

export const noteTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_contact_notes',
    description: 'List the internal notes on a contact, newest first. contact_id comes from search_contacts.',
    scope: 'notes:read',
    tier: 'read',
    input: { contact_id: uuid, limit: limitInput, cursor: cursorInput },
    handler: async (ctx, args) => {
      await requireContact(ctx, args.contact_id);
      const limit = args.limit ?? DEFAULT_PAGE;
      let q = ctx.supabase
        .from('contact_notes')
        .select(NOTE_COLUMNS)
        .eq('account_id', ctx.accountId)
        .eq('contact_id', args.contact_id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      const f = keysetFilter(decodeCursor(args.cursor ?? null));
      if (f) q = q.or(f);
      const { data, error } = await q;
      if (error) fail('Could not load notes', error);
      const { items, nextCursor } = buildPage((data ?? []) as { id: string; created_at: string }[], limit);
      return { items: items.map((n) => shape(n as unknown as Record<string, unknown>)), next_cursor: nextCursor };
    },
  }),

  defineTool({
    name: 'add_contact_note',
    description: 'Add an internal note (never sent to the customer) to a contact.',
    scope: 'notes:write',
    tier: 'write',
    input: { contact_id: uuid, text: NOTE_TEXT },
    handler: async (ctx, args) => {
      await requireContact(ctx, args.contact_id);
      if (ctx.dryRun) return { would_create: { contact_id: args.contact_id, text: args.text } };
      const { data, error } = await ctx.supabase
        .from('contact_notes')
        .insert({ account_id: ctx.accountId, contact_id: args.contact_id, user_id: await auditUserId(ctx), note_text: args.text })
        .select(NOTE_COLUMNS)
        .single();
      if (error || !data) fail('Could not add the note', error);
      return shape(data as Record<string, unknown>);
    },
  }),

  defineTool({
    name: 'edit_contact_note',
    description: 'Replace the text of an existing note. note_id comes from list_contact_notes.',
    scope: 'notes:write',
    tier: 'write',
    input: { note_id: uuid, text: NOTE_TEXT },
    handler: async (ctx, args) => {
      const note = await requireNote(ctx, args.note_id);
      if (ctx.dryRun) return { would_update: { id: note.id, from: note.note_text, to: args.text } };
      const { data, error } = await ctx.supabase
        .from('contact_notes')
        .update({ note_text: args.text })
        .eq('id', note.id)
        .eq('account_id', ctx.accountId)
        .select(NOTE_COLUMNS)
        .single();
      if (error || !data) fail('Could not edit the note', error);
      return shape(data as Record<string, unknown>);
    },
  }),

  defineTool({
    name: 'delete_contact_note',
    description: 'Permanently delete a note. note_id comes from list_contact_notes.',
    scope: 'notes:write',
    tier: 'destructive',
    input: { note_id: uuid },
    handler: async (ctx, args) => {
      const note = await requireNote(ctx, args.note_id);
      if (ctx.dryRun) return { would_delete: { id: note.id, text: note.note_text } };
      const { error } = await ctx.supabase.from('contact_notes').delete().eq('id', note.id).eq('account_id', ctx.accountId);
      if (error) fail('Could not delete the note', error);
      return { deleted: true, id: note.id };
    },
  }),
];
