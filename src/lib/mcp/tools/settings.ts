// MCP 2.0 — "settings" tools: WhatsApp number/business profile,
// in-app notifications and outgoing webhooks. See ../CONVENTIONS.md.
import type { AnyMcpTool } from '../types';
import { notificationTools } from './settings/notifications';
import { webhookTools } from './settings/webhooks';
import { whatsappSettingsTools } from './settings/whatsapp';

export const settingsTools: AnyMcpTool[] = [
  ...whatsappSettingsTools,
  ...notificationTools,
  ...webhookTools,
];
