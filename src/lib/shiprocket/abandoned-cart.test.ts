import { describe, expect, it } from 'vitest';

import { parseShiprocketAbandonedCart } from './abandoned-cart';

describe('parseShiprocketAbandonedCart', () => {
  it('reads the flat Fastrr cart into cart reminder fields', () => {
    const result = parseShiprocketAbandonedCart(
      {
        cart_id: 'cart-77',
        email: '9029130001@fastrr.com',
        phone_number: '9029130001',
        first_name: 'Dinesh',
        last_name: 'Kumar',
        billing_address: { city: 'Mumbai', state: 'Maharashtra' },
        checkout_url: 'https://estelleluxe.in/cart/c/abc?key=1',
        total_price: '2,598.00',
        latest_stage: 'PAYMENT_INITIATED',
        items: [
          {
            title: 'Ring',
            variant_title: 'Gold',
            quantity: 2,
            price: 999,
            image: 'https://cdn.shopify.com/ring.jpg',
            variant_id: 'gid://shopify/ProductVariant/4455',
            product_id: 1122,
          },
          { title: 'Earrings', quantity: 1, price: 600 },
        ],
      },
      '91'
    );
    expect(result).toEqual({
      ok: true,
      stage: 'PAYMENT_INITIATED',
      checkout: {
        checkoutId: 'shiprocket:cart-77',
        phone: '919029130001',
        customerName: 'Dinesh Kumar',
        lineItem: { variantId: '4455', productId: '1122' },
        shopDomain: 'estelleluxe.in',
        fields: {
          customer_first_name: 'Dinesh',
          customer_name: 'Dinesh Kumar',
          order_total: '2598.00',
          currency: 'INR',
          item_summary: 'Ring (Gold) × 2 +1 more',
          product_name: 'Ring',
          item_count: '3',
          checkout_url: 'https://estelleluxe.in/cart/c/abc?key=1',
          checkout_url_path: 'cart/c/abc?key=1',
          product_image_url: 'https://cdn.shopify.com/ring.jpg',
        },
      },
    });
  });

  it('accepts a wrapped cart with a nested customer and line_items', () => {
    const result = parseShiprocketAbandonedCart(
      {
        data: {
          id: 991,
          customer: { name: 'Asha Rao', phone: '+91 98200 11122' },
          line_items: [{ name: 'Necklace', qty: 1, line_price: 1500 }],
          cart_url: 'https://estelleluxe.in/c/x',
        },
      },
      '91'
    );
    expect(result.ok && result.checkout).toMatchObject({
      checkoutId: 'shiprocket:991',
      phone: '919820011122',
      customerName: 'Asha Rao',
      fields: {
        customer_first_name: 'Asha',
        order_total: '1500.00',
        item_summary: 'Necklace × 1',
        checkout_url: 'https://estelleluxe.in/c/x',
      },
    });
  });

  it('falls back to the address phone', () => {
    const result = parseShiprocketAbandonedCart(
      { cart_id: 'c1', shipping_address: { phone: '9029130001' } },
      '91'
    );
    expect(result.ok && result.checkout.phone).toBe('919029130001');
  });

  it('refuses a cart without an id, a completed one, or a non-object', () => {
    expect(parseShiprocketAbandonedCart({ phone_number: '9029130001' }, '91')).toEqual({
      ok: false,
      reason: 'missing_id',
      stage: null,
    });
    expect(
      parseShiprocketAbandonedCart({ cart_id: 'c1', latest_stage: 'ORDER_PLACED' }, '91')
    ).toMatchObject({ ok: false, reason: 'checkout_completed' });
    expect(parseShiprocketAbandonedCart([], '91')).toEqual({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('drops a picture WhatsApp cannot fetch', () => {
    const result = parseShiprocketAbandonedCart(
      { cart_id: 'c1', items: [{ title: 'Ring', image_url: 'http://x/ring.jpg' }] },
      '91'
    );
    expect(result.ok && result.checkout.fields.product_image_url).toBeUndefined();
  });
});
