// Helpers shared by the pipeline / automations / flows tool files.
// Not a tool file: nothing here is registered.

import { z } from 'zod';

import { buildPage, decodeCursor, keysetFilter } from '@/lib/api/v1/pagination';

import { McpToolError } from '../errors';
import type { McpContext } from '../types';

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Page size, 1-100 (default 25).');

export const cursorField = z
  .string()
  .optional()
  .describe('Opaque cursor: pass the next_cursor from the previous page to get the next one.');

export const uuid = (what: string) => z.string().uuid().describe(what);

export function failDb(error: { message: string } | null | undefined): never {
  throw new McpToolError('internal', error?.message ?? 'Database error');
}

/** Throw not_found unless the account owns the row (tables that carry account_id). */
export async function loadAccountRow(
  ctx: McpContext,
  table: string,
  id: string,
  label: string,
  columns = '*'
): Promise<Record<string, unknown>> {
  const { data, error } = await ctx.supabase
    .from(table)
    .select(columns)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) failDb(error);
  if (!data) throw new McpToolError('not_found', `${label} ${id} not found in this account.`);
  return data as unknown as Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Keyset-paginate (<column> desc, id desc; column defaults to created_at).
 * `base` is a query already filtered by account (and anything else); this
 * adds order, cursor, limit.
 */
export async function paginate<T extends { id: string }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: any,
  args: { limit?: number; cursor?: string },
  column = 'created_at'
): Promise<Page<T>> {
  const limit = args.limit ?? 25;
  let q = base.order(column, { ascending: false }).order('id', { ascending: false });
  const f = keysetFilter(decodeCursor(args.cursor ?? null));
  // The shared cursor helper speaks created_at; point it at our column.
  if (f) q = q.or(column === 'created_at' ? f : f.replaceAll('created_at', column));
  const { data, error } = await q.limit(limit + 1);
  if (error) failDb(error);
  const rows = (data ?? []) as (T & Record<string, string>)[];
  const { items, nextCursor } = buildPage(
    rows.map((r) => ({ ...r, created_at: r[column] })),
    limit
  );
  return {
    items: items.map((r) => {
      const rest = { ...r } as Record<string, unknown>;
      if (column !== 'created_at') delete rest.created_at;
      return rest as unknown as T;
    }),
    next_cursor: nextCursor,
  };
}
