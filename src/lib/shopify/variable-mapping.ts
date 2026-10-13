// ============================================================
// Template variable mapping for Shopify events.
//
// An admin maps each placeholder of a template (body {{n}}, a text
// header variable, URL-button suffixes) to an order detail or a fixed
// string. The mapping is stored as jsonb on shopify_event_templates
// and resolved into `SendTimeParams` at send time. Pure, so the same
// validation runs in the settings UI and on the server.
// ============================================================

import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { collectVariableSlots } from '@/lib/whatsapp/template-variable-slots';
import type { ShopifyEvent } from './events';
import {
  fieldAppliesToEvent,
  isImageField,
  isShopifyFieldKey,
  sanitizeTemplateValue,
  type ShopifyFieldKey,
  type ShopifyFields,
} from './order-fields';

export type VariableSource =
  | { type: 'field'; value: ShopifyFieldKey; fallback?: string }
  | { type: 'static'; value: string };

export interface ShopifyVariableMapping {
  /** Index i fills body `{{i+1}}`. */
  body: VariableSource[];
  headerText?: VariableSource;
  /** Keyed by the button's index in the template (a string after jsonb). */
  buttonParams?: Record<string, VariableSource>;
  /**
   * Picture for an IMAGE header. Unset = the image saved with the
   * template. Only image fields (the ordered product's picture) are
   * accepted.
   */
  headerImage?: VariableSource;
}

export const EMPTY_MAPPING: ShopifyVariableMapping = { body: [] };

function parseSource(raw: unknown): VariableSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as { type?: unknown; value?: unknown; fallback?: unknown };
  if (src.type === 'static' && typeof src.value === 'string') {
    return { type: 'static', value: src.value };
  }
  if (src.type === 'field' && isShopifyFieldKey(src.value)) {
    return typeof src.fallback === 'string' && src.fallback.trim()
      ? { type: 'field', value: src.value, fallback: src.fallback }
      : { type: 'field', value: src.value };
  }
  return null;
}

/**
 * Coerce untrusted input (a request body, a jsonb column) into a
 * mapping. Returns `null` when the shape is wrong. Unset body slots
 * are kept as holes so indices stay aligned; `validateVariableMapping`
 * reports them.
 */
