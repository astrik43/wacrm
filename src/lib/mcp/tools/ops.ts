// MCP 2.0 — "ops" tools: order/AWB lookup, staff contacts and document
// sends, the NDR flow, the agent event feed and the ERP tag sync.
// wacrm never calls the ERP; the agent bridges (see docs/mcp-2.0-plan.md §17).
import type { AnyMcpTool } from '../types';
import { eventTools } from './ops/events';
import { lookupTools } from './ops/lookup';
import { ndrTools } from './ops/ndr';
import { staffTools } from './ops/staff';
import { tagSyncTools } from './ops/tag-sync';

export const opsTools: AnyMcpTool[] = [
  ...lookupTools,
  ...staffTools,
  ...ndrTools,
  ...eventTools,
  ...tagSyncTools,
];
