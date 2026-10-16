import { describe, expect, it } from 'vitest';

import {
  extractCheckoutFields,
  extractFulfillmentFields,
  extractOrderCustomer,
  extractOrderFields,
  fieldAppliesToEvent,
  fieldsForEvent,
  firstLineItemRef,
  isImageField,
  paymentModeOf,
  sanitizeTemplateValue,
} from './order-fields';

const ORDER = {
  id: 820982911946154508,
  name: '#1042',
  total_price: '2499.00',
  currency: 'INR',
  order_status_url:
    'https://shop.example.com/12345/orders/abc123/authenticate?key=xyz',
  cancel_reason: 'customer',
  customer: { first_name: 'Priya', last_name: 'Nair' },
  shipping_address: { first_name: 'P', name: 'P Nair', phone: '98765 43210' },
  line_items: [
    { title: 'Aviator sunglasses', quantity: 1 },
    { title: 'Case', quantity: 2 },
  ],
};

describe('sanitizeTemplateValue', () => {
  it('collapses whitespace Meta rejects and trims', () => {
    expect(sanitizeTemplateValue('  a\n\tb     c  ')).toBe('a b c');
  });

  it('caps length and tolerates empties', () => {
    expect(sanitizeTemplateValue('x'.repeat(600))).toHaveLength(500);
    expect(sanitizeTemplateValue(null)).toBe('');
    expect(sanitizeTemplateValue(undefined)).toBe('');
    expect(sanitizeTemplateValue(42)).toBe('42');
  });
});

describe('extractOrderFields', () => {
  it('flattens the mappable order details', () => {
    expect(extractOrderFields(ORDER)).toEqual({
      customer_first_name: 'Priya',
      customer_name: 'Priya Nair',
      order_number: '#1042',
      order_total: '2499.00',
      currency: 'INR',
      item_summary: 'Aviator sunglasses × 1 +1 more',
      product_name: 'Aviator sunglasses',
      item_count: '3',
      order_status_url:
        'https://shop.example.com/12345/orders/abc123/authenticate?key=xyz',
      order_status_url_path: '12345/orders/abc123/authenticate?key=xyz',
      cancel_reason: 'customer',
      payment_mode: 'Prepaid',
    });
  });

  it('omits what the order does not have', () => {
    expect(extractOrderFields({ name: '#7' })).toEqual({
      order_number: '#7',
      payment_mode: 'Prepaid',
    });
    expect(extractOrderFields(null)).toEqual({ payment_mode: 'Prepaid' });
  });

  it('falls back to the shipping name when there is no customer', () => {
    expect(
      extractOrderCustomer({ shipping_address: { name: 'Sam Lee' } })
    ).toEqual({ firstName: '', fullName: 'Sam Lee' });
  });
});

describe('extractFulfillmentFields', () => {
  it('reads tracking, and name/number for orders we never saw', () => {
    expect(
      extractFulfillmentFields({
        name: '#1042.1',
        tracking_number: null,
        tracking_numbers: ['EX123'],
        tracking_urls: ['https://t.example/EX123'],
        tracking_company: 'BlueDart',
        destination: { first_name: 'Priya', name: 'Priya Nair' },
      })
    ).toEqual({
      tracking_number: 'EX123',
      tracking_url: 'https://t.example/EX123',
      tracking_company: 'BlueDart',
      customer_first_name: 'Priya',
      customer_name: 'Priya Nair',
      order_number: '#1042',
    });
  });
});

describe('field applicability', () => {
  it('limits tracking fields to shipment updates', () => {
    expect(fieldAppliesToEvent('tracking_number', 'order_created')).toBe(false);
    expect(fieldAppliesToEvent('tracking_number', 'delivered')).toBe(true);
    expect(fieldAppliesToEvent('cancel_reason', 'order_cancelled')).toBe(true);
    expect(fieldAppliesToEvent('cancel_reason', 'delivered')).toBe(false);
    expect(fieldsForEvent('order_created')).not.toContain('tracking_url');
    expect(fieldsForEvent('order_created')).toContain('order_number');
  });

  it('keeps the picture link out of the text-placeholder choices', () => {
    expect(isImageField('product_image_url')).toBe(true);
    expect(isImageField('order_number')).toBe(false);
    expect(fieldsForEvent('order_created')).not.toContain('product_image_url');
    expect(fieldsForEvent('delivered')).not.toContain('product_image_url');
  });
});

