import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveTemplateRow: vi.fn(),
  sendTest: vi.fn(),
  latest: null as Record<string, unknown> | null,
  shipments: [] as Record<string, unknown>[],
  shipmentOrders: [] as Record<string, unknown>[],
  tables: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: mocks.resolveTemplateRow,
}));

vi.mock('@/lib/shopify/notify', () => ({
  sendTestNotification: mocks.sendTest,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      mocks.tables.push(table);
      let listed = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        not: () => builder,
        in: () => {
          listed = true;
          return builder;
        },
        limit: () => {
          if (table === 'shopify_fulfillments') listed = true;
          return builder;
        },
        // Lists: shipments, and the stored orders of those shipments.
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data: !listed
              ? null
              : table === 'shopify_fulfillments'
                ? mocks.shipments
                : mocks.shipmentOrders,
            error: null,
          }),
        maybeSingle: async () => ({
          data:
            table === 'shopify_configs'
              ? { default_country_code: '91' }
              : mocks.latest,
          error: null,
        }),
      };
      return builder;
    },
  }),
}));

import { POST } from './route';

const TEMPLATE = {
  id: 'tpl-1',
  name: 'feedback_request',
  category: 'Utility',
  language: 'en',
  body_text: 'Hi {{1}}, how is your order {{2}}?',
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
};

const BODY = {
  event: 'delivered',
  step: 1,
  template_name: 'feedback_request',
  template_language: 'en',
  variable_mapping: {
    body: [
      { type: 'field', value: 'customer_first_name' },
      { type: 'field', value: 'order_number' },
    ],
  },
  phone: '90291 30001',
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/shopify/events/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latest = null;
  mocks.shipments = [];
  mocks.shipmentOrders = [];
  mocks.tables = [];
  mocks.requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-1',
    userId: 'u-1',
    role: 'admin',
  });
  mocks.resolveTemplateRow.mockResolvedValue({
    row: TEMPLATE,
    malformed: false,
    language: 'en',
  });
  mocks.sendTest.mockResolvedValue({ status: 'sent', messageId: 'm-1' });
});

describe('POST /api/shopify/events/test', () => {
  it('requires admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await post(BODY)).status).toBe(403);
    expect(mocks.sendTest).not.toHaveBeenCalled();
  });

  it('sends the message now with the latest order laid over samples', async () => {
    mocks.latest = {
      order_name: '#EL1679',
      fields: { customer_first_name: 'Dinesh', order_number: '#EL1679' },
    };
    const response = await post(BODY);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phone: '919029130001' });
    expect(mocks.tables).toContain('shopify_orders');

    const input = mocks.sendTest.mock.calls[0][2];
    expect(input).toMatchObject({
      event: 'delivered',
      variant: 'all',
      step: 1,
      templateName: 'feedback_request',
      phone: '919029130001',
      orderName: 'Test · #EL1679',
    });
    expect(input.fields.customer_first_name).toBe('Dinesh');
    // Filled from the samples where the order has nothing.
    expect(input.fields.tracking_number).toBeTruthy();
    // Never a made-up picture URL.
    expect(input.fields.product_image_url).toBeUndefined();
  });

  it('uses sample values only when asked, and the latest cart for cart reminders', async () => {
    await post({ ...BODY, source: 'sample' });
    expect(mocks.tables).not.toContain('shopify_orders');
    expect(mocks.sendTest.mock.calls[0][2].fields.customer_first_name).toBe('Priya');

    mocks.tables = [];
    await post({
      ...BODY,
      event: 'cart_reminder_1',
      step: 0,
      variable_mapping: {
        body: [
          { type: 'field', value: 'customer_first_name' },
          { type: 'field', value: 'item_summary' },
        ],
      },
    });
    expect(mocks.tables).toContain('shopify_checkouts');
  });

  it('rejects an incomplete mapping, an unapproved template or a bad number', async () => {
    expect(
      (await post({ ...BODY, variable_mapping: { body: [] } })).status
    ).toBe(400);
    expect((await post({ ...BODY, phone: 'abc' })).status).toBe(400);
    expect((await post({ ...BODY, template_name: '' })).status).toBe(400);
    mocks.resolveTemplateRow.mockResolvedValue({
      row: { ...TEMPLATE, status: 'PENDING' },
      malformed: false,
      language: 'en',
    });
    expect((await post(BODY)).status).toBe(400);
    expect(mocks.sendTest).not.toHaveBeenCalled();
  });

  it('reports why a test was not sent', async () => {
    mocks.sendTest.mockResolvedValue({
      status: 'failed',
      reason: '131042: payment issue',
    });
    const response = await post(BODY);
    expect(response.status).toBe(502);
    expect((await response.json()).outcome.reason).toBe('131042: payment issue');
  });

  it("uses the latest shipment's real tracking link for a shipment update", async () => {
    mocks.shipments = [
      {
        shopify_fulfillment_id: '5001',
        shopify_order_id: '1001',
        tracking_number: '7D139859784',
        tracking_url:
          'https://www.ithinklogistics.com/track-order-status?tracking_number=7D139859784',
        tracking_company: 'dtdc',
      },
    ];
    mocks.shipmentOrders = [
      {
        shopify_order_id: '1001',
        order_name: '#EL1650',
        fields: { customer_first_name: 'Md', order_number: '#EL1650' },
      },
    ];
    await post(BODY);
    const input = mocks.sendTest.mock.calls[0][2];
    expect(mocks.tables).toContain('shopify_fulfillments');
    expect(input.orderName).toBe('Test · #EL1650');
    expect(input.fields).toMatchObject({
      tracking_number: '7D139859784',
      tracking_url:
        'https://www.ithinklogistics.com/track-order-status?tracking_number=7D139859784',
      tracking_company: 'dtdc',
      customer_first_name: 'Md',
    });
  });

  it('prefers a shipment whose order is stored, for its picture', async () => {
    mocks.shipments = [
      {
        shopify_fulfillment_id: '5003',
        shopify_order_id: '1003',
        tracking_number: 'NEWEST',
        tracking_url: 'https://track.example/NEWEST',
        tracking_company: 'dtdc',
      },
      {
        shopify_fulfillment_id: '5002',
        shopify_order_id: '1002',
        tracking_number: 'KNOWN',
        tracking_url: 'https://track.example/KNOWN',
        tracking_company: 'dtdc',
      },
    ];
    mocks.shipmentOrders = [
      {
        shopify_order_id: '1002',
        order_name: '#EL1700',
        fields: {
          order_number: '#EL1700',
          product_image_url: 'https://cdn.shopify.com/s/files/real.jpg',
        },
      },
    ];
    await post(BODY);
    const input = mocks.sendTest.mock.calls[0][2];
    expect(input.orderName).toBe('Test · #EL1700');
    expect(input.fields).toMatchObject({
      tracking_number: 'KNOWN',
      product_image_url: 'https://cdn.shopify.com/s/files/real.jpg',
    });

    // No stored order at all: still the newest shipment.
    mocks.shipmentOrders = [];
    vi.clearAllMocks();
    mocks.sendTest.mockResolvedValue({ status: 'sent', messageId: 'm-2' });
    mocks.resolveTemplateRow.mockResolvedValue({
      row: TEMPLATE,
      malformed: false,
      language: 'en',
    });
    await post(BODY);
    expect(mocks.sendTest.mock.calls[0][2].fields.tracking_number).toBe('NEWEST');
  });

  it('does not look for a shipment for an order update', async () => {
    await post({ ...BODY, event: 'order_created', step: 0 });
    expect(mocks.tables).not.toContain('shopify_fulfillments');
  });
});
