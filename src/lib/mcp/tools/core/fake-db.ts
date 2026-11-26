// Test-only chainable fake of the Supabase query builder. Records every
// call so tests can assert account scoping, and answers from canned data.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface Resp {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}
export interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  calls: { m: string; args: unknown[] }[];
}
type Handler = Resp | ((c: Call) => Resp);

/** `handlers` keys: `table` or `table.op`. Unlisted -> { data: null }. */
export function fakeDb(handlers: Record<string, Handler> = {}) {
  const log: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: 'select', calls: [] };
      log.push(call);
      const resolve = (): Resp => {
        const h = handlers[`${table}.${call.op}`] ?? handlers[table];
        if (!h) return { data: null };
        return typeof h === 'function' ? h(call) : h;
      };
      const b: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve(resolve()).then(res, rej);
            }
            return (...args: unknown[]) => {
              call.calls.push({ m: prop, args });
              if (['insert', 'update', 'delete', 'upsert'].includes(prop)) call.op = prop as Call['op'];
              return b;
            };
          },
        }
      );
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, log };
}

export function hasEq(call: Call, column: string, value?: unknown): boolean {
  return call.calls.some((c) => c.m === 'eq' && c.args[0] === column && (value === undefined || c.args[1] === value));
}

export function ctxFor(db: SupabaseClient, scopes: string[] = [], dryRun = false) {
  return {
    supabase: db,
    accountId: 'acc-1',
    keyId: 'key-1',
    scopes,
    createdBy: '11111111-1111-4111-8111-111111111111',
    dryRun,
  };
}
