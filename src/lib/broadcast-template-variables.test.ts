import { describe, expect, it } from 'vitest';

import {
  fromStoredTemplateVariables,
  toStoredTemplateVariables,
} from './broadcast-template-variables';

describe('broadcast template variables', () => {
  it('round-trips body, button and header values through JSONB', () => {
    const saved = {
      variables: { '1': { type: 'field' as const, value: 'name' } },
      buttonVariables: {
        0: { type: 'static' as const, value: 'family-offer' },
        1: { type: 'static' as const, value: 'ESTELLE100' },
      },
      headerMediaUrl: 'https://cdn.example.com/offer.mp4',
    };
    const stored = JSON.parse(JSON.stringify(toStoredTemplateVariables(saved)));
    expect(stored).toEqual({
      '1': { type: 'field', value: 'name' },
      buttons: {
        '0': { type: 'static', value: 'family-offer' },
        '1': { type: 'static', value: 'ESTELLE100' },
      },
      header_media_url: 'https://cdn.example.com/offer.mp4',
    });
    expect(fromStoredTemplateVariables(stored)).toEqual(saved);
  });

  it('keeps the old body-only shape unchanged', () => {
    const variables = { '1': { type: 'static' as const, value: 'Diwali' } };
    expect(
      toStoredTemplateVariables({ variables, buttonVariables: {}, headerMediaUrl: ' ' })
    ).toEqual(variables);
    expect(fromStoredTemplateVariables(variables)).toEqual({
      variables,
      buttonVariables: {},
      headerMediaUrl: '',
    });
  });

  it('ignores junk', () => {
    const empty = { variables: {}, buttonVariables: {}, headerMediaUrl: '' };
    expect(fromStoredTemplateVariables(null)).toEqual(empty);
    expect(fromStoredTemplateVariables(['x'])).toEqual(empty);
    expect(
      fromStoredTemplateVariables({
        '1': { type: 'weird', value: 'x' },
        name: { type: 'static', value: 'x' },
        buttons: { a: { type: 'static', value: 'x' }, 0: 'not-a-mapping' },
      })
    ).toEqual(empty);
  });
});
