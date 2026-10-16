import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isRedirectableUrl,
  linkCodeMatches,
  makeLinkCode,
  parseLinkCode,
} from './link-codes';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('link codes', () => {
  it('round-trips a code for the account it was made for', () => {
    const code = makeLinkCode('t', 'acct-1', '7296329941302');
    expect(code).toMatch(/^t7296329941302\.[A-Za-z0-9_-]{16}$/);
    const parsed = parseLinkCode(code);
    expect(parsed).toMatchObject({ kind: 't', id: '7296329941302' });
    expect(linkCodeMatches(parsed!, 'acct-1')).toBe(true);
  });

  it('rejects another account, another kind, a changed id or signature', () => {
    const code = makeLinkCode('t', 'acct-1', '1001')!;
    expect(linkCodeMatches(parseLinkCode(code)!, 'acct-2')).toBe(false);

    const asOrder = parseLinkCode(`s${code.slice(1)}`)!;
    expect(linkCodeMatches(asOrder, 'acct-1')).toBe(false);

    const walked = parseLinkCode(code.replace('1001', '1002'))!;
    expect(linkCodeMatches(walked, 'acct-1')).toBe(false);

    const sig = code.split('.')[1];
    const forged = parseLinkCode(`t1001.${sig.slice(0, 15)}${sig[15] === 'A' ? 'B' : 'A'}`)!;
    expect(linkCodeMatches(forged, 'acct-1')).toBe(false);
  });

  it('carries a non-numeric checkout key, signed like the others', () => {
    const code = makeLinkCode('c', 'acct-1', 'flexype:sess_9f8e-7d6c')!;
    expect(code).toMatch(/^c[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16}$/);
    const parsed = parseLinkCode(code)!;
    expect(parsed).toMatchObject({ kind: 'c', id: 'flexype:sess_9f8e-7d6c' });
    expect(linkCodeMatches(parsed, 'acct-1')).toBe(true);
    expect(linkCodeMatches(parsed, 'acct-2')).toBe(false);

    // Another checkout's key under the same signature doesn't verify.
    const sig = code.split('.')[1];
    const other = Buffer.from('flexype:other').toString('base64url');
    expect(linkCodeMatches(parseLinkCode(`c${other}.${sig}`)!, 'acct-1')).toBe(false);
    // Nor does a shipment code reread as a cart.
    const ship = makeLinkCode('t', 'acct-1', '1001')!;
    expect(parseLinkCode(`c${ship.slice(1)}`)).toBeNull();
    expect(makeLinkCode('c', 'acct-1', 'x'.repeat(121))).toBeNull();
  });

  it('only parses well-formed codes', () => {
    for (const bad of [
      null,
      '',
      't1001',
      'x1001.AAAAAAAAAAAAAAAA',
      't10a1.AAAAAAAAAAAAAAAA',
      't1001.short',
      '../etc/passwd',
    ]) {
      expect(parseLinkCode(bad)).toBeNull();
    }
  });

  it('makes no code for a missing or non-numeric id, or without a key', () => {
    expect(makeLinkCode('s', 'acct-1', null)).toBeNull();
    expect(makeLinkCode('s', 'acct-1', 'gid://shopify/Order/1')).toBeNull();
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(makeLinkCode('s', 'acct-1', '1001')).toBeNull();
  });

  it('only redirects to web links', () => {
    expect(isRedirectableUrl('https://www.ithinklogistics.com/track?x=1')).toBe(true);
    expect(isRedirectableUrl('http://track.example.com')).toBe(true);
    expect(isRedirectableUrl('javascript:alert(1)')).toBe(false);
    expect(isRedirectableUrl('7D139859784')).toBe(false);
    expect(isRedirectableUrl(null)).toBe(false);
  });
});
