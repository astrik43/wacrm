import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageTemplate } from '@/types';
import { sendTemplateMessage } from './meta-api';
import {
  parseRecipientParams,
  toStoredRecipientParams,
} from './recipient-params';

// The "Estelle family offer" shape: VIDEO header, body {{1}} = name,
// a URL button with a {{1}} suffix, then a COPY_CODE button.
const FAMILY_OFFER: MessageTemplate = {
  id: 't-1',
  user_id: 'u-1',
  name: 'estelle_family_offer',
  category: 'Marketing',
  language: 'en',
  header_type: 'video',
  header_media_url: 'https://cdn.example.com/approved.mp4',
  body_text: 'Hi {{1}}, a family offer just for you.',
  buttons: [
    { type: 'URL', text: 'Shop Now', url: 'https://estelleluxe.in/{{1}}' },
    { type: 'COPY_CODE', text: 'Copy offer code', example: 'ESTELLE100' },
  ],
  created_at: '2026-11-01T00:00:00Z',
};

describe('toStoredRecipientParams', () => {
  it('keeps the plain array when only body values are needed', () => {
    expect(toStoredRecipientParams({ body: ['Priya'], buttonParams: {} })).toEqual([
      'Priya',
    ]);
  });

  it('stores button values and the header link alongside the body', () => {
    expect(
      toStoredRecipientParams({
        body: ['Priya'],
        buttonParams: { 0: 'family-offer' },
        headerMediaUrl: 'https://cdn.example.com/offer.mp4',
      })
    ).toEqual({
      body: ['Priya'],
      buttonParams: { 0: 'family-offer' },
      headerMediaUrl: 'https://cdn.example.com/offer.mp4',
    });
  });
});

describe('parseRecipientParams', () => {
  it('reads the old array shape as body values', () => {
    expect(parseRecipientParams(['A', 2, 'B'])).toEqual({ params: ['A', 'B'] });
  });

  it('treats null or junk as no params', () => {
    expect(parseRecipientParams(null)).toEqual({ params: [] });
    expect(parseRecipientParams('nope')).toEqual({ params: [] });
  });

  it('reads the structured shape after a JSONB round trip (string keys)', () => {
    const stored = JSON.parse(
      JSON.stringify({
        body: ['Priya'],
        buttonParams: { 0: 'family-offer', 1: 'ESTELLE100', x: 'junk', 2: 5 },
        headerMediaUrl: 'https://cdn.example.com/offer.mp4',
      })
    );
    expect(parseRecipientParams(stored)).toEqual({
      params: ['Priya'],
      messageParams: {
        body: ['Priya'],
        buttonParams: { 0: 'family-offer', 1: 'ESTELLE100' },
        headerMediaUrl: 'https://cdn.example.com/offer.mp4',
      },
    });
  });
});

describe('a stored row sends the full Meta payload', () => {
  let captured: Record<string, unknown> | null = null;
  beforeEach(() => {
    captured = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }));
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('video header, body, URL button at index 0, coupon code at index 1', async () => {
    const stored = JSON.parse(
      JSON.stringify(
        toStoredRecipientParams({
          body: ['Priya'],
          buttonParams: { 0: 'family-offer', 1: 'ESTELLE100' },
          headerMediaUrl: 'https://cdn.example.com/offer.mp4',
        })
      )
    );
    const { params, messageParams } = parseRecipientParams(stored);

    await sendTemplateMessage({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      to: '919876543210',
      templateName: FAMILY_OFFER.name,
      language: 'en',
      template: FAMILY_OFFER,
      params,
      messageParams,
    });

    expect(captured).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'estelle_family_offer',
        language: { code: 'en' },
        components: [
          {
            type: 'header',
            parameters: [
              { type: 'video', video: { link: 'https://cdn.example.com/offer.mp4' } },
            ],
          },
          { type: 'body', parameters: [{ type: 'text', text: 'Priya' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'family-offer' }],
          },
          {
            type: 'button',
            sub_type: 'copy_code',
            index: '1',
            parameters: [{ type: 'coupon_code', coupon_code: 'ESTELLE100' }],
          },
        ],
      },
    });
  });

  it('falls back to the template example code when no coupon is stored', async () => {
    const { params, messageParams } = parseRecipientParams({
      body: ['Priya'],
      buttonParams: { 0: 'family-offer' },
    });
    await sendTemplateMessage({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      to: '919876543210',
      templateName: FAMILY_OFFER.name,
      template: FAMILY_OFFER,
      params,
      messageParams,
    });
    const components = (captured!.template as { components: unknown[] }).components;
    expect(components[3]).toEqual({
      type: 'button',
      sub_type: 'copy_code',
      index: '1',
      parameters: [{ type: 'coupon_code', coupon_code: 'ESTELLE100' }],
    });
  });
});
