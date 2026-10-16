// ============================================================
// Signed codes for the CRM's own redirect links, /r/<code>.
//
// WhatsApp URL buttons need a fixed address with only the end
// variable, so a template can't point "wherever this shipment is
// tracked". The button instead points at https://<this CRM>/r/{{1}}
// and {{1}} is one of these codes; the route looks the shipment (or
// order) up and redirects to its link as it is NOW. Changing courier
// or tracking partner then needs no template change.
//
// A code names one record and carries an HMAC over (kind, account,
// id), so the route only ever redirects to a link Shopify gave us for
// that record — it is not an open redirect, and ids can't be walked.
//
//   t<fulfillment id>.<sig>   → that shipment's tracking link
//   s<order id>.<sig>         → that order's status page
//   c<checkout key>.<sig>     → that abandoned checkout's cart link
//                               (key base64url-encoded: FlexyPe keys
//                               aren't numeric)
// ============================================================

import crypto from 'crypto';

export type LinkKind = 't' | 's' | 'c';

const SIG_LEN = 16;
const NUMERIC_ID = /^[0-9]{1,24}$/;
/** Longest checkout key a code carries (FlexyPe session ids are short). */
const MAX_CHECKOUT_KEY = 120;
const CODE_RE =
  /^(?:([ts])([0-9]{1,24})|c([A-Za-z0-9_-]{1,160}))\.([A-Za-z0-9_-]{16})$/;

/** Derived from ENCRYPTION_KEY, so no new secret to deploy. */
function signingKey(): Buffer | null {
  const base = process.env.ENCRYPTION_KEY;
  if (!base) return null;
  return crypto.createHash('sha256').update(`wacrm-shopify-link:${base}`).digest();
}

function sign(key: Buffer, kind: LinkKind, accountId: string, id: string): string {
  return crypto
    .createHmac('sha256', key)
    .update(`${kind}:${accountId}:${id}`)
    .digest('base64url')
    .slice(0, SIG_LEN);
}

/** The code for one record, or null when it can't be made. */
export function makeLinkCode(
  kind: LinkKind,
  accountId: string,
  id: string | null | undefined
): string | null {
  const key = signingKey();
  if (!key || !id) return null;
  if (kind === 'c') {
    if (id.length > MAX_CHECKOUT_KEY) return null;
    const encoded = Buffer.from(id, 'utf8').toString('base64url');
    return `c${encoded}.${sign(key, kind, accountId, id)}`;
  }
  if (!NUMERIC_ID.test(id)) return null;
  return `${kind}${id}.${sign(key, kind, accountId, id)}`;
}

export interface ParsedLinkCode {
  kind: LinkKind;
  /** Fulfillment / order id, or the decoded checkout key. */
  id: string;
  sig: string;
}

export function parseLinkCode(code: unknown): ParsedLinkCode | null {
  if (typeof code !== 'string') return null;
  const match = CODE_RE.exec(code);
  if (!match) return null;
  if (match[3] !== undefined) {
    const id = Buffer.from(match[3], 'base64url').toString('utf8');
    // Only a canonical encoding of a sane key — no smuggled bytes.
    if (
      !id ||
      id.length > MAX_CHECKOUT_KEY ||
      Buffer.from(id, 'utf8').toString('base64url') !== match[3]
    ) {
      return null;
    }
    return { kind: 'c', id, sig: match[4] };
  }
  return { kind: match[1] as LinkKind, id: match[2], sig: match[4] };
}

/** Whether `parsed` was issued for this account. */
export function linkCodeMatches(parsed: ParsedLinkCode, accountId: string): boolean {
  const key = signingKey();
  if (!key) return false;
  const expected = Buffer.from(sign(key, parsed.kind, accountId, parsed.id));
  const given = Buffer.from(parsed.sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Only web links are redirected to. */
export function isRedirectableUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
