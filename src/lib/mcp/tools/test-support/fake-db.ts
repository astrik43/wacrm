// In-memory stand-in for the Supabase query builder, just enough for the
// MCP tool tests: select / insert / update / delete / upsert with
// eq, neq, in, is, not-null, gt/gte/lt/lte, order, limit, single.
// `.or()` and `.ilike()` are accepted and ignored (keyset / text search
// are exercised in the real database, not here).

import type { SupabaseClient } from '@supabase/supabase-js';

import type { McpContext } from '../../types';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Filter = (r: Row) => boolean;

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private patch: Row | Row[] = {};
  private orderBy: { col: string; asc: boolean }[] = [];
  private max = Infinity;
  private wantOne = false;

  constructor(
    private tables: Tables,
    private table: string
  ) {
    if (!tables[table]) tables[table] = [];
  }

  select() {
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  not(c: string, _op: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) !== v);
    return this;
  }
  gt(c: string, v: number) {
    this.filters.push((r) => Number(r[c]) > v);
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(r[c]) >= v);
    return this;
  }
  lt(c: string, v: string) {
    this.filters.push((r) => String(r[c]) < v);
    return this;
  }
  or() {
    return this;
  }
  ilike() {
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) {
    this.orderBy.push({ col: c, asc: o?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.patch = rows;
    return this;
  }
  upsert(rows: Row | Row[]) {
    this.op = 'upsert';
    this.patch = rows;
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  maybeSingle() {
    this.wantOne = true;
    return this;
  }
  single() {
    this.wantOne = true;
    return this;
  }

  private run(): { data: unknown; error: null } {
    const t = this.tables[this.table];
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.patch) ? this.patch : [this.patch];
      const made = list.map((r, i) => ({ id: `${this.table}-${t.length + i + 1}`, ...r }));
      t.push(...made);
      return { data: this.wantOne ? made[0] : made, error: null };
    }
    if (this.op === 'update') {
      const hit = t.filter(match);
      hit.forEach((r) => Object.assign(r, this.patch));
      return { data: this.wantOne ? (hit[0] ?? null) : hit, error: null };
    }
    if (this.op === 'delete') {
      const keep = t.filter((r) => !match(r));
      t.length = 0;
      t.push(...keep);
      return { data: null, error: null };
    }
    let rows = t.filter(match);
    for (const { col, asc } of [...this.orderBy].reverse()) {
      rows = [...rows].sort((a, b) =>
        String(a[col] ?? '') < String(b[col] ?? '') ? (asc ? -1 : 1) : String(a[col] ?? '') > String(b[col] ?? '') ? (asc ? 1 : -1) : 0
      );
    }
    rows = rows.slice(0, this.max);
    return { data: this.wantOne ? (rows[0] ?? null) : rows, error: null };
  }

  then<R1, R2>(
    onfulfilled?: ((v: { data: unknown; error: null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null
  ) {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

export function fakeDb(tables: Tables = {}) {
  const db = { from: (table: string) => new Query(tables, table) } as unknown as SupabaseClient;
  return { db, tables };
}

export function fakeCtx(
  tables: Tables,
  over: Partial<McpContext> = {}
): { ctx: McpContext; tables: Tables } {
  const { db } = fakeDb(tables);
  return {
    tables,
    ctx: {
      supabase: db,
      accountId: 'acct-1',
      keyId: 'key-1',
      scopes: [],
      createdBy: 'user-1',
      dryRun: false,
      ...over,
    },
  };
}
