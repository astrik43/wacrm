// MCP 2.0 — "inbox" tools. Split by concern under ./inbox/. See ../CONVENTIONS.md.
import type { AnyMcpTool } from '../types';
import { inboxManageTools } from './inbox/manage';
import { inboxReadTools } from './inbox/read';
import { inboxSendTools } from './inbox/send';

export const inboxTools: AnyMcpTool[] = [
  ...inboxReadTools,
  ...inboxManageTools,
  ...inboxSendTools,
];
