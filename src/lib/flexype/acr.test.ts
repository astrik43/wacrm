import { describe, expect, it } from 'vitest';

import {
  flexypeSessionOfOrder,
  isFlexypeSample,
  parseFlexypeAbandonedCheckout,
} from './acr';

// Shape of https://docs.flexype.io/webhooks/2026-05/acr
const V2026 = {
  event_time: '2026-10-14T10:00:00Z',
  event_type: 'ABANDONED_CHECKOUT',
  event_id: 'evt_1',
  store: { id: 's', name: 'Estelle Luxe', shopify_domain: 'qxm9zm-ei.myshopify.com' },
  payload: {
    session_id: '022eacfc-5a6a',
    checkout_url: 'https://checkout.flexype.io/abc123xyz?x=1',
    checkout_context: { store_currency: 'INR', presentment_currency: 'INR' },
    user: {
      full_name: 'Dinesh Kumar',
      first_name: 'Dinesh',
      last_name: 'Kumar',
      dial_code: '91',
      phone: '9029130001',
      phone_with_dial_code: '+919029130001',
    },
    cart_items: [
      {
        image: 'https://cdn.shopify.com/ring.jpg',
        title: 'Solitaire Ring',
        price: 1599,
        quantity: 1,
        product_id: 22,
        variant_id: 11,
        total_price: 1599,
        variant: { title: 'Gold / 7' },
      },
      { title: 'Gift box', price: 100, quantity: 2, total_price: 200 },
    ],
    session_state: 'PHONE_ENTERED',
  },
};

// Shape of https://docs.flexype.io/webhooks/2025-09/acr
const V2025 = {
  webhook_id: 'wh_123',
  shopify_domain: 'qxm9zm-ei.myshopify.com',
  cart_items: [{ title: 'Earrings', price: 799, quantity: 1, image: '//cdn.shopify.com/e.jpg' }],
  checkout_url: 'https://checkout.flexype.io/def',
  total_payable: 799,
  user: { phone_no: '9029130001', dial_code: '91', name: 'Asha Rao' },
};

describe('parseFlexypeAbandonedCheckout', () => {
  it('maps a 2026-05 payload onto the cart fields', () => {
    const result = parseFlexypeAbandonedCheckout(V2026, '91');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkout).toEqual({
      checkoutId: 'flexype:022eacfc-5a6a',
      phone: '919029130001',
      customerName: 'Dinesh Kumar',
      shopDomain: 'qxm9zm-ei.myshopify.com',
      lineItem: { variantId: '11', productId: '22' },
      fields: {
        customer_first_name: 'Dinesh',
        customer_name: 'Dinesh Kumar',
        order_total: '1799.00',
        currency: 'INR',
        item_summary: 'Solitaire Ring (Gold / 7) × 1 +1 more',
        product_name: 'Solitaire Ring',
        item_count: '3',
        checkout_url: 'https://checkout.flexype.io/abc123xyz?x=1',
        checkout_url_path: 'abc123xyz?x=1',
        product_image_url: 'https://cdn.shopify.com/ring.jpg',
      },
    });
  });

  it('maps a 2025-09 payload too', () => {
    const result = parseFlexypeAbandonedCheckout(V2025, '91');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkout).toMatchObject({
      checkoutId: 'flexype:wh_123',
      phone: '919029130001',
      customerName: 'Asha Rao',
      fields: {
        customer_first_name: 'Asha',
        order_total: '799.00',
        item_summary: 'Earrings × 1',
        product_name: 'Earrings',
        product_image_url: 'https://cdn.shopify.com/e.jpg',
      },
    });
  });

  it('builds the phone from dial code + number when the full one is missing', () => {
    const body = structuredClone(V2026);
    delete (body.payload.user as Record<string, unknown>).phone_with_dial_code;
    const result = parseFlexypeAbandonedCheckout(body, null);
    expect(result.ok && result.checkout.phone).toBe('919029130001');
  });

  it('keeps going without a phone (nothing will be scheduled)', () => {
    const body = structuredClone(V2026);
    body.payload.user = { full_name: 'X' } as typeof body.payload.user;
    const result = parseFlexypeAbandonedCheckout(body, '91');
    expect(result.ok && result.checkout.phone).toBeNull();
  });

  it('ignores non-https pictures', () => {
    const body = structuredClone(V2026);
    body.payload.cart_items[0].image = 'http://insecure.example/x.jpg';
    const result = parseFlexypeAbandonedCheckout(body, '91');
    expect(result.ok && result.checkout.fields.product_image_url).toBeUndefined();
  });

  it('rejects other events and unusable bodies', () => {
    expect(
      parseFlexypeAbandonedCheckout({ ...V2026, event_type: 'PRODUCT_VIEWED' }, '91')
    ).toEqual({ ok: false, reason: 'unsupported_event' });
    expect(parseFlexypeAbandonedCheckout([], '91')).toEqual({
      ok: false,
      reason: 'invalid_payload',
    });
    expect(
      parseFlexypeAbandonedCheckout({ event_type: 'ABANDONED_CHECKOUT', payload: {} }, '91')
    ).toEqual({ ok: false, reason: 'missing_id' });
  });

  it("recognises FlexyPe's sample (the dashboard Test button)", () => {
    const body = structuredClone(V2026);
    body.payload.user.phone_with_dial_code = '+919876543210';
    const result = parseFlexypeAbandonedCheckout(body, '91');
    expect(result.ok && isFlexypeSample(result.checkout)).toBe(true);
    // What the dashboard's Test button sends in practice.
    body.payload.user.phone_with_dial_code = '+919845012345';
    const button = parseFlexypeAbandonedCheckout(body, '91');
    expect(button.ok && isFlexypeSample(button.checkout)).toBe(true);
    const real = parseFlexypeAbandonedCheckout(V2026, '91');
    expect(real.ok && isFlexypeSample(real.checkout)).toBe(false);
  });
});

describe('flexypeSessionOfOrder', () => {
  it("reads FlexyPe's session id from the order's note attributes", () => {
    expect(
      flexypeSessionOfOrder({
        note_attributes: [
          { name: 'other', value: 'x' },
          { name: 'FlexyPe Session ID', value: '022eacfc-5a6a' },
        ],
      })
    ).toBe('022eacfc-5a6a');
    expect(flexypeSessionOfOrder({ note_attributes: [] })).toBeNull();
    expect(flexypeSessionOfOrder({})).toBeNull();
  });
});
