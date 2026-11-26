// ============================================================
// Audit log + idempotency for non-read tools (mcp_audit_log, 054).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ToolTier } from './types';

// Secrets, plus customer contact details: an audit row should say which
// tool ran and on what, not keep a customer's number or address.
const SECRET_KEY =
  /secret|token|password|api[_-]?key|authorization|credential|phone|email|address/i;
const MAX_STRING = 500;
const MAX_JSON_BYTES = 20_000;

/** Copy of `value` with secret-looking fields masked and long strings cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redacted, size-capped JSON for the log. */
export function forLog(value: unknown): unknown {
  const cleaned = redact(value);
  const size = JSON.stringify(cleaned ?? null).length;
  return size > MAX_JSON_BYTES ? { truncated: true, bytes: size } : cleaned;
}

export interface AuditEntry {
  accountId: string;
  keyId: string;
  tool: string;
  tier: Exclude<ToolTier, 'read'>;
  status: 'ok' | 'error' | 'dry_run';
  args: unknown;
  result?: unknown;
  errorCode?: string;
  idempotencyKey?: string;
  durationMs: number;
}

/** Best-effort: a logging failure must never fail the tool call. */
export async function writeAudit(db: SupabaseClient, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await db.from('mcp_audit_log').insert({
      account_id: entry.accountId,
      api_key_id: entry.keyId,
      tool: entry.tool,
      tier: entry.tier,
      status: entry.status,
      args: forLog(entry.args),
      result: entry.result === undefined ? null : forLog(entry.result),
      error_code: entry.errorCode ?? null,
      idempotency_key: entry.status === 'ok' ? (entry.idempotencyKey ?? null) : null,
      duration_ms: entry.durationMs,
    });
    if (error) console.error('[mcp] audit write failed:', error.message);
  } catch (err) {
    console.error('[mcp] audit write failed:', err);
  }
}

/** The stored result of an earlier successful call with this key, if any. */
export async function findIdempotent(
  db: SupabaseClient,
  accountId: string,
  tool: string,
  key: string
): Promise<{ result: unknown } | null> {
  const { data } = await db
    .from('mcp_audit_log')
    .select('result')
    .eq('account_id', accountId)
    .eq('tool', tool)
    .eq('idempotency_key', key)
    .eq('status', 'ok')
    .limit(1)
    .maybeSingle();
  return data ? { result: (data as { result: unknown }).result } : null;
}
