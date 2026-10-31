import { describe, expect, it } from 'vitest';

import type { MessageTemplate } from '@/types';
import { readSentTemplatePayload, sentTemplatePayload } from './sent-template';

const ROW = {
  id: 't1',
  user_id: 'u1',
  name: 'order_shipped',
  category: 'Utility',
  header_type: 'image',
  header_media_url: 'https://cdn.example.com/static.jpg',
  body_text: 'Hi {{1}}',
  buttons: [
    { type: 'URL', text: 'Track order', url: 'https://wacrm.app/r/{{1}}' },
    { type: 'URL', text: 'Shop', url: 'https://estelleluxe.in' },
    { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919029130001' },
    { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE10' },
    { type: 'QUICK_REPLY', text: 'Confirm' },
  ],
  created_at: '2026-10-30T00:00:00Z',
} as MessageTemplate;

describe('sentTemplatePayload', () => {
  it('keeps the buttons with links as sent and the header picture', () => {
    expect(
      sentTemplatePayload(ROW, {
        body: ['Asha'],
        headerMediaUrl: 'https://cdn.shopify.com/ring.jpg',
        buttonParams: { 0: 'tAbc.sig', 3: 'WELCOME5' },
      })
    ).toEqual({
      kind: 'template',
      header_type: 'image',
      header_media_url: 'https://cdn.shopify.com/ring.jpg',
      buttons: [
        { type: 'url', text: 'Track order', value: 'https://wacrm.app/r/tAbc.sig' },
        { type: 'url', text: 'Shop', value: 'https://estelleluxe.in' },
        { type: 'phone', text: 'Call us', value: '+919029130001' },
        { type: 'copy_code', text: 'Copy code', value: 'WELCOME5' },
        { type: 'quick_reply', text: 'Confirm' },
      ],
    });
  });

  it("falls back to the template's own picture and code", () => {
    const payload = sentTemplatePayload(ROW, null);
    expect(payload?.header_media_url).toBe('https://cdn.example.com/static.jpg');
    expect(payload?.buttons[3]).toEqual({
      type: 'copy_code',
      text: 'Copy code',
      value: 'SAVE10',
    });
  });

  it('is null with no template row, or nothing beyond the body', () => {
    expect(sentTemplatePayload(null, {})).toBeNull();
    expect(
      sentTemplatePayload({ ...ROW, header_type: undefined, buttons: [] }, {})
    ).toBeNull();
  });

  it('reads back only template payloads', () => {
    const payload = sentTemplatePayload(ROW, null);
    expect(readSentTemplatePayload(payload)).toEqual(payload);
    expect(readSentTemplatePayload({ kind: 'buttons', body: 'x', buttons: [] })).toBeNull();
    expect(readSentTemplatePayload(null)).toBeNull();
  });
});
