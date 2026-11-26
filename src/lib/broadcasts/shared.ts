// ============================================================
// Broadcast logic shared by the dashboard wizard (hooks/use-broadcast-
// sending.ts) and the MCP broadcast tools. Pure: no React, no client,
// no network. Moved here from the hook so both call one copy.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

/**
 * Send-time values for the template's buttons, keyed by the button's
 * index in `template.buttons` (the index Meta expects). Set for URL
 * buttons whose link has a {{1}} suffix and for COPY_CODE buttons.
 */
export type ButtonVariables = Record<number, VariableMapping>;

/** The contact fields a variable mapping can read. */
export interface VariableContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Indices of the buttons that take a value at send time: a URL button
 * with {{1}} in its link, and a COPY_CODE button (its coupon code).
 */
export function buttonsNeedingParams(template: MessageTemplate): number[] {
  const out: number[] = [];
  (template.buttons ?? []).forEach((button, index) => {
    if (
      (button.type === 'URL' && extractVariableIndices(button.url).length > 0) ||
      button.type === 'COPY_CODE'
    ) {
      out.push(index);
    }
  });
  return out;
}

/**
 * Button text of the first button still missing a value, or null when
 * every button that needs one has it. A COPY_CODE button left empty
 * falls back to the template's example code, so it only counts as
 * missing when the template has no example either.
 */
export function missingButtonParam(
  template: MessageTemplate,
  buttonVariables: ButtonVariables,
): string | null {
  for (const index of buttonsNeedingParams(template)) {
    const button = template.buttons![index];
    if (buttonVariables[index]?.value?.trim()) continue;
    if (button.type === 'COPY_CODE' && button.example?.trim()) continue;
    return button.text || `#${index + 1}`;
  }
  return null;
}

/** contactId → (customFieldId → value). */
export type CustomValueIndex = Map<string, Map<string, string>>;

function resolveMapping(
  v: VariableMapping,
  contact: VariableContact,
  customValues?: Map<string, string>,
): string {
  if (v.type === 'static') return v.value;

  if (v.type === 'field') {
    const fieldMap: Record<string, string | null | undefined> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[v.value] ?? '';
  }

  // custom_field
  return customValues?.get(v.value) ?? '';
}

/**
 * Per-contact resolution of body placeholders. Static and built-in-
 * field mappings resolve synchronously; custom fields read from a
 * pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: VariableContact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => resolveMapping(variables[key], contact, customValues));
}

/** Per-contact button values, for the buttons that take one. */
export function resolveButtonParams(
  template: MessageTemplate,
  buttonVariables: ButtonVariables,
  contact: VariableContact,
  customValues?: Map<string, string>,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const index of buttonsNeedingParams(template)) {
    const mapping = buttonVariables[index];
    if (!mapping?.value?.trim()) continue; // COPY_CODE → template example
    out[index] = resolveMapping(mapping, contact, customValues);
  }
  return out;
}

/** The media link to send for a media-header template, if any. */
export function headerMediaUrlFor(
  template: MessageTemplate,
  headerMediaUrl: string | undefined,
): string | undefined {
  const headerType = template.header_type;
  const isMediaHeader =
    headerType === 'image' || headerType === 'video' || headerType === 'document';
  return (isMediaHeader && headerMediaUrl?.trim()) || undefined;
}

/** Bulk-fetch contact_custom_values for a set of contacts. */
export async function fetchCustomValueIndex(
  supabase: SupabaseClient,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // PostgREST caps the .in(...) list roughly at 1000 values. Page
  // through to stay safe.
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of (data ?? []) as {
      contact_id: string;
      custom_field_id: string;
      value: string | null;
    }[]) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

/** True for an absolute http(s) URL, which is what Meta accepts for a media header. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
