import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveTemplateRow: vi.fn(),
  sendTest: vi.fn(),
  latest: null as Record<string, unknown> | null,
  shipment: null as Record<string, unknown> | null,
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
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        not: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({
          data:
            table === 'shopify_configs'
              ? { default_country_code: '91' }
              : table === 'shopify_fulfillments'
                ? mocks.shipment
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
  mocks.shipment = null;
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
    mocks.shipment = {
      shopify_order_id: '1001',
      tracking_number: '7D139859784',
      tracking_url:
        'https://www.ithinklogistics.com/track-order-status?tracking_number=7D139859784',
      tracking_company: 'dtdc',
    };
    mocks.latest = {
      order_name: '#EL1650',
      fields: { customer_first_name: 'Md', order_number: '#EL1650' },
    };
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

  it('does not look for a shipment for an order update', async () => {
    await post({ ...BODY, event: 'order_created', step: 0 });
    expect(mocks.tables).not.toContain('shopify_fulfillments');
  });

  it("never sends a real order's COD confirmation code", async () => {
    mocks.latest = {
      order_name: '#EL1700',
      fields: {
        customer_first_name: 'Asha',
        order_number: '#EL1700',
        cod_confirm_token: 'real-customer-token-0123456789ab',
        cod_confirm_url: 'https://crm.test/o/real-customer-token-0123456789ab',
      },
    };
    await post({ ...BODY, event: 'order_created', step: 0 });
    const fields = mocks.sendTest.mock.calls[0][2].fields;
    expect(fields.customer_first_name).toBe('Asha');
    expect(fields.cod_confirm_token).not.toBe('real-customer-token-0123456789ab');
    expect(fields.cod_confirm_url).not.toContain('real-customer-token');
  });
});
