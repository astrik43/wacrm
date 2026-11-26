// MCP 2.0 "broadcasts" tools. See ../CONVENTIONS.md and docs/mcp-2.0-plan.md section 7.
//
// Scheduling is intentionally absent: the app has no scheduler that sends
// `scheduled_at` broadcasts, so a tool for it would never fire.
import type { AnyMcpTool } from '../types';
import { broadcastReadTools } from './broadcasts/read';
import { broadcastSendTools } from './broadcasts/send';

export const broadcastsTools: AnyMcpTool[] = [...broadcastReadTools, ...broadcastSendTools];
