import { describe, expect, it } from 'vitest';

import { normalizeShopifyPhone, pickOrderPhone } from './phone';

describe('normalizeShopifyPhone', () => {
  it('keeps numbers already in international format', () => {
    expect(normalizeShopifyPhone('+91 98765 43210', null)).toBe('919876543210');
    expect(normalizeShopifyPhone('0091 98765-43210', null)).toBe('919876543210');
    expect(normalizeShopifyPhone('+1 (415) 555-0123', '91')).toBe('14155550123');
  });

  it('completes a local number with the default country code', () => {
    expect(normalizeShopifyPhone('98765 43210', '91')).toBe('919876543210');
    expect(normalizeShopifyPhone('098765 43210', '91')).toBe('919876543210');
  });

  it('does not double-prefix a number typed with the code but no plus', () => {
    expect(normalizeShopifyPhone('919876543210', '91')).toBe('919876543210');
  });

  it('drops a local number when there is no default country code', () => {
    expect(normalizeShopifyPhone('9876543210', null)).toBeNull();
    expect(normalizeShopifyPhone('9876543210', '')).toBeNull();
  });

  it('drops junk', () => {
    expect(normalizeShopifyPhone('', '91')).toBeNull();
    expect(normalizeShopifyPhone('   ', '91')).toBeNull();
    expect(normalizeShopifyPhone('555-555-SHIP', null)).toBeNull();
    expect(normalizeShopifyPhone('12', '91')).toBeNull();
    expect(normalizeShopifyPhone(null, '91')).toBeNull();
    expect(normalizeShopifyPhone(undefined, '91')).toBeNull();
    expect(normalizeShopifyPhone('+1234567890123456', null)).toBeNull();
  });
});

describe('pickOrderPhone', () => {
  it('takes the first usable candidate in priority order', () => {
    expect(
      pickOrderPhone([null, 'n/a', '+91 98765 43210', '+14155550123'], null)
    ).toBe('919876543210');
  });

  it('returns null when nothing is usable', () => {
    expect(pickOrderPhone([null, undefined, ''], '91')).toBeNull();
    expect(pickOrderPhone([], '91')).toBeNull();
  });
});
