/**
 * Search / filter / sort for the template list in Settings → Templates.
 *
 * Pure so it can be unit-tested; the component only holds the
 * criteria in state and renders the result.
 */

import type { MessageTemplate, MessageTemplateStatus } from '@/types';

export const TEMPLATE_SORTS = [
  'newest',
  'oldest',
  'updated',
  'name_asc',
  'name_desc',
] as const;
export type TemplateSort = (typeof TEMPLATE_SORTS)[number];

/** 'all' disables that filter. */
export interface TemplateCriteria {
  query: string;
  status: MessageTemplateStatus | 'all';
  category: MessageTemplate['category'] | 'all';
  language: string | 'all';
  sort: TemplateSort;
}

export const DEFAULT_TEMPLATE_CRITERIA: TemplateCriteria = {
  query: '',
  status: 'all',
  category: 'all',
  language: 'all',
  sort: 'newest',
};

export function isTemplateSort(value: string): value is TemplateSort {
  return (TEMPLATE_SORTS as readonly string[]).includes(value);
}

/** True when anything other than the sort narrows the list. */
export function hasActiveFilters(c: TemplateCriteria): boolean {
  return (
    c.query.trim() !== '' ||
    c.status !== 'all' ||
    c.category !== 'all' ||
    c.language !== 'all'
  );
}

/** Distinct languages present, sorted, for the language filter. */
export function templateLanguages(templates: MessageTemplate[]): string[] {
  const set = new Set<string>();
  for (const t of templates) if (t.language) set.add(t.language);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function matchesQuery(t: MessageTemplate, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    t.name,
    t.body_text,
    t.header_content,
    t.footer_text,
    ...(t.buttons ?? []).map((b) => b.text),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  // Every word must appear somewhere; "order cod" finds
  // "cod_order_confirmation". Underscores count as spaces so
  // "order placed" finds "order_placed_prepaid".
  const normalized = haystack.replace(/_/g, ' ');
  return terms.every((term) => haystack.includes(term) || normalized.includes(term));
}

function time(value: string | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function filterTemplates(
  templates: MessageTemplate[],
  c: TemplateCriteria
): MessageTemplate[] {
  const terms = c.query.toLowerCase().split(/\s+/).filter(Boolean);

  const out = templates.filter(
    (t) =>
      (c.status === 'all' || (t.status ?? 'DRAFT') === c.status) &&
      (c.category === 'all' || t.category === c.category) &&
      (c.language === 'all' || t.language === c.language) &&
      matchesQuery(t, terms)
  );

  const byName = (a: MessageTemplate, b: MessageTemplate) =>
    a.name.localeCompare(b.name) ||
    (a.language ?? '').localeCompare(b.language ?? '');

  out.sort((a, b) => {
    switch (c.sort) {
      case 'oldest':
        return time(a.created_at) - time(b.created_at) || byName(a, b);
      case 'updated':
        return (
          time(b.updated_at ?? b.created_at) -
            time(a.updated_at ?? a.created_at) || byName(a, b)
        );
      case 'name_asc':
        return byName(a, b);
      case 'name_desc':
        return byName(b, a);
      case 'newest':
      default:
        return time(b.created_at) - time(a.created_at) || byName(a, b);
    }
  });

  return out;
}
