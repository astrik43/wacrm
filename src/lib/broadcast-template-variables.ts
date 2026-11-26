/**
 * What a broadcast row keeps in `broadcasts.template_variables`, so a
 * saved draft or a sent broadcast can be test-sent later with the same
 * values the wizard had.
 *
 * Body mappings stay at the top level, keyed "1", "2", … exactly as
 * every broadcast before this stored them. Button values and the
 * header media link sit beside them under keys that can never be a
 * placeholder number:
 *
 *   { "1": { type, value }, "buttons": { "0": { type, value } },
 *     "header_media_url": "https://…" }
 */

import type {
  ButtonVariables,
  VariableMapping,
} from '@/hooks/use-broadcast-sending';

export interface BroadcastTemplateVariables {
  variables: Record<string, VariableMapping>;
  buttonVariables: ButtonVariables;
  headerMediaUrl: string;
}

const MAPPING_TYPES = new Set(['static', 'field', 'custom_field']);

function isMapping(value: unknown): value is VariableMapping {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && MAPPING_TYPES.has(v.type) && typeof v.value === 'string';
}

export function toStoredTemplateVariables({
  variables,
  buttonVariables,
  headerMediaUrl,
}: BroadcastTemplateVariables): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...variables };
  if (Object.keys(buttonVariables).length > 0) stored.buttons = buttonVariables;
  if (headerMediaUrl.trim()) stored.header_media_url = headerMediaUrl.trim();
  return stored;
}

export function fromStoredTemplateVariables(raw: unknown): BroadcastTemplateVariables {
  const out: BroadcastTemplateVariables = {
    variables: {},
    buttonVariables: {},
    headerMediaUrl: '',
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (/^\d+$/.test(key) && isMapping(value)) out.variables[key] = value;
  }
  if (obj.buttons && typeof obj.buttons === 'object') {
    for (const [key, value] of Object.entries(obj.buttons)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && isMapping(value)) {
        out.buttonVariables[index] = value;
      }
    }
  }
  if (typeof obj.header_media_url === 'string') out.headerMediaUrl = obj.header_media_url;
  return out;
}
