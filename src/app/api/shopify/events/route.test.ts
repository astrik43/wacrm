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
  it('GET lists all six updates, defaulting the unconfigured ones to off', async () => {
    rows = [
      {
        event: 'delivered',
        is_enabled: true,
        template_name: 'order_delivered',
        template_language: 'en',
        variable_mapping: { body: [] },
        updated_at: '2026-10-12T00:00:00Z',
      },
    ];
    const { events } = await (await GET()).json();
    expect(events).toHaveLength(6);
    expect(events.find((e: { event: string }) => e.event === 'delivered')).toMatchObject({
      is_enabled: true,
      template_name: 'order_delivered',
    });
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
      is_enabled: true,
      template_name: 'order_confirmed',
      template_language: 'en',
      variable_mapping: MAPPING,
    });
  });
});
