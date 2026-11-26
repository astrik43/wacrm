// ============================================================
// Broadcast send helpers shared by the MCP tools: the exact Meta
// payload for a template send (for dry runs), the cost estimate, and
// the per-recipient parameter resolution the wizard does at send time.
// ============================================================

import { GST_RATE, INR_RATES } from '@/lib/billing/charges';
import {
  headerMediaUrlFor,
  resolveButtonParams,
  resolveVariables,
  type ButtonVariables,
  type VariableContact,
  type VariableMapping,
} from '@/lib/broadcasts/shared';
import {
  parseRecipientParams,
  toStoredRecipientParams,
} from '@/lib/whatsapp/recipient-params';
import {
  buildSendComponents,
  type SendTimeParams,
} from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';

/** Recipients per broadcast call, the same cap as the public API and resume. */
export const BROADCAST_MAX_RECIPIENTS = 1000;

/**
 * The values frozen on one recipient row (template_params), resolved
 * exactly as the wizard does: body placeholders, button values, header
 * media link.
 */
export function recipientTemplateParams(args: {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  buttonVariables: ButtonVariables;
  headerMediaUrl?: string;
  contact: VariableContact;
  customValues?: Map<string, string>;
}): string[] | { body: string[]; buttonParams?: Record<number, string>; headerMediaUrl?: string } {
  const { template, variables, buttonVariables, contact, customValues } = args;
  return toStoredRecipientParams({
    body: resolveVariables(variables, contact, customValues),
    buttonParams: resolveButtonParams(template, buttonVariables, contact, customValues),
    headerMediaUrl: headerMediaUrlFor(template, args.headerMediaUrl),
  });
}

/**
 * The request body POSTed to Meta for one template send: the same
 * shape meta-api.sendTemplateMessage builds. The recipient number is
 * replaced so a dry run never echoes a phone number.
 *
 * Throws when the template cannot be built (a media header with no
 * link, a missing body value), exactly where a real send would fail.
 */
export function buildTemplateSendPayload(args: {
  template: MessageTemplate;
  templateName: string;
  language: string;
  stored: unknown;
}): Record<string, unknown> {
  const { params, messageParams } = parseRecipientParams(args.stored);
  const send: SendTimeParams = {
    body: messageParams?.body ?? params,
    headerText: messageParams?.headerText,
    headerMediaUrl: messageParams?.headerMediaUrl,
    headerMediaId: messageParams?.headerMediaId,
    buttonParams: messageParams?.buttonParams,
  };
  const components = buildSendComponents(args.template, send);
  const template: Record<string, unknown> = {
    name: args.templateName,
    language: { code: args.language },
  };
  if (components.length > 0) template.components = components;
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '<recipient phone, not shown>',
    type: 'template',
    template,
  };
}

export interface CostEstimate {
  category: string;
  recipients: number;
  per_message_inr: number;
  total_inr: number;
  total_with_gst_inr: number;
  basis: string;
}

/**
 * Estimated Meta charge for a broadcast, from the same India rate card
 * the Transaction Details page uses (billing/charges). An estimate:
 * Meta bills in its own currency and WhatsApp Manager is authoritative.
 * Null when the template category has no known rate.
 */
export function estimateBroadcastCost(
  category: string | undefined | null,
  recipients: number,
): CostEstimate | null {
  const key = (category ?? '').toLowerCase();
  const rate = INR_RATES[key];
  if (rate === undefined) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  const total = rate * recipients;
  return {
    category: key,
    recipients,
    per_message_inr: rate,
    total_inr: round(total),
    total_with_gst_inr: round(total * (1 + GST_RATE)),
    basis:
      'Estimate from the India rate card, charged per delivered message. WhatsApp Manager has the official totals.',
  };
}
