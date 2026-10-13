// ============================================================
// Which send-time values does a template need?
//
// Shared by the inbox template picker (free-text inputs), the Shopify
// settings panel (field-mapping selects) and the server-side mapping
// validation, so all three agree on the slots a template exposes.
// ============================================================

import type { MessageTemplate } from '@/types';
import { extractVariableIndices } from './template-validators';

export interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

export interface TemplateVariableSlots {
  bodyVars: number[];
  headerVarCount: number;
  urlButtonSlots: UrlButtonSlot[];
}

/**
 * Templates may need values for: body variables, a text-header
 * variable, and per-URL-button suffixes. Collect them all so the
 * send-message path doesn't 400 on missing parameters.
 */
export function collectVariableSlots(
  template: MessageTemplate
): TemplateVariableSlots {
  const bodyVars = extractVariableIndices(template.body_text);
  const headerVarCount =
    template.header_type === 'text' && template.header_content
      ? extractVariableIndices(template.header_content).length
      : 0;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === 'URL' && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyVars, headerVarCount, urlButtonSlots };
}
