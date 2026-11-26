import { z } from 'zod';

import { findByOrderOrAwb } from '@/lib/ops/order-lookup';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';

export const lookupTools = [
  defineTool({
    name: 'find_by_order',
    title: 'Find a customer by order number or AWB',
    description:
      'Look up an order by order number (#EL2204 or EL2204) or an AWB / tracking number. Returns the order number, status, latest fulfilment status, contact_id, conversation_id and whether the contact is staff. Never returns a phone number, name, email or address: pass contact_id / conversation_id to the other tools instead.',
    scope: 'ops:read',
    tier: 'read',
    input: {
      query: z
        .string()
        .min(2)
        .max(60)
        .describe('Order number (#EL2204, EL2204) or AWB / tracking number.'),
    },
    handler: async (ctx, args) => {
      const found = await findByOrderOrAwb(ctx.supabase, ctx.accountId, args.query);
      if (!found) {
        throw new McpToolError(
          'not_found',
          'No order or shipment matches that number. Check the order number or AWB.',
          'query'
        );
      }
      return found;
    },
  }),
];
