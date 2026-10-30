import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  fetchImage: vi.fn(),
  applyTags: vi.fn(),
}));

vi.mock('./notify', () => ({ notifyShopifyEvent: mocks.notify }));
vi.mock('./auto-tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auto-tags')>()),
  applyAutoTags: mocks.applyTags,
}));
vi.mock('./admin-api', () => ({ fetchLineItemImage: mocks.fetchImage }));

import type { ShopifyConfigRow } from './config';
import { parseLinkCode } from './link-codes';
import { processExternalCheckout, processShopifyWebhook } from './process';

const CONFIG: ShopifyConfigRow = {
  id: 'cfg-1',
  account_id: 'acct-1',
  webhook_token: 'tok',
  webhook_secret: 'enc',
  shop_domain: null,
  default_country_code: '91',
  is_active: true,
  last_webhook_at: null,
  api_client_id: null,
  api_client_secret: null,
  api_access_token: null,
  api_token_expires_at: null,
  api_scopes: null,
  flexype_secret: null,
  flexype_last_webhook_at: null,
  shiprocket_secret: null,
  shiprocket_last_webhook_at: null,
  test_mode: false,
  test_phones: [],
};

interface Cancellation {
  patch: Record<string, unknown>;
  /** Every filter applied to the update, as [method, column, value]. */
  filters: unknown[][];
}

interface FakeState {
  storedOrder: Record<string, unknown> | null;
  storedCheckout: Record<string, unknown> | null;
  rpcResult: Record<string, unknown> | null;
  orderUpserts: { row: Record<string, unknown>; options: unknown }[];
  checkoutUpserts: { row: Record<string, unknown>; options: unknown }[];
  /** Updates to shopify_notifications (scheduled sends being stopped). */
  cancellations: Cancellation[];
  rpcCalls: Record<string, unknown>[];
}

function fakeDb(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data:
            table === 'shopify_checkouts' ? state.storedCheckout : state.storedOrder,
          error: null,
        }),
        upsert: async (row: Record<string, unknown>, options: unknown) => {
          if (table === 'shopify_checkouts') {
            state.checkoutUpserts.push({ row, options });
          } else {
            state.orderUpserts.push({ row, options });
          }
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          const entry: Cancellation = { patch, filters: [] };
          if (table === 'shopify_notifications') state.cancellations.push(entry);
          const chain: Record<string, unknown> = {
            then: (resolve: (r: { error: null }) => unknown) =>
              resolve({ error: null }),
          };
          for (const method of ['eq', 'neq', 'in']) {
            chain[method] = (column: string, value: unknown) => {
              entry.filters.push([method, column, value]);
              return chain;
            };
          }
          return chain;
        },
      };
      return builder;
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push(args);
      return { data: state.rpcResult ? [state.rpcResult] : [], error: null };
    },
  } as unknown as SupabaseClient;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    storedOrder: null,
    storedCheckout: null,
    rpcResult: null,
    orderUpserts: [],
    checkoutUpserts: [],
    cancellations: [],
    rpcCalls: [],
    ...overrides,
  };
}

const ORDER = {
  id: 820982911946154500,
  name: '#1042',
  phone: null,
  total_price: '2499.00',
  currency: 'INR',
  customer: { first_name: 'Priya', last_name: 'Nair', phone: '+919876543210' },
  shipping_address: { phone: '098765 43210' },
  updated_at: '2026-10-12T10:00:00+05:30',
};

const STORED_ORDER = {
  order_name: '#1042',
  phone: '919876543210',
  customer_name: 'Priya Nair',
  fields: { customer_first_name: 'Priya', order_number: '#1042' },
  cancelled_at: null,
  payment_mode: 'cod',
  confirm_token: 'tok-existing-0123456789abcdef',
};

