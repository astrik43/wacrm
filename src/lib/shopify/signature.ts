// ============================================================
// Shopify webhook signature verification.
//
// Shopify signs every delivery with HMAC-SHA256 over the raw request
// bytes, keyed by the store's webhook signing secret, and sends the
// digest base64-encoded in `X-Shopify-Hmac-Sha256`. Unlike Meta's
// deployment-wide app secret, this secret is per store, so the caller
// passes the (decrypted) secret of the account the URL token selected.
// ============================================================

import crypto from 'crypto';

/**
 * Timing-safe check of a Shopify HMAC header. Fails closed: a missing
 * header, an empty secret, or a digest of the wrong length is `false`.
 */
export function verifyShopifyWebhookSignature(
  rawBody: Buffer,
  hmacHeader: string | null,
  secret: string
): boolean {
  if (!hmacHeader || !secret) return false;

  const received = Buffer.from(hmacHeader.trim(), 'base64');
  // SHA-256 digests are 32 bytes. Anything else is not a signature
  // (and timingSafeEqual throws on a length mismatch).
  if (received.length !== 32) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(received, expected);
}
