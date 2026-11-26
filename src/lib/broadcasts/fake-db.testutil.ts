// In-memory stand-in for the slice of the Supabase query builder the
// broadcast code uses. Tests only: it never talks to a real database.

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Filter = (row: Row) => boolean;

let seq = 0;
export function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function digits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Embedded to-one joins this fake understands: alias -> [table, foreign key]. */
const EMBEDS: Record<string, [string, string]> = {
  contact: ['contacts', 'contact_id'],
};

export interface FakeDb {
  db: SupabaseClient;
  tables: Tables;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
}

export function createFakeDb(initial: Tables = {}): FakeDb {
  const tables: Tables = {};
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((r) => ({
      ...r,
      ...(name === 'contacts' ? { phone_normalized: digits(r.phone) } : {}),
    }));
  }
  const rpcCalls: FakeDb['rpcCalls'] = [];

  const table = (name: string) => (tables[name] ??= []);

  const prepare = (name: string, row: Row): Row => {
    const out: Row = { id: uuid(), created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(), ...row };
    if (name === 'contacts') out.phone_normalized = digits(out.phone);
    return out;
  };

  function from(name: string) {
    let mode: 'select' | 'update' | 'delete' | 'insert' = 'select';
    let patch: Row = {};
    let inserted: Row[] = [];
    const filters: Filter[] = [];
    let embed: string | null = null;
    let head = false;
    let count = false;
    const orderBy: { col: string; asc: boolean }[] = [];
    let range: [number, number] | null = null;
    let max: number | null = null;
    let single: 'maybe' | 'one' | null = null;
    let returning = false;

    const run = () => {
      const rows = table(name);
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      const shape = (list: Row[]) => (single ? (list[0] ?? null) : list);
      if (mode === 'insert') {
        return { data: returning ? shape(inserted) : null, error: null };
      }
      if (mode === 'update') {
        for (const r of matched) Object.assign(r, patch);
        return { data: returning ? shape(matched) : null, error: null };
      }
      if (mode === 'delete') {
        tables[name] = rows.filter((r) => !matched.includes(r));
        return { data: null, error: null };
      }
      let out = matched.slice();
      for (const o of [...orderBy].reverse()) {
        out.sort((a, b) => {
          const av = String(a[o.col] ?? '');
          const bv = String(b[o.col] ?? '');
          return o.asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (max !== null) out = out.slice(0, max);
      if (embed) {
        const [target, fk] = EMBEDS[embed] ?? [];
        out = out.map((r) => ({ ...r, [embed!]: target ? (table(target).find((t) => t.id === r[fk]) ?? null) : null }));
      }
      if (head) return { data: null, count: matched.length, error: null };
      const base = { count: count ? matched.length : undefined, error: null };
      if (single) return { ...base, data: out[0] ?? null };
      return { ...base, data: out };
    };

    const q = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        if (mode === 'insert' || mode === 'update') returning = true;
        const m = typeof cols === 'string' ? cols.match(/(\w+):(\w+)\(/) : null;
        if (m) embed = m[1];
        if (opts?.count) count = true;
        if (opts?.head) head = true;
        return q;
      },
      insert(rows: Row | Row[]) {
        mode = 'insert';
        inserted = (Array.isArray(rows) ? rows : [rows]).map((r) => prepare(name, r));
        table(name).push(...inserted);
        return q;
      },
      update(p: Row) {
        mode = 'update';
        patch = p;
        return q;
      },
      delete() {
        mode = 'delete';
        return q;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return q;
      },
      neq(col: string, v: unknown) {
        filters.push((r) => r[col] !== v);
        return q;
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]));
        return q;
      },
      ilike(col: string, pattern: string) {
        const needle = pattern.replace(/%/g, '').toLowerCase();
        filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle));
        return q;
      },
      or(expr: string) {
        // Only the delivery-lock claim is understood; keyset cursors pass through.
        const m = expr.match(/delivery_locked_at\.is\.null,delivery_locked_at\.lt\.(.+)$/);
        if (m) {
          filters.push((r) => r.delivery_locked_at == null || String(r.delivery_locked_at) < m[1]);
        }
        return q;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy.push({ col, asc: opts?.ascending !== false });
        return q;
      },
      range(from: number, to: number) {
        range = [from, to];
        return q;
      },
      limit(n: number) {
        max = n;
        return q;
      },
      maybeSingle() {
        single = 'maybe';
        return q;
      },
      single() {
        single = 'one';
        return q;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return q;
  }

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn !== 'create_broadcast_with_recipients') return { data: null, error: { message: 'unknown rpc' } };
    const broadcast = prepare('broadcasts', {
      account_id: args.p_account_id,
      user_id: args.p_user_id,
      name: args.p_name,
      template_name: args.p_template_name,
      template_language: args.p_template_language,
      status: 'sending',
      total_recipients: args.p_total_recipients,
      delivery_locked_at: null,
    });
    table('broadcasts').push(broadcast);
    const ids = args.p_contact_ids as string[];
    const params = args.p_template_params as unknown[];
    const data = ids.map((contactId, i) => {
      const rec = prepare('broadcast_recipients', {
        broadcast_id: broadcast.id,
        contact_id: contactId,
        status: 'pending',
        template_params: params[i] ?? null,
      });
      table('broadcast_recipients').push(rec);
      return { broadcast_id: broadcast.id, recipient_id: rec.id, contact_id: contactId };
    });
    return { data, error: null };
  };

  const db = { from, rpc } as unknown as SupabaseClient;
  return { db, tables, rpcCalls };
}