const NEW = {
  applied: true,
  was_new: true,
  prev_tracking_number: null,
  prev_tracking_url: null,
  prev_shipment_status: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notify.mockResolvedValue({ status: 'sent', messageId: 'm' });
  mocks.fetchImage.mockResolvedValue(null);
  mocks.applyTags.mockResolvedValue(undefined);
});

describe('processShopifyWebhook — orders', () => {
  it('stores a new order without overwriting and announces it', async () => {
    const state = freshState();
    await processShopifyWebhook(fakeDb(state), CONFIG, 'orders/create', ORDER, 'wh-1');

    expect(state.orderUpserts).toHaveLength(1);
    expect(state.orderUpserts[0].options).toEqual({
      onConflict: 'account_id,shopify_order_id',
      ignoreDuplicates: true,
    });
    expect(state.orderUpserts[0].row).toMatchObject({
      account_id: 'acct-1',
      shopify_order_id: '820982911946154500',
      order_name: '#1042',
      phone: '919876543210',
      customer_name: 'Priya Nair',
    });
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        event: 'order_created',
        dedupeKey: 'order_created:820982911946154500',
        phone: '919876543210',
        orderName: '#1042',
        webhookId: 'wh-1',
      })
    );
  });

  it('stores the first item\'s picture with the order and passes it on', async () => {
    mocks.fetchImage.mockResolvedValue('https://cdn.shopify.com/p.jpg');
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/create',
      { ...ORDER, line_items: [{ variant_id: 11, product_id: 22, title: 'Cap' }] },
      null
    );

    expect(mocks.fetchImage).toHaveBeenCalledWith(expect.anything(), CONFIG, {
      variantId: '11',
      productId: '22',
    });
    expect(
      (state.orderUpserts[0].row.fields as Record<string, string>).product_image_url
    ).toBe('https://cdn.shopify.com/p.jpg');
    expect(mocks.notify.mock.calls[0][2].fields.product_image_url).toBe(
      'https://cdn.shopify.com/p.jpg'
    );
  });

  it('still announces the order when no picture is found', async () => {
    const state = freshState();
    await processShopifyWebhook(fakeDb(state), CONFIG, 'orders/create', ORDER, null);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][2].fields).not.toHaveProperty(
      'product_image_url'
    );
  });

  it('overwrites on cancellation and announces that', async () => {
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/cancelled',
      { ...ORDER, cancelled_at: '2026-10-12T11:00:00+05:30', cancel_reason: 'customer' },
      null
    );
    expect(state.orderUpserts[0].options).toMatchObject({ ignoreDuplicates: false });
    expect(state.orderUpserts[0].row.cancelled_at).toBe('2026-10-12T05:30:00.000Z');
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({
      event: 'order_cancelled',
      fields: expect.objectContaining({ cancel_reason: 'customer' }),
    });
  });

  it('does not announce creation of an order that is already cancelled', async () => {
    await processShopifyWebhook(
      fakeDb(freshState()),
      CONFIG,
      'orders/create',
      { ...ORDER, cancelled_at: '2026-10-12T11:00:00+05:30' },
      null
    );
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('ignores a payload without an id', async () => {
    const state = freshState();
    await processShopifyWebhook(fakeDb(state), CONFIG, 'orders/create', {}, null);
    await processShopifyWebhook(fakeDb(state), CONFIG, 'orders/create', 'x', null);
    expect(state.orderUpserts).toEqual([]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe('processShopifyWebhook — result for the webhook log', () => {
  it('reports each update and what happened to it', async () => {
    mocks.notify.mockResolvedValue({ status: 'skipped', reason: 'no_phone' });
    const result = await processShopifyWebhook(
      fakeDb(freshState()),
      CONFIG,
      'orders/create',
      ORDER,
      null
    );
    expect(result).toEqual({
      orderRef: '#1042',
      outcomes: [{ event: 'order_created', status: 'skipped', reason: 'no_phone' }],
    });
  });

  it('explains deliveries that produce no update', async () => {
    expect(
      await processShopifyWebhook(
        fakeDb(freshState()),
        CONFIG,
        'orders/create',
        { ...ORDER, cancelled_at: '2026-10-12T11:00:00+05:30' },
        null
      )
    ).toEqual({ orderRef: '#1042', note: 'order_already_cancelled', outcomes: [] });

    expect(
      await processShopifyWebhook(fakeDb(freshState()), CONFIG, 'orders/create', {}, null)
    ).toEqual({ orderRef: null, note: 'missing_id', outcomes: [] });

    expect(
      await processShopifyWebhook(fakeDb(freshState()), CONFIG, 'orders/create', 'x', null)
    ).toEqual({ orderRef: null, note: 'invalid_payload', outcomes: [] });

    const fulfillment = { id: 1, order_id: 2, name: '#1042.1', tracking_number: 'EX1' };
    expect(
      await processShopifyWebhook(
        fakeDb(freshState({ rpcResult: { ...NEW, applied: false, was_new: false } })),
        CONFIG,
        'fulfillments/update',
        fulfillment,
        null
      )
    ).toEqual({ orderRef: '#1042.1', note: 'stale_update', outcomes: [] });

    expect(
      await processShopifyWebhook(
        fakeDb(
          freshState({
            rpcResult: { ...NEW, was_new: false, prev_tracking_number: 'EX1' },
          })
        ),
        CONFIG,
        'fulfillments/update',
        fulfillment,
        null
      )
    ).toEqual({ orderRef: '#1042.1', note: 'no_change', outcomes: [] });
  });
});

describe('processShopifyWebhook — fulfillments', () => {
  const FULFILLMENT = {
    id: 255858046,
    order_id: 820982911946154500,
    name: '#1042.1',
    status: 'success',
    tracking_number: 'EX123',
    tracking_url: 'https://t.example/EX123',
    tracking_company: 'BlueDart',
    shipment_status: null,
    updated_at: '2026-10-12T12:00:00+05:30',
    destination: { first_name: 'Priya', name: 'Priya Nair', phone: '98765 43210' },
  };

  it('announces tracking using the stored order', async () => {
    const state = freshState({ storedOrder: STORED_ORDER, rpcResult: NEW });
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'fulfillments/create',
      FULFILLMENT,
      'wh-2'
    );

    expect(state.rpcCalls[0]).toMatchObject({
      p_account_id: 'acct-1',
      p_fulfillment_id: '255858046',
      p_order_id: '820982911946154500',
      p_tracking_number: 'EX123',
      p_shipment_status: null,
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({
      event: 'tracking_added',
      dedupeKey: 'tracking_added:255858046',
      phone: '919876543210',
      orderName: '#1042',
      fields: expect.objectContaining({
        customer_first_name: 'Priya',
        tracking_number: 'EX123',
        tracking_company: 'BlueDart',
      }),
    });
  });

  it('keys a tracking change by the new number and reports delivery', async () => {
    const changed = freshState({
      storedOrder: STORED_ORDER,
      rpcResult: { ...NEW, was_new: false, prev_tracking_number: 'EX000' },
    });
    await processShopifyWebhook(fakeDb(changed), CONFIG, 'fulfillments/update', FULFILLMENT, null);
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({
      event: 'tracking_updated',
      dedupeKey: 'tracking_updated:255858046:EX123',
    });

    mocks.notify.mockClear();
    const delivered = freshState({
      storedOrder: STORED_ORDER,
      rpcResult: {
        ...NEW,
        was_new: false,
        prev_tracking_number: 'EX123',
        prev_shipment_status: 'out_for_delivery',
      },
    });
    await processShopifyWebhook(
      fakeDb(delivered),
      CONFIG,
      'fulfillments/update',
      { ...FULFILLMENT, shipment_status: 'delivered' },
      null
    );
    expect(mocks.notify.mock.calls.map((c) => c[2].event)).toEqual(['delivered']);
  });

  it('sends nothing for a stale delivery', async () => {
    const state = freshState({
      storedOrder: STORED_ORDER,
      rpcResult: { ...NEW, applied: false, was_new: false },
    });
    await processShopifyWebhook(fakeDb(state), CONFIG, 'fulfillments/update', FULFILLMENT, null);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('sends nothing for a shipment of a cancelled order', async () => {
    const state = freshState({
      storedOrder: { ...STORED_ORDER, cancelled_at: '2026-10-12T05:30:00.000Z' },
      rpcResult: NEW,
    });
    await processShopifyWebhook(fakeDb(state), CONFIG, 'fulfillments/create', FULFILLMENT, null);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('falls back to the destination phone for an order it never saw', async () => {
    vi.useFakeTimers();
    try {
      const state = freshState({ storedOrder: null, rpcResult: NEW });
      const run = processShopifyWebhook(
        fakeDb(state),
        CONFIG,
        'fulfillments/create',
        FULFILLMENT,
        null
      );
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({
      event: 'tracking_added',
      phone: '919876543210',
      orderName: '#1042',
      customerName: 'Priya Nair',
    });
  });

  it('reuses the stored picture, and looks one up only for an unseen order', async () => {
    const seen = freshState({
      storedOrder: {
        ...STORED_ORDER,
        fields: { ...STORED_ORDER.fields, product_image_url: 'https://cdn/stored.jpg' },
      },
      rpcResult: NEW,
    });
    await processShopifyWebhook(fakeDb(seen), CONFIG, 'fulfillments/create', FULFILLMENT, null);
    expect(mocks.fetchImage).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls[0][2].fields.product_image_url).toBe(
      'https://cdn/stored.jpg'
    );

    mocks.notify.mockClear();
    mocks.fetchImage.mockResolvedValue('https://cdn/looked-up.jpg');
    vi.useFakeTimers();
    try {
      const unseen = freshState({ storedOrder: null, rpcResult: NEW });
      const run = processShopifyWebhook(
        fakeDb(unseen),
        CONFIG,
        'fulfillments/create',
        { ...FULFILLMENT, line_items: [{ variant_id: 11, product_id: 22 }] },
        null
      );
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.fetchImage).toHaveBeenCalledWith(expect.anything(), CONFIG, {
      variantId: '11',
      productId: '22',
    });
    expect(mocks.notify.mock.calls[0][2].fields.product_image_url).toBe(
      'https://cdn/looked-up.jpg'
    );
  });
});

describe('processShopifyWebhook — payment mode and the confirmation page', () => {
  it('stores how the order is paid and a confirmation token, and passes both on', async () => {
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/create',
      { ...ORDER, payment_gateway_names: ['Cash on Delivery (COD)'] },
      null
    );

    const row = state.orderUpserts[0].row;
    expect(row.payment_mode).toBe('cod');
    expect(row.confirm_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const input = mocks.notify.mock.calls[0][2];
    expect(input.paymentMode).toBe('cod');
    expect(input.fields.cod_confirm_token).toBe(row.confirm_token);
    expect(input.fields.payment_mode).toBe('Cash on Delivery');
  });

  it('keeps the token of a link already sent when the order is cancelled', async () => {
    const state = freshState({ storedOrder: STORED_ORDER });
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/cancelled',
      { ...ORDER, cancelled_at: '2026-10-12T11:00:00+05:30' },
      null
    );
    expect(state.orderUpserts[0].row.confirm_token).toBe(
      'tok-existing-0123456789abcdef'
    );
  });

  it("gives shipment updates the order's payment mode", async () => {
    const state = freshState({ storedOrder: STORED_ORDER, rpcResult: NEW });
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'fulfillments/create',
      { id: 5, order_id: 1001, tracking_number: 'EX1', status: 'success' },
      null
    );
    expect(mocks.notify.mock.calls[0][2].paymentMode).toBe('cod');
  });
});

describe('processShopifyWebhook — stopping sends that are still waiting', () => {
  it('a cancellation stops the order\'s delayed updates, but not its own', async () => {
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/cancelled',
      { ...ORDER, cancelled_at: '2026-10-12T11:00:00+05:30' },
      null
    );
    expect(state.cancellations).toHaveLength(1);
    expect(state.cancellations[0].patch).toMatchObject({
      status: 'cancelled',
      reason: 'order_cancelled',
    });
    expect(state.cancellations[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'status', 'scheduled'],
        ['eq', 'shopify_order_id', '820982911946154500'],
        ['neq', 'event', 'order_cancelled'],
      ])
    );
  });

  it('an order stops cart reminders for its checkout and for its phone', async () => {
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/create',
      { ...ORDER, checkout_id: 777 },
      null
    );
    expect(state.cancellations).toHaveLength(2);
    for (const c of state.cancellations) {
      expect(c.patch).toMatchObject({ status: 'cancelled', reason: 'order_placed' });
      expect(c.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'status', 'scheduled'],
          ['in', 'event', ['cart_reminder_1', 'cart_reminder_2', 'cart_reminder_3']],
        ])
      );
    }
    expect(state.cancellations[0].filters).toContainEqual([
      'eq',
      'shopify_checkout_id',
      '777',
    ]);
    // A third-party checkout leaves no checkout id; the phone still links them.
    expect(state.cancellations[1].filters).toContainEqual([
      'eq',
      'payload->>phone',
      '919876543210',
    ]);
  });
});

describe('processShopifyWebhook — abandoned checkouts', () => {
  const CHECKOUT = {
    id: 981820079255243500,
    updated_at: '2026-10-13T10:00:00+05:30',
    completed_at: null,
    total_price: '1599.00',
    currency: 'INR',
    abandoned_checkout_url: 'https://shop.example.com/1/checkouts/ac/abc/recover?key=k',
    customer: { first_name: 'Dinesh', last_name: 'Singh', phone: '+919029130001' },
    line_items: [{ title: 'Heritage Watch', quantity: 1, variant_id: 11, product_id: 22 }],
  };

  it('stores the checkout and asks for all three reminders', async () => {
    mocks.notify.mockResolvedValue({
      status: 'scheduled',
      sendAt: '2026-10-13T05:30:00.000Z',
    });
    const state = freshState();
    const result = await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'checkouts/create',
      CHECKOUT,
      'wh-9'
    );

    expect(state.checkoutUpserts[0].row).toMatchObject({
      account_id: 'acct-1',
      shopify_checkout_id: '981820079255243500',
      phone: '919029130001',
      customer_name: 'Dinesh Singh',
      completed_at: null,
    });
    expect(mocks.notify.mock.calls.map((c) => c[2].event)).toEqual([
      'cart_reminder_1',
      'cart_reminder_2',
      'cart_reminder_3',
    ]);
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({
      dedupeKey: 'cart_reminder_1:981820079255243500',
      checkoutId: '981820079255243500',
      orderId: null,
      phone: '919029130001',
    });
    expect(mocks.notify.mock.calls[0][2].fields.checkout_url_path).toBe(
      '1/checkouts/ac/abc/recover?key=k'
    );
    // The CRM's own /r/ code for this cart, kept with the checkout.
    expect(
      parseLinkCode(mocks.notify.mock.calls[0][2].fields.checkout_link_code)
    ).toMatchObject({ kind: 'c', id: '981820079255243500' });
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({
      event: 'cart_reminder_1',
      status: 'scheduled',
    });
  });

  it('reports nothing new when the reminders are already claimed or off', async () => {
    mocks.notify
      .mockResolvedValueOnce({ status: 'duplicate' })
      .mockResolvedValueOnce({ status: 'disabled' })
      .mockResolvedValueOnce({ status: 'disabled' });
    const result = await processShopifyWebhook(
      fakeDb(freshState()),
      CONFIG,
      'checkouts/update',
      CHECKOUT,
      null
    );
    expect(result).toMatchObject({ note: 'no_change', outcomes: [] });
  });

  it('waits for a phone number without claiming anything', async () => {
    const state = freshState();
    const result = await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'checkouts/create',
      { ...CHECKOUT, customer: { first_name: 'Dinesh' } },
      null
    );
    expect(result.note).toBe('no_phone');
    expect(state.checkoutUpserts).toHaveLength(1);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('a completed checkout stops its reminders and schedules none', async () => {
    const state = freshState();
    const result = await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'checkouts/update',
      { ...CHECKOUT, completed_at: '2026-10-13T10:05:00+05:30' },
      null
    );
    expect(result.note).toBe('checkout_completed');
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(state.cancellations[0].patch).toMatchObject({
      status: 'cancelled',
      reason: 'checkout_completed',
    });
    expect(state.cancellations[0].filters).toContainEqual([
      'eq',
      'shopify_checkout_id',
      '981820079255243500',
    ]);
  });

  it('drops an update older than the one already stored', async () => {
    const state = freshState({
      storedCheckout: { fields: {}, source_updated_at: '2026-10-13T06:00:00.000Z' },
    });
    const result = await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'checkouts/update',
      CHECKOUT,
      null
    );
    expect(result.note).toBe('stale_update');
    expect(state.checkoutUpserts).toEqual([]);
  });

  it('looks the product picture up once and then reuses it', async () => {
    mocks.fetchImage.mockResolvedValue('https://cdn.shopify.com/w.jpg');
    const first = freshState();
    await processShopifyWebhook(fakeDb(first), CONFIG, 'checkouts/create', CHECKOUT, null);
    expect(mocks.fetchImage).toHaveBeenCalledTimes(1);
    expect(
      (first.checkoutUpserts[0].row.fields as Record<string, string>).product_image_url
    ).toBe('https://cdn.shopify.com/w.jpg');

    mocks.fetchImage.mockClear();
    const later = freshState({
      storedCheckout: {
        fields: { product_image_url: 'https://cdn.shopify.com/w.jpg' },
        source_updated_at: null,
      },
    });
    await processShopifyWebhook(fakeDb(later), CONFIG, 'checkouts/update', CHECKOUT, null);
    expect(mocks.fetchImage).not.toHaveBeenCalled();
    expect(
      (later.checkoutUpserts[0].row.fields as Record<string, string>).product_image_url
    ).toBe('https://cdn.shopify.com/w.jpg');
  });
});