export function parseVariableMapping(
  raw: unknown
): ShopifyVariableMapping | null {
  if (raw === null || raw === undefined) return { body: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as {
    body?: unknown;
    headerText?: unknown;
    buttonParams?: unknown;
    headerImage?: unknown;
  };

  const mapping: ShopifyVariableMapping = { body: [] };

  if (input.body !== undefined) {
    if (!Array.isArray(input.body)) return null;
    input.body.forEach((entry, i) => {
      const parsed = parseSource(entry);
      if (parsed) mapping.body[i] = parsed;
    });
  }

  if (input.headerText !== undefined && input.headerText !== null) {
    const parsed = parseSource(input.headerText);
    if (!parsed) return null;
    mapping.headerText = parsed;
  }

  if (input.buttonParams !== undefined && input.buttonParams !== null) {
    if (typeof input.buttonParams !== 'object' || Array.isArray(input.buttonParams))
      return null;
    const buttons: Record<string, VariableSource> = {};
    for (const [key, entry] of Object.entries(input.buttonParams)) {
      const parsed = parseSource(entry);
      if (!parsed) return null;
      buttons[key] = parsed;
    }
    mapping.buttonParams = buttons;
  }

  if (input.headerImage !== undefined && input.headerImage !== null) {
    const parsed = parseSource(input.headerImage);
    if (!parsed || parsed.type !== 'field' || !isImageField(parsed.value)) {
      return null;
    }
    mapping.headerImage = { type: 'field', value: parsed.value };
  }

  return mapping;
}

/** Does this template take a picture in its header? */
export function templateHasImageHeader(template: MessageTemplate): boolean {
  return template.header_type === 'image';
}

/** A template's placeholders, as stable slot ids ("body_1", "header", "button_0"). */
export function templateSlotIds(template: MessageTemplate): string[] {
  const slots = collectVariableSlots(template);
  const bodyCount = slots.bodyVars.length ? Math.max(...slots.bodyVars) : 0;
  const ids: string[] = [];
  if (slots.headerVarCount > 0) ids.push('header');
  for (let i = 1; i <= bodyCount; i++) ids.push(`body_${i}`);
  for (const b of slots.urlButtonSlots) ids.push(`button_${b.index}`);
  return ids;
}

function sourceFor(
  mapping: ShopifyVariableMapping,
  slotId: string
): VariableSource | undefined {
  if (slotId === 'header') return mapping.headerText;
  if (slotId.startsWith('body_')) {
    return mapping.body[Number(slotId.slice('body_'.length)) - 1];
  }
  return mapping.buttonParams?.[slotId.slice('button_'.length)];
}

/**
 * Problems that would stop every send for this event, as slot-tagged
 * codes (`unmapped:body_2`, `empty:header`, `not_applicable:button_0`).
 * Empty array = the mapping can be saved and enabled.
 */
export function validateVariableMapping(
  template: MessageTemplate,
  mapping: ShopifyVariableMapping,
  event: ShopifyEvent
): string[] {
  const problems: string[] = [];
  for (const slotId of templateSlotIds(template)) {
    const source = sourceFor(mapping, slotId);
    if (!source) {
      problems.push(`unmapped:${slotId}`);
    } else if (source.type === 'static') {
      if (!sanitizeTemplateValue(source.value)) problems.push(`empty:${slotId}`);
    } else if (
      !fieldAppliesToEvent(source.value, event) ||
      // A picture link is not text a customer should read.
      isImageField(source.value)
    ) {
      problems.push(`not_applicable:${slotId}`);
    }
  }
  if (mapping.headerImage && !templateHasImageHeader(template)) {
    problems.push('not_applicable:header_image');
  }
  return problems;
}

function resolveSource(
  source: VariableSource | undefined,
  fields: ShopifyFields
): string {
  if (!source) return '';
  if (source.type === 'static') return sanitizeTemplateValue(source.value);
  return (
    sanitizeTemplateValue(fields[source.value]) ||
    sanitizeTemplateValue(source.fallback)
  );
}

export type ResolvedSendParams =
  | { ok: true; params: SendTimeParams }
  | { ok: false; missing: string };

/**
 * Fill a template's placeholders for one order. Fails with the first
 * slot that has no value: WhatsApp rejects a template with an empty
 * parameter, so the caller skips the send and logs which slot it was.
 */
export function resolveSendParams(
  template: MessageTemplate,
  mapping: ShopifyVariableMapping,
  fields: ShopifyFields
): ResolvedSendParams {
  const params: SendTimeParams = { body: [] };
  const buttonParams: Record<number, string> = {};

  for (const slotId of templateSlotIds(template)) {
    const source = sourceFor(mapping, slotId);
    const value = resolveSource(source, fields);
    if (!value) {
      const what =
        source?.type === 'field' ? `${slotId}:${source.value}` : slotId;
      return { ok: false, missing: what };
    }
    if (slotId === 'header') params.headerText = value;
    else if (slotId.startsWith('body_')) params.body!.push(value);
    else buttonParams[Number(slotId.slice('button_'.length))] = value;
  }

  if (Object.keys(buttonParams).length > 0) params.buttonParams = buttonParams;

  if (templateHasImageHeader(template)) {
    const mapped =
      mapping.headerImage?.type === 'field'
        ? (fields[mapping.headerImage.value] ?? '').trim()
        : '';
    if (mapped) {
      params.headerMediaUrl = mapped;
    } else if (!template.header_media_url) {
      // No product picture for this order and nothing saved with the
      // template: Meta would reject the send, so report it as a skip.
      return { ok: false, missing: 'header_image' };
    }
  }

  return { ok: true, params };
}
