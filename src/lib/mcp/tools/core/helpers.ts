// Shared helpers for the "core" MCP tools (contacts, tags, notes, team).
import { z } from 'zod';

import { resolveAuditUserId } from '@/lib/api/v1/contacts';

import { McpToolError } from '../../errors';
import type { McpContext } from '../../types';

export const uuid = z.string().uuid();

export const limitInput = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Page size, 1-100 (default 25).');

export const cursorInput = z
  .string()
  .optional()
  .describe('Opaque cursor from the previous page next_cursor.');

export const DEFAULT_PAGE = 25;

/** Throw a stable internal error (never leak raw database messages). */
export function fail(what: string, error?: unknown): never {
  if (error) console.error(`[mcp/core] ${what}:`, error);
  throw new McpToolError('internal', `${what}. Try again; if it keeps failing check the server logs.`);
}

/** The user writes are attributed to: the key's creator, else the account's audit user. */
export async function auditUserId(ctx: McpContext): Promise<string> {
  if (ctx.createdBy) return ctx.createdBy;
  try {
    return await resolveAuditUserId(ctx.supabase, ctx.accountId);
  } catch {
    return fail('Could not resolve the account owner');
  }
}

/** Verify a contact belongs to the account; returns the row. */
export async function requireContact(
  ctx: McpContext,
  contactId: string,
  select = 'id'
): Promise<Record<string, unknown>> {
  const { data, error } = await ctx.supabase
    .from('contacts')
    .select(select)
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) fail('Could not look up the contact', error);
  if (!data) {
    throw new McpToolError('not_found', 'Contact not found in this account. Use search_contacts to find the id.', 'contact_id');
  }
  return data as unknown as Record<string, unknown>;
}

/** Verify a tag belongs to the account; returns the row. */
export async function requireTag(ctx: McpContext, tagId: string): Promise<{ id: string; name: string; color: string }> {
  const { data, error } = await ctx.supabase
    .from('tags')
    .select('id, name, color')
    .eq('id', tagId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) fail('Could not look up the tag', error);
  if (!data) throw new McpToolError('not_found', 'Tag not found in this account. Use list_tags to get tag ids.', 'tag_id');
  return data as { id: string; name: string; color: string };
}

/**
 * Verify every id belongs to the account. Throws not_found when any is
 * missing (another account's id looks exactly like a missing one).
 */
export async function requireContactIds(ctx: McpContext, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const found = new Set<string>();
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const { data, error } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('account_id', ctx.accountId)
      .in('id', chunk);
    if (error) fail('Could not verify the contacts', error);
    for (const r of data ?? []) found.add((r as { id: string }).id);
  }
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new McpToolError(
      'not_found',
      `${missing.length} contact id(s) were not found in this account (first: ${missing[0]}). Use search_contacts for valid ids.`,
      'contact_ids'
    );
  }
  return unique;
}

/** Strip characters that would break out of a PostgREST .or() / ilike expression. */
export function safeSearch(q: string): string {
  return q.replace(/[,()%*\\_"']/g, ' ').trim();
}
