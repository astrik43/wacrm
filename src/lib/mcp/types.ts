// ============================================================
// MCP 2.0 tool definitions.
//
// A tool is data: a name, the API-key scope it needs, a safety tier,
// a zod input shape and a handler. One registry (tools/index.ts) feeds
// the remote endpoint (/api/mcp), so the dashboard, the v1 API and the
// agent all go through the same src/lib code — no logic is duplicated
// in a tool.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';

import type { ApiScope } from '@/lib/api-keys/scopes';

/**
 * - read        — never changes anything. No audit row, no confirm.
 * - write       — changes data or sends a message. Audited; accepts
 *                 `dry_run` and `idempotency_key`.
 * - destructive — deletes, mass-sends or can't be undone. Everything a
 *                 write has, plus it refuses to run without
 *                 `confirm: true` (a dry run needs no confirm).
 */
export type ToolTier = 'read' | 'write' | 'destructive';

export interface McpContext {
  /** Service-role client. RLS is bypassed: scope EVERY query by accountId. */
  supabase: SupabaseClient;
  accountId: string;
  keyId: string;
  scopes: string[];
  /** The user who minted the key — the audit user for writes. */
  createdBy: string | null;
  /**
   * True when the caller passed `dry_run: true`. A write/destructive
   * handler must then change NOTHING and return what it would have done
   * (the exact Meta payload, the recipient count, the rows affected).
   */
  dryRun: boolean;
}

export interface McpTool<S extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case, unique across the registry. */
  name: string;
  title?: string;
  /** What it does and when to use it — this is what the model reads. */
  description: string;
  /** Scope the key must hold; null = any valid key. */
  scope: ApiScope | null;
  tier: ToolTier;
  /** zod raw shape. Do NOT declare dry_run / idempotency_key / confirm: the server adds them. */
  input: S;
  /** Return JSON-serialisable data. Throw McpToolError for expected failures. */
  handler: (ctx: McpContext, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpTool = McpTool<any>;

/** Identity helper that infers the handler's `args` type from `input`. */
export function defineTool<S extends z.ZodRawShape>(tool: McpTool<S>): AnyMcpTool {
  return tool as AnyMcpTool;
}
