// ============================================================
// In-memory Supabase stand-in for the ops tests. Supports the small
// query surface src/lib/ops uses: select / insert / upsert / update /
// delete with eq, neq, in, gt, gte, lt, is, or (keyset), order, limit,
// single / maybeSingle. Embedded selects are not joined: a test row
// carries its embedded objects inline and a dotted filter column
// (`conversations.account_id`) reads into them.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

function getPath(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Row)[key];
    return undefined;
  }, row);
}

const cmp = (a: unknown, b: unknown): number => {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

let counter = 0;

export function fakeDb(tables: Tables, opts: { failTables?: string[] } = {}) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];

  const db = {
    from(table: string) {
      if (opts.failTables?.includes(table)) throw new Error(`no such table ${table}`);
      tables[table] ??= [];
      const preds: ((r: Row) => boolean)[] = [];
      let orders: { col: string; asc: boolean }[] = [];
      let max: number | null = null;
      let mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
      let payload: unknown = null;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let wantRows = false;

      const matching = () => tables[table].filter((r) => preds.every((p) => p(r)));

      const run = (): { data: unknown; error: unknown; count?: number } => {
        calls.push({ table, op: mode, payload });
        if (mode === 'select') {
          let rows = matching().slice();
          for (const { col, asc } of [...orders].reverse()) {
            rows = rows.sort((a, b) => (asc ? 1 : -1) * cmp(getPath(a, col), getPath(b, col)));
          }
          if (max !== null) rows = rows.slice(0, max);
          return { data: rows, error: null, count: rows.length };
        }
        if (mode === 'insert' || mode === 'upsert') {
          const incoming = (Array.isArray(payload) ? payload : [payload]) as Row[];
          const out: Row[] = [];
          for (const r of incoming) {
            const keys = upsertOpts.onConflict?.split(',') ?? [];
            const dup =
              mode === 'upsert' && keys.length > 0
                ? tables[table].find((e) => keys.every((k) => e[k] === r[k]))
                : undefined;
            if (dup) {
              if (!upsertOpts.ignoreDuplicates) Object.assign(dup, r);
              continue;
            }
            const row = { id: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, ...r };
            tables[table].push(row);
            out.push(row);
          }
          return { data: wantRows ? out : null, error: null };
        }
        if (mode === 'update') {
          const rows = matching();
          for (const r of rows) Object.assign(r, payload as Row);
          return { data: wantRows ? rows : null, error: null };
        }
        const rows = matching();
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        return { data: wantRows ? rows : null, error: null };
      };

      const q: Record<string, unknown> = {
        select: () => {
          if (mode !== 'select') wantRows = true;
          return q;
        },
        insert: (p: unknown) => {
          mode = 'insert';
          payload = p;
          return q;
        },
        upsert: (p: unknown, o: typeof upsertOpts) => {
          mode = 'upsert';
          payload = p;
          upsertOpts = o ?? {};
          return q;
        },
        update: (p: unknown) => {
          mode = 'update';
          payload = p;
          return q;
        },
        delete: () => {
          mode = 'delete';
          return q;
        },
        eq: (c: string, v: unknown) => (preds.push((r) => getPath(r, c) === v), q),
        neq: (c: string, v: unknown) => (preds.push((r) => getPath(r, c) !== v), q),
        in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(getPath(r, c))), q),
        is: (c: string, v: unknown) =>
          (preds.push((r) => (getPath(r, c) ?? null) === v), q),
        gt: (c: string, v: unknown) =>
          (preds.push((r) => getPath(r, c) != null && cmp(getPath(r, c), v) > 0), q),
        gte: (c: string, v: unknown) =>
          (preds.push((r) => getPath(r, c) != null && cmp(getPath(r, c), v) >= 0), q),
        lt: (c: string, v: unknown) =>
          (preds.push((r) => getPath(r, c) != null && cmp(getPath(r, c), v) < 0), q),
        or: (expr: string) => {
          // `ts.gt.X,and(ts.eq.X,id.gt.Y)` — the keyset shape.
          const m = expr.match(
            /^(\w+)\.(gt|lt)\.(.+?),and\((\w+)\.eq\.(.+?),(\w+)\.(gt|lt)\.(.+?)\)$/
          );
          if (!m) throw new Error(`fake or() cannot parse ${expr}`);
          const [, c1, o1, v1, c2, v2, c3, o3, v3] = m;
          preds.push((r) => {
            const a = cmp(getPath(r, c1), v1);
            if (o1 === 'gt' ? a > 0 : a < 0) return true;
            return (
              cmp(getPath(r, c2), v2) === 0 &&
              (o3 === 'gt' ? cmp(getPath(r, c3), v3) > 0 : cmp(getPath(r, c3), v3) < 0)
            );
          });
          return q;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          orders = [...orders, { col, asc: o?.ascending !== false }];
          return q;
        },
        limit: (n: number) => ((max = n), q),
        maybeSingle: async () => {
          const r = run();
          const rows = r.data as Row[];
          return { data: rows[0] ?? null, error: null };
        },
        single: async () => {
          const r = run();
          const rows = r.data as Row[];
          return rows[0]
            ? { data: rows[0], error: null }
            : { data: null, error: { message: 'no rows' } };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  } as unknown as SupabaseClient;

  return { db, tables, calls };
}
