// ============================================================
// Pick a WhatsApp-able phone number out of a Shopify payload.
//
// Shopify normalises `order.phone` / `customer.phone` to E.164, but
// address phones are whatever the buyer typed ("098765 43210"). The
// repo has no libphonenumber, so local-format numbers are completed
// with the store's default country calling code. A number we can't
// place in a country is dropped rather than guessed — sending an
// order update to the wrong person is worse than not sending it.
// ============================================================

import { isValidE164 } from '@/lib/whatsapp/phone-utils';

/**
 * Normalise one raw phone string to digits-only international format
 * (what Meta expects), or `null` when it can't be trusted.
 */
export function normalizeShopifyPhone(
  raw: string | null | undefined,
  defaultCountryCode: string | null
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  let international = trimmed.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }

  if (!international) {
    const cc = (defaultCountryCode ?? '').replace(/\D/g, '');
    // Local format and no country to put it in — can't be routed.
    if (!cc) return null;
    digits = digits.replace(/^0+/, '');
    // "919876543210" typed without a plus: already carries the code.
    const alreadyPrefixed = digits.startsWith(cc) && digits.length > 10;
    if (!alreadyPrefixed) digits = cc + digits;
  }

  return isValidE164(digits) ? digits : null;
}

/** First candidate that normalises to a usable number, in priority order. */
export function pickOrderPhone(
  candidates: (string | null | undefined)[],
  defaultCountryCode: string | null
): string | null {
  for (const candidate of candidates) {
    const phone = normalizeShopifyPhone(candidate, defaultCountryCode);
    if (phone) return phone;
  }
  return null;
}
