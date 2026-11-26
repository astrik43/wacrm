import { z } from 'zod';

import { decodeCursor } from '@/lib/api/v1/pagination';
import { EVENT_TYPES, listEventsSince } from '@/lib/ops/feed';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';

export const eventTools = [
  defineTool({
    name: 'list_events_since',
    title: 'Read the event feed',
    description:
      'Poll for what happened since the last call, oldest first: inbound_message, button_reply, ndr_reply (customer answered the NDR message: carries the ORDER NUMBER, so you can post it as a comment on the ERP order), cod_confirmation, order_event (order placed, shipment update with AWB) and tag_added. Pass the next_cursor from the previous call as cursor; every event appears exactly once. The first call (no cursor) returns the last 24 hours, or use since (ISO time). Events carry ids, order numbers and a short text excerpt, never phone numbers.',
    scope: 'events:read',
    tier: 'read',
    input: {
      cursor: z.string().optional().describe('next_cursor from the previous call.'),
      since: z.string().optional().describe('ISO time to start from when there is no cursor.'),
      types: z.array(z.enum(EVENT_TYPES)).max(6).optional().describe('Default: all types.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
    },
    handler: async (ctx, args) => {
      if (args.cursor && !decodeCursor(args.cursor)) {
        throw new McpToolError(
          'invalid_input',
          'cursor is not valid. Pass the next_cursor returned by the previous call, or omit it.',
          'cursor'
        );
      }
      if (args.since && Number.isNaN(Date.parse(args.since))) {
        throw new McpToolError('invalid_input', 'since must be an ISO date-time.', 'since');
      }
      const page = await listEventsSince(ctx.supabase, ctx.accountId, {
        cursor: args.cursor,
        since: args.since ? new Date(args.since).toISOString() : null,
        types: args.types,
        limit: args.limit ?? 50,
      });
      return { items: page.events, next_cursor: page.next_cursor, has_more: page.has_more };
    },
  }),
];
