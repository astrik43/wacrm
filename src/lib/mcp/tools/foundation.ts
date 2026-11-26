// ============================================================
// Foundation tools — available to every valid key (no scope).
// ============================================================

import { z } from 'zod';

import { getAccountName } from '@/lib/api-keys/store';

import { defineTool, type AnyMcpTool } from '../types';

export function foundationTools(listVisible: (scopes: readonly string[]) => number): AnyMcpTool[] {
  return [
    defineTool({
      name: 'whoami',
      title: 'Who am I',
      description:
        'Show the account this API key belongs to, the scopes it carries, and how many tools it can use. Call this first to see what you are allowed to do.',
      scope: null,
      tier: 'read',
      input: {
        verbose: z.boolean().optional().describe('Also list the scopes (default true).'),
      },
      handler: async (ctx) => ({
        account: { id: ctx.accountId, name: await getAccountName(ctx.accountId) },
        key: { id: ctx.keyId, scopes: ctx.scopes },
        tools_available: listVisible(ctx.scopes),
      }),
    }),
  ];
}