describe('firstLineItemRef', () => {
  it('reads the first item\'s ids as strings', () => {
    expect(
      firstLineItemRef({
        line_items: [
          { variant_id: 808950810, product_id: 632910392 },
          { variant_id: 1, product_id: 2 },
        ],
      })
    ).toEqual({ variantId: '808950810', productId: '632910392' });
  });

  it('tolerates a missing variant and rejects items with no product', () => {
    expect(
      firstLineItemRef({ line_items: [{ variant_id: null, product_id: 7 }] })
    ).toEqual({ variantId: null, productId: '7' });
    expect(
      firstLineItemRef({ line_items: [{ variant_id: null, product_id: null }] })
    ).toBeNull();
    expect(firstLineItemRef({ line_items: [] })).toBeNull();
    expect(firstLineItemRef({})).toBeNull();
    expect(firstLineItemRef(null)).toBeNull();
  });
});

describe('paymentModeOf', () => {
  it('reads cash on delivery from the order gateways', () => {
    expect(
      paymentModeOf({ payment_gateway_names: ['Cash on Delivery (COD)'] })
    ).toBe('cod');
    expect(paymentModeOf({ payment_gateway_names: ['cod'] })).toBe('cod');
    expect(paymentModeOf({ gateway: 'Cash On Delivery' })).toBe('cod');
    expect(
      extractOrderFields({ payment_gateway_names: ['Cash on Delivery (COD)'] })
        .payment_mode
    ).toBe('Cash on Delivery');
  });

  it('treats everything else as prepaid', () => {
    expect(paymentModeOf({ payment_gateway_names: ['razorpay'] })).toBe('prepaid');
    // "cod" inside another word is not cash on delivery.
    expect(paymentModeOf({ payment_gateway_names: ['Codex Pay'] })).toBe('prepaid');
    expect(paymentModeOf({})).toBe('prepaid');
    expect(paymentModeOf(null)).toBe('prepaid');
  });
});

describe('extractCheckoutFields', () => {
  it('flattens an abandoned checkout like an order', () => {
    expect(
      extractCheckoutFields({
        total_price: '1599.00',
        presentment_currency: 'INR',
        customer: { first_name: 'Dinesh', last_name: 'Singh' },
        line_items: [{ title: 'Heritage Watch', quantity: 1 }],
        abandoned_checkout_url:
          'https://shop.example.com/12345/checkouts/ac/abc/recover?key=xyz',
      })
    ).toEqual({
      customer_first_name: 'Dinesh',
      customer_name: 'Dinesh Singh',
      order_total: '1599.00',
      currency: 'INR',
      item_summary: 'Heritage Watch × 1',
      product_name: 'Heritage Watch',
      item_count: '1',
      checkout_url:
        'https://shop.example.com/12345/checkouts/ac/abc/recover?key=xyz',
      checkout_url_path: '12345/checkouts/ac/abc/recover?key=xyz',
    });
  });
});

describe('fieldsForEvent', () => {
  it('offers cart links only to cart reminders and order links only to orders', () => {
    const cart = fieldsForEvent('cart_reminder_1');
    expect(cart).toContain('checkout_url_path');
    expect(cart).toContain('customer_first_name');
    expect(cart).not.toContain('order_number');
    expect(cart).not.toContain('cod_confirm_token');

    const order = fieldsForEvent('order_created');
    expect(order).toContain('cod_confirm_token');
    expect(order).toContain('payment_mode');
    expect(order).not.toContain('checkout_url');
  });
});
