// ============================================================
// Build an MCP server for one authenticated request. Only the tools
// the API key can use are listed, so the model never sees (or tries)
// a tool it would be refused.
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { hasScope } from '@/lib/api-keys/scopes';

import { McpToolError } from './errors';
import { extraShape, runTool, type CallerContext } from './executor';
import { ALL_TOOLS } from './tools';
import type { AnyMcpTool } from './types';

export const MCP_SERVER_VERSION = '2.0.0';

export function toolsForScopes(scopes: readonly string[], tools: AnyMcpTool[] = ALL_TOOLS) {
  return tools.filter((t) => t.scope === null || hasScope(scopes, t.scope));
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload ?? null, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const body =
    err instanceof McpToolError
      ? err.toJSON()
      : { code: 'internal', message: 'Unexpected error' };
  if (!(err instanceof McpToolError)) console.error('[mcp] tool failed:', err);
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

export function createMcpServer(
  caller: CallerContext,
  tools: AnyMcpTool[] = ALL_TOOLS
): McpServer {
  const server = new McpServer({ name: 'wacrm', version: MCP_SERVER_VERSION });

  for (const tool of toolsForScopes(caller.scopes, tools)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title ?? tool.name,
        description: tool.description,
        inputSchema: { ...tool.input, ...extraShape(tool) } as z.ZodRawShape,
        annotations: {
          readOnlyHint: tool.tier === 'read',
          destructiveHint: tool.tier === 'destructive',
        },
      },
      async (args: unknown) => {
        try {
          return ok(await runTool(tool, caller, args));
        } catch (err) {
          return fail(err);
        }
      }
    );
  }
  return server;
}
