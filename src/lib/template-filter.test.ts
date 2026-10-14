import { describe, expect, it } from 'vitest';

import type { MessageTemplate } from '@/types';

import {
  DEFAULT_TEMPLATE_CRITERIA,
  filterTemplates,
  hasActiveFilters,
  isTemplateSort,
  templateLanguages,
  type TemplateCriteria,
} from './template-filter';

function tpl(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: over.name ?? 'id',
    user_id: 'u',
    name: 'name',
    category: 'Utility',
    language: 'en',
    body_text: '',
    status: 'APPROVED',
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const templates = [
  tpl({
    name: 'order_placed_prepaid',
    body_text: 'Your order {{2}} is placed',
    created_at: '2026-10-03T00:00:00Z',
    updated_at: '2026-10-03T00:00:00Z',
  }),
  tpl({
    name: 'cod_order_confirmation',
    category: 'Marketing',
    body_text: 'Please confirm your COD order',
    buttons: [{ type: 'URL', text: 'Confirm COD', url: 'https://x/{{1}}' }],
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-05T00:00:00Z',
  }),
  tpl({
    name: 'abandoned_cart',
    category: 'Marketing',
    language: 'en_US',
    status: 'REJECTED',
    footer_text: 'Reply STOP to opt out',
    created_at: '2026-10-02T00:00:00Z',
  }),
  tpl({
    name: 'draft_one',
    status: undefined,
    created_at: '2026-10-04T00:00:00Z',
  }),
];

const run = (c: Partial<TemplateCriteria>) =>
  filterTemplates(templates, { ...DEFAULT_TEMPLATE_CRITERIA, ...c }).map(
    (t) => t.name
  );

describe('filterTemplates', () => {
  it('defaults to every template, newest first', () => {
    expect(run({})).toEqual([
      'draft_one',
      'order_placed_prepaid',
      'abandoned_cart',
      'cod_order_confirmation',
    ]);
  });

  it('searches name, body, footer and button text, case-insensitively', () => {
    expect(run({ query: 'COD' })).toEqual(['cod_order_confirmation']);
    expect(run({ query: 'stop' })).toEqual(['abandoned_cart']);
    expect(run({ query: 'confirm cod' })).toEqual(['cod_order_confirmation']);
  });

  it('treats underscores in names as spaces', () => {
    expect(run({ query: 'order placed' })).toEqual(['order_placed_prepaid']);
    expect(run({ query: 'order_placed' })).toEqual(['order_placed_prepaid']);
  });

  it('requires every search word to match', () => {
    expect(run({ query: 'order nothing-like-this' })).toEqual([]);
  });

  it('filters by status, treating a missing status as DRAFT', () => {
    expect(run({ status: 'REJECTED' })).toEqual(['abandoned_cart']);
    expect(run({ status: 'DRAFT' })).toEqual(['draft_one']);
  });

  it('filters by category and language, combined with search', () => {
    expect(run({ category: 'Marketing' })).toEqual([
      'abandoned_cart',
      'cod_order_confirmation',
    ]);
    expect(run({ language: 'en_US' })).toEqual(['abandoned_cart']);
    expect(run({ category: 'Marketing', query: 'cod' })).toEqual([
      'cod_order_confirmation',
    ]);
  });

  it('sorts by age, last update and name', () => {
    expect(run({ sort: 'oldest' })[0]).toBe('cod_order_confirmation');
    // Missing updated_at falls back to created_at.
    expect(run({ sort: 'updated' })).toEqual([
      'cod_order_confirmation',
      'draft_one',
      'order_placed_prepaid',
      'abandoned_cart',
    ]);
    expect(run({ sort: 'name_asc' })).toEqual([
      'abandoned_cart',
      'cod_order_confirmation',
      'draft_one',
      'order_placed_prepaid',
    ]);
    expect(run({ sort: 'name_desc' })[0]).toBe('order_placed_prepaid');
  });

  it('does not reorder the input array', () => {
    const before = templates.map((t) => t.name);
    run({ sort: 'name_asc' });
    expect(templates.map((t) => t.name)).toEqual(before);
  });
});

describe('helpers', () => {
  it('lists distinct languages, sorted', () => {
    expect(templateLanguages(templates)).toEqual(['en', 'en_US']);
  });

  it('knows when a filter narrows the list (sort alone does not)', () => {
    expect(hasActiveFilters(DEFAULT_TEMPLATE_CRITERIA)).toBe(false);
    expect(
      hasActiveFilters({ ...DEFAULT_TEMPLATE_CRITERIA, sort: 'name_asc' })
    ).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_TEMPLATE_CRITERIA, query: ' x ' })).toBe(
      true
    );
    expect(
      hasActiveFilters({ ...DEFAULT_TEMPLATE_CRITERIA, status: 'PENDING' })
    ).toBe(true);
  });

  it('validates sort values', () => {
    expect(isTemplateSort('name_asc')).toBe(true);
    expect(isTemplateSort('random')).toBe(false);
  });
});
