// ============================================================
// In-memory stand-in for the Supabase query builder, for tests only.
// Supports the handful of operators the reports and commerce tools
// use (eq / neq / in / gt(e) / lt(e) / ilike / is / order / range /
// limit / maybeSingle / single, plus insert / update / upsert /
// delete). Every filter is applied for real, so a test that forgets
// an account_id filter sees another account's rows.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

export interface Write {
  table: string;
  op: 'insert' | 'update' | 'upsert' | 'delete';
  values?: Row | Row[];
  filters?: Record<string, unknown>;
}

export function fakeDb(initial: Tables) {
  const tables: Tables = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((r) => ({ ...r }));
  const writes: Write[] = [];

  function query(table: string) {
    type Pred = (r: Row) => boolean;
    const preds: Pred[] = [];
    const eqFilters: Record<string, unknown> = {};
    let order: { col: string; asc: boolean }[] = [];
    let from = 0;
    let to = Infinity;
    let head = false;
    let columns: string[] | null = null;
    let mode: 'select' | Write['op'] = 'select';
    let payload: Row | Row[] | undefined;

    const cmp = (a: unknown, b: unknown) =>
      (a as never) < (b as never) ? -1 : (a as never) > (b as never) ? 1 : 0;
    const run = () => {
      const rows = (tables[table] ??= []);
      if (mode === 'insert' || mode === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        writes.push({ table, op: mode, values: payload });
        rows.push(...list.map((r) => ({ ...r })));
        return { data: list, error: null, count: list.length };
      }
      const matched = rows.filter((r) => preds.every((p) => p(r)));
      if (mode === 'update') {
        writes.push({ table, op: 'update', values: payload, filters: eqFilters });
        for (const r of matched) Object.assign(r, payload);
        return { data: matched, error: null, count: matched.length };
      }
      if (mode === 'delete') {
        writes.push({ table, op: 'delete', filters: eqFilters });
        tables[table] = rows.filter((r) => !matched.includes(r));
        return { data: matched, error: null, count: matched.length };
      }
      const sorted = [...matched];
      for (const o of [...order].reverse()) {
        sorted.sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
      }
      let page = sorted.slice(from, to === Infinity ? undefined : to + 1);
      const cols = columns;
      if (cols) {
        page = page.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      }
      return { data: head ? null : page, error: null, count: matched.length };
    };

    const q: Record<string, unknown> = {
      select: (cols?: string, opts?: { head?: boolean }) => {
        head = opts?.head === true;
        columns = cols && cols !== '*' ? cols.split(',').map((c) => c.trim()) : null;
        return q;
      },
      insert: (v: Row | Row[]) => ((mode = 'insert'), (payload = v), q),
      upsert: (v: Row | Row[]) => ((mode = 'upsert'), (payload = v), q),
      update: (v: Row) => ((mode = 'update'), (payload = v), q),
      delete: () => ((mode = 'delete'), q),
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), (eqFilters[c] = v), q),
      neq: (c: string, v: unknown) => (preds.push((r) => r[c] !== v), q),
      in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(r[c])), q),
      is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, op: string, v: unknown) => (
        op === 'is' && preds.push((r) => (r[c] ?? null) !== v), q
      ),
      gt: (c: string, v: unknown) => (preds.push((r) => (r[c] as never) > (v as never)), q),
      gte: (c: string, v: unknown) => (preds.push((r) => (r[c] as never) >= (v as never)), q),
      lt: (c: string, v: unknown) => (preds.push((r) => (r[c] as never) < (v as never)), q),
      lte: (c: string, v: unknown) => (preds.push((r) => (r[c] as never) <= (v as never)), q),
      ilike: (c: string, v: string) => {
        const needle = v.replace(/%/g, '').toLowerCase();
        preds.push((r) => String(r[c] ?? '').toLowerCase().includes(needle));
        return q;
      },
      or: () => q,
      order: (c: string, o?: { ascending?: boolean }) => (
        (order = [...order, { col: c, asc: o?.ascending !== false }]), q
      ),
      limit: (n: number) => ((to = from + n - 1), q),
      range: (a: number, b: number) => ((from = a), (to = b), q),
      maybeSingle: async () => {
        const r = run();
        return { data: (r.data as Row[] | null)?.[0] ?? null, error: null };
      },
      single: async () => {
        const r = run();
        const row = (r.data as Row[] | null)?.[0] ?? null;
        return { data: row, error: row ? null : { message: 'not found' } };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return q;
  }

  const db = { from: (table: string) => query(table) } as unknown as SupabaseClient;
  return { db, tables, writes };
}