describe('FlexyPe abandoned checkouts', () => {
  const CART = {
    checkoutId: 'flexype:sess-1',
    phone: '919029130001',
    customerName: 'Dinesh Kumar',
    fields: {
      customer_first_name: 'Dinesh',
      checkout_url: 'https://checkout.flexype.io/abc',
      product_image_url: 'https://cdn.shopify.com/ring.jpg',
    },
    lineItem: { variantId: '11', productId: '22' },
    shopDomain: 'qxm9zm-ei.myshopify.com',
  };

  it('stores the checkout and claims all three reminders for it', async () => {
    mocks.notify.mockResolvedValue({ status: 'scheduled', sendAt: 'x' });
    const state = freshState();
    const result = await processExternalCheckout(fakeDb(state), CONFIG, CART, 'evt-1');

    expect(state.checkoutUpserts[0].row).toMatchObject({
      account_id: 'acct-1',
      shopify_checkout_id: 'flexype:sess-1',
      phone: '919029130001',
      customer_name: 'Dinesh Kumar',
    });
    expect(mocks.notify).toHaveBeenCalledTimes(3);
    expect(mocks.notify.mock.calls.map((c) => c[2].dedupeKey)).toEqual([
      'cart_reminder_1:flexype:sess-1',
      'cart_reminder_2:flexype:sess-1',
      'cart_reminder_3:flexype:sess-1',
    ]);
    expect(mocks.notify.mock.calls[0][2]).toMatchObject({
      checkoutId: 'flexype:sess-1',
      orderName: 'Dinesh Kumar',
      webhookId: 'evt-1',
    });
    expect(
      parseLinkCode(
        (state.checkoutUpserts[0].row.fields as Record<string, unknown>)
          .checkout_link_code
      )
    ).toMatchObject({ kind: 'c', id: 'flexype:sess-1' });
    // FlexyPe sent a picture: no Shopify lookup.
    expect(mocks.fetchImage).not.toHaveBeenCalled();
    expect(result.outcomes).toHaveLength(3);
  });

  it("looks the picture up on Shopify when FlexyPe sent none", async () => {
    mocks.fetchImage.mockResolvedValue('https://cdn.shopify.com/from-shopify.jpg');
    const state = freshState();
    const noPicture: Record<string, string> = { ...CART.fields };
    delete noPicture.product_image_url;
    await processExternalCheckout(
      fakeDb(state),
      CONFIG,
      { ...CART, fields: noPicture },
      null
    );

    expect(mocks.fetchImage).toHaveBeenCalledWith(expect.anything(), CONFIG, {
      variantId: '11',
      productId: '22',
    });
    expect(mocks.notify.mock.calls[0][2].fields.product_image_url).toBe(
      'https://cdn.shopify.com/from-shopify.jpg'
    );
  });

  it('schedules nothing without a phone', async () => {
    const state = freshState();
    const result = await processExternalCheckout(
      fakeDb(state),
      CONFIG,
      { ...CART, phone: null },
      null
    );
    expect(state.checkoutUpserts).toHaveLength(1);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(result.note).toBe('no_phone');
  });

  it("an order carrying FlexyPe's session id stops that checkout's reminders", async () => {
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'orders/create',
      {
        ...ORDER,
        note_attributes: [{ name: 'FlexyPe Session ID', value: 'sess-1' }],
      },
      null
    );

    const bySession = state.cancellations.find((c) =>
      c.filters.some(
        (f) => f[1] === 'shopify_checkout_id' && f[2] === 'flexype:sess-1'
      )
    );
    expect(bySession?.patch).toMatchObject({
      status: 'cancelled',
      reason: 'order_placed',
    });
  });
});

