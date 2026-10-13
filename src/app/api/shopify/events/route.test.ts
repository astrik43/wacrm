import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  resolveTemplateRow: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: mocks.resolveTemplateRow,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { GET, PUT } from './route';

const TEMPLATE = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_confirmed',
  category: 'Utility',
  language: 'en',
  body_text: 'Hi {{1}}, order {{2}} is confirmed.',
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
};

const MAPPING = {
  body: [
    { type: 'field', value: 'customer_first_name' },
    { type: 'field', value: 'order_number' },
  ],
};

let rows: Record<string, unknown>[];
let upserts: Record<string, unknown>[];

function fakeSupabase() {
  return {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        upsert: (row: Record<string, unknown>) => {
          upserts.push(row);
          return builder;
        },
        single: async () => ({ data: upserts.at(-1), error: null }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/shopify/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  rows = [];
  upserts = [];
  vi.clearAllMocks();
  const ctx = { supabase: fakeSupabase(), accountId: 'acct-1', userId: 'u-1', role: 'admin' };
  mocks.getCurrentAccount.mockResolvedValue(ctx);
  mocks.requireRole.mockResolvedValue(ctx);
  mocks.resolveTemplateRow.mockResolvedValue({
    row: TEMPLATE,
    malformed: false,
    language: 'en',
  });
});

describe('/api/shopify/events', () => {
  it('GET lists every update and variant, defaulting the unconfigured ones to off', async () => {
    rows = [
      {
        event: 'delivered',
        variant: 'cod',
        delay_minutes: 15,
        is_enabled: true,
        template_name: 'order_delivered',
        template_language: 'en',
        variable_mapping: { body: [] },
        updated_at: '2026-10-12T00:00:00Z',
      },
    ];
    const { events } = await (await GET()).json();
    // Six order updates in three variants, three cart reminders in one.
    expect(events).toHaveLength(21);
    const find = (event: string, variant: string) =>
      events.find(
        (e: { event: string; variant: string }) =>
          e.event === event && e.variant === variant
      );
    expect(find('delivered', 'cod')).toMatchObject({
      is_enabled: true,
      template_name: 'order_delivered',
      delay_minutes: 15,
    });
    expect(find('delivered', 'all')).toMatchObject({
      is_enabled: false,
      delay_minutes: 0,
    });
    expect(find('cart_reminder_1', 'all')).toBeDefined();
    expect(find('cart_reminder_1', 'cod')).toBeUndefined();
    expect(
      events.find((e: { event: string }) => e.event === 'order_created')
    ).toMatchObject({ is_enabled: false, template_name: null });
  });

  it('PUT requires admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await put({ event: 'delivered' })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('PUT rejects an unknown update and enabling without a template', async () => {
    expect((await put({ event: 'refunded' })).status).toBe(400);
    expect((await put({ event: 'delivered', is_enabled: true })).status).toBe(400);
    expect(upserts).toEqual([]);
  });

  it('PUT rejects a template Meta has not approved', async () => {
    mocks.resolveTemplateRow.mockResolvedValue({
      row: { ...TEMPLATE, status: 'PENDING' },
      malformed: false,
      language: 'en',
    });
    const response = await put({
      event: 'order_created',
      is_enabled: true,
      template_name: 'order_confirmed',
      variable_mapping: MAPPING,
    });
    expect(response.status).toBe(400);
    expect(upserts).toEqual([]);
  });

  it('PUT rejects an incomplete mapping and names the slots', async () => {
    const response = await put({
      event: 'order_created',
      is_enabled: true,
      template_name: 'order_confirmed',
      variable_mapping: { body: [MAPPING.body[0]] },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).problems).toEqual(['unmapped:body_2']);
    expect(upserts).toEqual([]);
  });

  it('PUT saves a complete, approved mapping', async () => {
    const response = await put({
      event: 'order_created',
      is_enabled: true,
      template_name: 'order_confirmed',
      template_language: 'en',
      variable_mapping: MAPPING,
    });
    expect(response.status).toBe(200);
    expect(upserts[0]).toEqual({
      account_id: 'acct-1',
      event: 'order_created',
      variant: 'all',
      delay_minutes: 0,
      is_enabled: true,
      template_name: 'order_confirmed',
      template_language: 'en',
      variable_mapping: MAPPING,
    });
  });

  it('PUT saves a COD template with a delay as its own variant', async () => {
    const response = await put({
      event: 'order_created',
      variant: 'cod',
      delay_minutes: 30,
      is_enabled: true,
      template_name: 'order_confirmed',
      template_language: 'en',
      variable_mapping: MAPPING,
    });
    expect(response.status).toBe(200);
    expect(upserts[0]).toMatchObject({ variant: 'cod', delay_minutes: 30 });
  });

  it('PUT rejects a bad variant or delay', async () => {
    const base = {
      event: 'order_created',
      template_name: 'order_confirmed',
      variable_mapping: MAPPING,
    };
    expect((await put({ ...base, variant: 'upi' })).status).toBe(400);
    // A cart has no payment mode yet.
    expect((await put({ event: 'cart_reminder_1', variant: 'cod' })).status).toBe(400);
    for (const delay_minutes of [-1, 1.5, 43201, '30']) {
      expect((await put({ ...base, delay_minutes })).status).toBe(400);
    }
    expect(upserts).toEqual([]);
  });

  it('PUT only switches a cart reminder on with a real delay', async () => {
    mocks.resolveTemplateRow.mockResolvedValue({
      row: { ...TEMPLATE, body_text: 'You left something behind.' },
      malformed: false,
      language: 'en',
    });
    const base = {
      event: 'cart_reminder_1',
      is_enabled: true,
      template_name: 'order_confirmed',
      variable_mapping: { body: [] },
    };
    expect((await put({ ...base, delay_minutes: 5 })).status).toBe(400);
    expect(upserts).toEqual([]);

    expect((await put({ ...base, delay_minutes: 30 })).status).toBe(200);
    expect(upserts[0]).toMatchObject({
      event: 'cart_reminder_1',
      variant: 'all',
      delay_minutes: 30,
    });
  });
});
