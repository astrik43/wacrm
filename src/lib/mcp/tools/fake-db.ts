// In-memory stand-in for the slice of the supabase-js query builder the
// pipeline / automations / flows tools use. Test helper only.
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

let counter = 0;
export const newId = () =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

export class FakeDb {
  tables: Record<string, Row[]> = {};

  seed(table: string, rows: Row[]) {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  client(): SupabaseClient {
    return { from: (t: string) => new Query(this, t) } as unknown as SupabaseClient;
  }
}

class Query {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] = {};
  private orders: { col: string; asc: boolean }[] = [];
  private max = Infinity;
  private head = false;
  private wantCount = false;
  private cols: string[] | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.cols = cols && cols !== '*' ? cols.split(',').map((c) => c.trim()) : null;
      this.head = opts?.head === true;
      this.wantCount = opts?.count !== undefined;
    }
    return this;
  }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  update(p: Row) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  delete() {
    this.op = 'delete';
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
  gte(c: string, v: number) {
    this.filters.push((r) => Number(r[c]) >= v);
    return this;
  }
  lte(c: string, v: number) {
    this.filters.push((r) => Number(r[c]) <= v);
    return this;
  }
  or() {
    return this; // keyset cursors are not exercised against the fake
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orders.push({ col, asc: o?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    return this.run().then((r) => ({ data: (r.data as Row[])[0] ?? null, error: r.error }));
  }
  single() {
    return this.run().then((r) => {
      const row = (r.data as Row[])[0];
      return row ? { data: row, error: null } : { data: null, error: { message: 'no row' } };
    });
  }
  then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
    return this.run().then(resolve, reject);
  }

  private async run(): Promise<{ data: Row[] | null; error: null | { message: string }; count?: number }> {
    const all = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === 'insert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => ({
        id: newId(),
        created_at: new Date().toISOString(),
        ...p,
      }));
      all.push(...list);
      return { data: list, error: null };
    }
    if (this.op === 'update') {
      const hit = all.filter(match);
      hit.forEach((r) => Object.assign(r, this.payload));
      return { data: hit, error: null };
    }
    if (this.op === 'delete') {
      const hit = all.filter(match);
      this.db.tables[this.table] = all.filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }
    let out = all.filter(match);
    for (const o of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => {
        const x = String(a[o.col] ?? '');
        const y = String(b[o.col] ?? '');
        return o.asc ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    const count = out.length;
    out = out.slice(0, this.max);
    const cols = this.cols;
    if (cols) {
      out = out.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
    }
    return { data: this.head ? null : out, error: null, ...(this.wantCount ? { count } : {}) };
  }
}
