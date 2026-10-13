import { describe, expect, it } from 'vitest';

import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';
import {
  parseVariableMapping,
  resolveSendParams,
  templateSlotIds,
  validateVariableMapping,
} from './variable-mapping';

const TEMPLATE: MessageTemplate = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_shipped',
  category: 'Utility',
  language: 'en',
  header_type: 'text',
  header_content: 'Order {{1}}',
  body_text: 'Hi {{1}}, your parcel is with {{2}}.',
  buttons: [
    { type: 'URL', text: 'Track', url: 'https://shop.example.com/{{1}}' },
  ],
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
};

const FULL = {
  headerText: { type: 'field', value: 'order_number' },
  body: [
    { type: 'field', value: 'customer_first_name', fallback: 'there' },
    { type: 'field', value: 'tracking_company' },
  ],
  buttonParams: { '0': { type: 'field', value: 'order_status_url_path' } },
};

describe('templateSlotIds', () => {
  it('lists header, body and URL-button placeholders', () => {
    expect(templateSlotIds(TEMPLATE)).toEqual([
      'header',
      'body_1',
      'body_2',
      'button_0',
    ]);
  });
});

describe('parseVariableMapping', () => {
  it('accepts a well-formed mapping and treats nothing as empty', () => {
    expect(parseVariableMapping(FULL)).toEqual(FULL);
    expect(parseVariableMapping(null)).toEqual({ body: [] });
    expect(parseVariableMapping({})).toEqual({ body: [] });
  });

  it('rejects wrong shapes and unknown fields', () => {
    expect(parseVariableMapping('nope')).toBeNull();
    expect(parseVariableMapping({ body: 'x' })).toBeNull();
    expect(
      parseVariableMapping({ headerText: { type: 'field', value: 'ssn' } })
    ).toBeNull();
    expect(
      parseVariableMapping({ buttonParams: { '0': { type: 'static' } } })
    ).toBeNull();
  });
});

describe('validateVariableMapping', () => {
  it('passes a complete mapping', () => {
    const mapping = parseVariableMapping(FULL)!;
    expect(validateVariableMapping(TEMPLATE, mapping, 'tracking_added')).toEqual(
      []
    );
  });

  it('reports unmapped, empty and not-applicable slots', () => {
    const mapping = parseVariableMapping({
      body: [{ type: 'static', value: '   ' }],
      buttonParams: { '0': { type: 'field', value: 'tracking_number' } },
    })!;
    expect(validateVariableMapping(TEMPLATE, mapping, 'order_created')).toEqual([
      'unmapped:header',
      'empty:body_1',
      'unmapped:body_2',
      'not_applicable:button_0',
    ]);
  });
});

describe('resolveSendParams', () => {
  const fields = {
    order_number: '#1042',
    tracking_company: 'BlueDart',
    order_status_url_path: 'orders/abc?key=xyz',
  };

  it('fills every slot, using the fallback for a missing field', () => {
    const mapping = parseVariableMapping(FULL)!;
    const resolved = resolveSendParams(TEMPLATE, mapping, fields);
    expect(resolved).toEqual({
      ok: true,
      params: {
        headerText: '#1042',
        body: ['there', 'BlueDart'],
        buttonParams: { 0: 'orders/abc?key=xyz' },
      },
    });
  });

  it('survives a jsonb round trip into the Meta component builder', () => {
    // jsonb turns numeric button keys into strings; the builder reads
    // them back by numeric index.
    const mapping = parseVariableMapping(JSON.parse(JSON.stringify(FULL)))!;
    const resolved = resolveSendParams(TEMPLATE, mapping, fields);
    if (!resolved.ok) throw new Error('expected ok');
    const components = buildSendComponents(
      TEMPLATE,
      JSON.parse(JSON.stringify(resolved.params))
    );
    expect(components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: '#1042' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'there' },
          { type: 'text', text: 'BlueDart' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'orders/abc?key=xyz' }],
      },
    ]);
  });

  it('names the first slot that has no value for this order', () => {
    const mapping = parseVariableMapping(FULL)!;
    expect(
      resolveSendParams(TEMPLATE, mapping, { order_number: '#1042' })
    ).toEqual({ ok: false, missing: 'body_2:tracking_company' });
  });

  it('needs no values for a template without placeholders', () => {
    const plain = { ...TEMPLATE, header_type: undefined, body_text: 'Thanks!', buttons: [] };
    expect(resolveSendParams(plain, { body: [] }, {})).toEqual({
      ok: true,
      params: { body: [] },
    });
  });
});

