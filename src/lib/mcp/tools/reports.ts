// MCP 2.0 — "reports" tools (reports:read). All queries live in
// src/lib/reports/analytics.ts and skip staff contacts (is_staff).
import { z } from 'zod';

import {
  agentPerformance,
  broadcastPerformance,
  dashboardSummary,
  dealValueByStage,
  resolveRange,
  spendReport,
  topTags,
} from '@/lib/reports/analytics';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool } from '../types';

const rangeInput = {
  days: z.number().int().min(1).max(366).optional().describe('Look back this many days (default 30).'),
  from: z.string().optional().describe('Range start, ISO date or timestamp. Overrides days.'),
  to: z.string().optional().describe('Range end (exclusive), ISO date or timestamp. Default now.'),
};

function rangeOf(args: { days?: number; from?: string; to?: string }) {
  for (const key of ['from', 'to'] as const) {
    const v = args[key];
    if (v && Number.isNaN(Date.parse(v))) {
      throw new McpToolError('invalid_input', `'${key}' is not a valid date`, key);
    }
  }
  return resolveRange(args);
}

/** Wrap a database failure as a tool error the model can read. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof McpToolError) throw err;
    console.error('[mcp reports]', err instanceof Error ? err.message : err);
    throw new McpToolError('internal', 'The report could not be loaded. Try a shorter date range.');
  }
}

export const reportsTools: AnyMcpTool[] = [
  defineTool({
    name: 'get_dashboard_summary',
    title: 'Dashboard summary',
    description:
      'Headline numbers for a date range: conversations opened and closed, conversations open now, new contacts, messages per day (inbound / outbound) and average / median response time in minutes. Customers only: internal staff contacts are excluded. Use this first for "how is the team doing" questions.',
    scope: 'reports:read',
    tier: 'read',
    input: rangeInput,
    handler: (ctx, args) =>
      guard(() => dashboardSummary(ctx.supabase, ctx.accountId, rangeOf(args))),
  }),

  defineTool({
    name: 'get_broadcast_performance',
    title: 'Broadcast performance',
    description:
      'Delivery, read and reply counts and rates for recent broadcasts in a date range, newest first. Staff contacts are left out of every count. Use list_broadcasts (broadcasts domain) for the broadcast ids.',
    scope: 'reports:read',
    tier: 'read',
    input: {
      ...rangeInput,
      limit: z.number().int().min(1).max(100).optional().describe('How many broadcasts (default 25).'),
    },
    handler: (ctx, args) =>
      guard(() =>
        broadcastPerformance(ctx.supabase, ctx.accountId, rangeOf(args), args.limit ?? 25)
      ),
  }),

  defineTool({
    name: 'get_top_tags',
    title: 'Top tags',
    description:
      'The most used tags with how many customer contacts carry each (staff contacts excluded). Returns tag ids you can pass to the tags tools.',
    scope: 'reports:read',
    tier: 'read',
    input: {
      limit: z.number().int().min(1).max(100).optional().describe('How many tags (default 10).'),
    },
    handler: async (ctx, args) => ({
      items: await guard(() => topTags(ctx.supabase, ctx.accountId, args.limit ?? 10)),
    }),
  }),

  defineTool({
    name: 'get_deal_value_by_stage',
    title: 'Deal value by stage',
    description:
      'Number of deals and their total value in every pipeline stage, for deals with the given status (default open). Deals of staff contacts are excluded.',
    scope: 'reports:read',
    tier: 'read',
    input: {
      status: z.enum(['open', 'won', 'lost']).optional().describe('Deal status (default open).'),
    },
    handler: (ctx, args) =>
      guard(() => dealValueByStage(ctx.supabase, ctx.accountId, args.status ?? 'open')),
  }),

  defineTool({
    name: 'get_spend_report',
    title: 'WhatsApp spend report',
    description:
      'Estimated WhatsApp message spend from the charges ledger (the Transaction Details data): totals, by month, by Meta pricing category (marketing, utility, ...) and cost per broadcast. Amounts are in INR before GST and are estimates from Meta India rates. Messages to staff contacts are excluded, so marketing spend reflects customers only.',
    scope: 'reports:read',
    tier: 'read',
    input: rangeInput,
    handler: (ctx, args) => guard(() => spendReport(ctx.supabase, ctx.accountId, rangeOf(args))),
  }),

  defineTool({
    name: 'get_agent_performance',
    title: 'Agent performance',
    description:
      'Per team member: conversations assigned (chats handled), how many are closed, and first-response time (average / median minutes) for human replies. Customer conversations only; staff contacts are excluded. Names come from team profiles; no emails are returned.',
    scope: 'reports:read',
    tier: 'read',
    input: rangeInput,
    handler: (ctx, args) =>
      guard(() => agentPerformance(ctx.supabase, ctx.accountId, rangeOf(args))),
  }),
];
