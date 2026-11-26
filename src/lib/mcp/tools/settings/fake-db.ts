// Test-only in-memory stand-in for the supabase query builder used by
// the ai/settings tool tests. Supports the chain the tools use:
// select/insert/update/delete + eq/is/in/order/limit/or + maybeSingle/single.
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const log: Array<{ table: string; op: string; payload?: unknown }> = [];

  const from = (table: string) => {
    tables[table] ??= [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | Row[] | undefined;
    let head = false;
    let limitN: number | null = null;
    const filters: Array<(r: Row) => boolean> = [];

    const matched = () => tables[table].filter((r) => filters.every((f) => f(r)));

    const run = () => {
      if (op === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload as Row]).map((r) => ({
          id: `id-${++seq}`,
          created_at: new Date().toISOString(),
          ...r,
        }));
        tables[table].push(...rows);
        log.push({ table, op, payload });
        return rows;
      }
      if (op === 'update') {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, payload));
        log.push({ table, op, payload });
        return rows;
      }
      if (op === 'delete') {
        const rows = matched();
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        log.push({ table, op });
        return rows;
      }
      let rows = matched();
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };

    const q: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        head = !!opts?.head;
        return q;
      },
      insert: (p: Row | Row[]) => {
        op = 'insert';
        payload = p;
        return q;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return q;
      },
      delete: () => {
        op = 'delete';
        return q;
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
      gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
      contains: () => q,
      or: () => q,
      order: () => q,
      limit: (n: number) => ((limitN = n), q),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        const rows = run();
        return Promise.resolve(
          resolve({ data: head ? null : rows, count: rows.length, error: null })
        );
      },
    };
    return q;
  };

  return { db: { from } as unknown as SupabaseClient, tables, log };
}
