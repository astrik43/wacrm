import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { verifyShopifyWebhookSignature } from './signature';

const SECRET = 'shpss_test_secret';
const BODY = Buffer.from('{"id":820982911946154508,"name":"#1042"}');

function sign(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

describe('verifyShopifyWebhookSignature', () => {
  it('accepts a signature made with the store secret', () => {
    expect(verifyShopifyWebhookSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(
      true
    );
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(BODY.toString().replace('#1042', '#1043'));
    expect(
      verifyShopifyWebhookSignature(tampered, sign(BODY, SECRET), SECRET)
    ).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verifyShopifyWebhookSignature(BODY, sign(BODY, 'other'), SECRET)
    ).toBe(false);
  });

  it('fails closed on a missing header or an empty secret', () => {
    expect(verifyShopifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyShopifyWebhookSignature(BODY, '', SECRET)).toBe(false);
    expect(verifyShopifyWebhookSignature(BODY, sign(BODY, ''), '')).toBe(false);
  });

  it('rejects a header that is not a 32-byte digest', () => {
    expect(verifyShopifyWebhookSignature(BODY, 'not-base64!!', SECRET)).toBe(
      false
    );
    expect(
      verifyShopifyWebhookSignature(
        BODY,
        Buffer.from('short').toString('base64'),
        SECRET
      )
    ).toBe(false);
  });
});