describe('testing mode — only test numbers get through', () => {
  const TESTING: ShopifyConfigRow = {
    ...CONFIG,
    test_mode: true,
    test_phones: ['919029130001'],
  };
  const FULFILLMENT = {
    id: 255858046,
    order_id: 820982911946154500,
    status: 'success',
    tracking_number: 'EX123',
    destination: { phone: '98765 43210' },
  };

  it('drops an order for anyone else before storing it', async () => {
    const state = freshState();
    const result = await processShopifyWebhook(
      fakeDb(state),
      TESTING,
      'orders/create',
      ORDER,
      'wh-1'
    );
    expect(result).toEqual({ orderRef: '#1042', note: 'test_mode', outcomes: [] });
    expect(state.orderUpserts).toEqual([]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('processes an order for a test number as usual', async () => {
    const state = freshState();
    await processShopifyWebhook(
      fakeDb(state),
      TESTING,
      'orders/create',
      { ...ORDER, customer: { ...ORDER.customer, phone: '+919029130001' } },
      'wh-1'
    );
    expect(state.orderUpserts).toHaveLength(1);
    expect(mocks.notify).toHaveBeenCalled();
  });

  it("judges a shipment by its stored order's phone", async () => {
    const blocked = freshState({ storedOrder: STORED_ORDER, rpcResult: NEW });
    const result = await processShopifyWebhook(
      fakeDb(blocked),
      TESTING,
      'fulfillments/create',
      FULFILLMENT,
      'wh-2'
    );
    expect(result.note).toBe('test_mode');
    expect(blocked.rpcCalls).toEqual([]);

    const allowed = freshState({
      storedOrder: { ...STORED_ORDER, phone: '919029130001' },
      rpcResult: NEW,
    });
    await processShopifyWebhook(
      fakeDb(allowed),
      TESTING,
      'fulfillments/create',
      FULFILLMENT,
      'wh-2'
    );
    expect(allowed.rpcCalls).toHaveLength(1);
  });

  it('drops a FlexyPe cart for anyone else', async () => {
    const state = freshState();
    const result = await processExternalCheckout(
      fakeDb(state),
      { ...TESTING, test_phones: ['919999999999'] },
      {
        checkoutId: 'flexype:sess-1',
        phone: '919029130001',
        customerName: 'Dinesh Kumar',
        fields: {},
        lineItem: null,
        shopDomain: null,
      },
      'evt-1'
    );
    expect(result.note).toBe('test_mode');
    expect(state.checkoutUpserts).toEqual([]);
  });
});

describe('CRM redirect link codes', () => {
  it('gives an order its order-page code', async () => {
    const state = freshState();
    await processShopifyWebhook(fakeDb(state), CONFIG, 'orders/create', ORDER, 'wh-1');
    expect(state.orderUpserts[0].row.fields).toMatchObject({
      order_link_code: expect.stringMatching(/^s820982911946154500\./),
    });
  });

  it('gives a shipment its tracking code and its order code', async () => {
    const state = freshState({ storedOrder: STORED_ORDER, rpcResult: NEW });
    await processShopifyWebhook(
      fakeDb(state),
      CONFIG,
      'fulfillments/create',
      {
        id: 255858046,
        order_id: 820982911946154500,
        status: 'success',
        tracking_number: 'EX123',
        tracking_url: 'https://t.example/EX123',
      },
      'wh-2'
    );
    expect(mocks.notify.mock.calls[0][2].fields).toMatchObject({
      tracking_link_code: expect.stringMatching(/^t255858046\./),
      order_link_code: expect.stringMatching(/^s820982911946154500\./),
    });
  });
});

describe('automatic contact tags', () => {
  const tagCall = (i = 0) => mocks.applyTags.mock.calls[i];

  it("tags a new order with how it was paid and clears the abandoned cart", async () => {
    await processShopifyWebhook(
      fakeDb(freshState()),
      CONFIG,
      'orders/create',
      { ...ORDER, payment_gateway_names: ['Cash on Delivery (COD)'] },
      null
    );
    expect(tagCall()[1]).toBe('acct-1');
    expect(tagCall()[2]).toBe('919876543210');
    expect(tagCall()[4]).toEqual({
      add: ['Order Placed(CoD)'],
      remove: ['Abandoned Cart'],
    });
  });

  it('does not tag cancellations or shipment progress', async () => {
    await processShopifyWebhook(
      fakeDb(freshState()),
      CONFIG,
      'orders/cancelled',
      { ...ORDER, cancelled_at: '2026-10-12T11:00:00+05:30' },
      null
    );
    await processShopifyWebhook(
      fakeDb(freshState({ storedOrder: STORED_ORDER, rpcResult: NEW })),
      CONFIG,
      'fulfillments/create',
      {
        id: 255858046,
        order_id: 820982911946154500,
        tracking_number: 'EX123',
        tracking_url: 'https://t.example/EX123',
        shipment_status: 'delivered',
        updated_at: '2026-10-12T12:00:00+05:30',
      },
      null
    );
    expect(mocks.applyTags).not.toHaveBeenCalled();
  });

  it('tags an abandoned FlexyPe cart', async () => {
    await processExternalCheckout(
      fakeDb(freshState()),
      CONFIG,
      {
        checkoutId: 'flexype:sess-9',
        phone: '919029130001',
        customerName: 'Arun',
        fields: {},
        lineItem: null,
        shopDomain: null,
      },
      null
    );
    expect(tagCall()[2]).toBe('919029130001');
    expect(tagCall()[4]).toEqual({ add: ['Abandoned Cart'], remove: [] });
  });
});