describe('image header', () => {
  const IMAGE_TEMPLATE: MessageTemplate = {
    ...TEMPLATE,
    header_type: 'image',
    header_content: undefined,
    header_media_url: 'https://cdn.example.com/default.jpg',
    body_text: 'Thanks for your order!',
    buttons: [],
  };
  const PRODUCT_IMAGE = {
    body: [],
    headerImage: { type: 'field', value: 'product_image_url' },
  };

  it('accepts only an image field as the header image', () => {
    expect(parseVariableMapping(PRODUCT_IMAGE)).toEqual(PRODUCT_IMAGE);
    expect(
      parseVariableMapping({
        headerImage: { type: 'field', value: 'order_number' },
      })
    ).toBeNull();
    expect(
      parseVariableMapping({
        headerImage: { type: 'static', value: 'https://evil.example/x.jpg' },
      })
    ).toBeNull();
  });

  it('is optional, and wrong on a template without an image header', () => {
    const mapping = parseVariableMapping(PRODUCT_IMAGE)!;
    expect(
      validateVariableMapping(IMAGE_TEMPLATE, { body: [] }, 'order_created')
    ).toEqual([]);
    expect(
      validateVariableMapping(IMAGE_TEMPLATE, mapping, 'order_created')
    ).toEqual([]);
    expect(
      validateVariableMapping(
        { ...IMAGE_TEMPLATE, header_type: undefined },
        mapping,
        'order_created'
      )
    ).toEqual(['not_applicable:header_image']);
  });

  it('refuses a picture link in a text placeholder', () => {
    const mapping = parseVariableMapping({
      ...FULL,
      body: [FULL.body[0], { type: 'field', value: 'product_image_url' }],
    })!;
    expect(validateVariableMapping(TEMPLATE, mapping, 'tracking_added')).toEqual([
      'not_applicable:body_2',
    ]);
  });

  it('sends the product picture when the order has one', () => {
    const mapping = parseVariableMapping(PRODUCT_IMAGE)!;
    expect(
      resolveSendParams(IMAGE_TEMPLATE, mapping, {
        product_image_url: 'https://cdn.shopify.com/p.jpg',
      })
    ).toEqual({
      ok: true,
      params: { body: [], headerMediaUrl: 'https://cdn.shopify.com/p.jpg' },
    });
  });

  it('falls back to the image saved with the template', () => {
    const mapping = parseVariableMapping(PRODUCT_IMAGE)!;
    const resolved = resolveSendParams(IMAGE_TEMPLATE, mapping, {});
    expect(resolved).toEqual({ ok: true, params: { body: [] } });
    if (!resolved.ok) throw new Error('expected ok');
    expect(buildSendComponents(IMAGE_TEMPLATE, resolved.params)).toEqual([
      {
        type: 'header',
        parameters: [
          { type: 'image', image: { link: 'https://cdn.example.com/default.jpg' } },
        ],
      },
    ]);
  });

  it('skips when there is neither a product picture nor a template image', () => {
    const bare = { ...IMAGE_TEMPLATE, header_media_url: undefined };
    expect(resolveSendParams(bare, { body: [] }, {})).toEqual({
      ok: false,
      missing: 'header_image',
    });
  });
});
