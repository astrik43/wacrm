import { describe, expect, it } from 'vitest';

import {
  SETTINGS_SECTIONS,
  canSeeSection,
  resolveSection,
} from './settings-sections';

const MEMBER_SECTIONS = ['overview', 'profile', 'security', 'appearance', 'quick-replies'];

describe('settings sections by role', () => {
  it('shows agents and viewers only their own settings and quick replies', () => {
    expect(SETTINGS_SECTIONS.filter((s) => canSeeSection(s, false))).toEqual(MEMBER_SECTIONS);
  });

  it('shows admins every section', () => {
    expect(SETTINGS_SECTIONS.filter((s) => canSeeSection(s, true))).toEqual([
      ...SETTINGS_SECTIONS,
    ]);
  });

  it('sends a non-admin deep link to workspace configuration back to the overview', () => {
    for (const tab of ['whatsapp', 'shopify', 'flexype', 'shiprocket', 'members', 'api', 'templates', 'deals', 'fields', 'tags']) {
      expect(resolveSection(tab, false)).toBe('overview');
    }
    expect(resolveSection('quick-replies', false)).toBe('quick-replies');
    expect(resolveSection('shopify', true)).toBe('shopify');
    expect(resolveSection('tags', true)).toBe('fields');
  });
});
