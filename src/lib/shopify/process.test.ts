import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ notify: vi.fn(), fetchImage: vi.fn() }));

vi.mock('./notify', () => ({ notifyShopifyEvent: mocks.notify }));
vi.mock('./admin-api', () => ({ fetchLineItemImage: mocks.fetchImage }));

import type { ShopifyConfigRow } from './config';
import { processShopifyWebhook } from './process';

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
};

interface FakeState {
  storedOrder: Record<string, unknown> | null;
  rpcResult: Record<string, unknown> | null;
  orderUpserts: { row: Record<string, unknown>; options: unknown }[];
  rpcCalls: Record<string, unknown>[];
}

function fakeDb(state: FakeState): SupabaseClient {
  return {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: state.storedOrder, error: null }),
        upsert: async (row: Record<string, unknown>, options: unknown) => {
          state.orderUpserts.push({ row, options });
          return { error: null };
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
    rpcResult: null,
    orderUpserts: [],
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
