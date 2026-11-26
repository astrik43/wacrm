// ============================================================
// Run one tool call: scope check, confirm gate, dry run, idempotent
// replay, audit. Every tool goes through here, so the safety rules
// live in one place and no handler can forget them.
// ============================================================

import { z } from 'zod';

import { hasScope } from '@/lib/api-keys/scopes';

import { findIdempotent, writeAudit } from './audit';
import { McpToolError } from './errors';
import type { AnyMcpTool, McpContext } from './types';

/** The arguments the server adds on top of a tool's own `input`. */
export function extraShape(tool: AnyMcpTool): z.ZodRawShape {
  if (tool.tier === 'read') return {};
  const extra: Record<string, z.ZodType> = {
    dry_run: z
      .boolean()
      .optional()
      .describe('Preview only: change and send nothing, return what would happen.'),
    idempotency_key: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Retrying with the same key returns the first result instead of acting twice.'),
  };
  if (tool.tier === 'destructive') {
    extra.confirm = z
      .boolean()
      .optional()
      .describe('Must be true to run. Ask the user first; a dry run does not need it.');
  }
  return extra;
}

export type CallerContext = Omit<McpContext, 'dryRun'>;

export async function runTool(
  tool: AnyMcpTool,
  caller: CallerContext,
  rawArgs: unknown
): Promise<unknown> {
  if (tool.scope && !hasScope(caller.scopes, tool.scope)) {
    throw new McpToolError('missing_scope', `This API key is missing the '${tool.scope}' scope`);
  }

  const parsed = z.object({ ...tool.input, ...extraShape(tool) }).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new McpToolError(
      'invalid_input',
      issue?.message ?? 'Invalid arguments',
      issue?.path.join('.') || undefined
    );
  }
  const { dry_run, idempotency_key, confirm, ...args } = parsed.data as Record<string, unknown> & {
    dry_run?: boolean;
    idempotency_key?: string;
    confirm?: boolean;
  };
  const dryRun = dry_run === true;
  const ctx: McpContext = { ...caller, dryRun };

  if (tool.tier === 'read') return tool.handler(ctx, args);

  if (tool.tier === 'destructive' && !dryRun && confirm !== true) {
    throw new McpToolError(
      'confirm_required',
      `'${tool.name}' cannot be undone. Ask the user, then call again with confirm: true (or dry_run: true to preview).`,
      'confirm'
    );
  }

  if (idempotency_key && !dryRun) {
    const earlier = await findIdempotent(caller.supabase, caller.accountId, tool.name, idempotency_key);
    if (earlier) {
      const prior = earlier.result;
      return prior && typeof prior === 'object' && !Array.isArray(prior)
        ? { ...(prior as Record<string, unknown>), idempotent_replay: true }
        : { result: prior, idempotent_replay: true };
    }
  }

  const started = Date.now();
  const base = {
    accountId: caller.accountId,
    keyId: caller.keyId,
    tool: tool.name,
    tier: tool.tier,
    args,
    idempotencyKey: idempotency_key,
  } as const;
  try {
    const result = await tool.handler(ctx, args);
    await writeAudit(caller.supabase, {
      ...base,
      status: dryRun ? 'dry_run' : 'ok',
      result,
      durationMs: Date.now() - started,
    });
    return dryRun && result && typeof result === 'object' && !Array.isArray(result)
      ? { dry_run: true, ...(result as Record<string, unknown>) }
      : result;
  } catch (err) {
    await writeAudit(caller.supabase, {
      ...base,
      status: 'error',
      errorCode: err instanceof McpToolError ? err.code : 'internal',
      result: { message: err instanceof Error ? err.message : String(err) },
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
