import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; op: string; args: unknown[] }[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'forbidden' }, { status: 403 })
  ),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      let offset = 0;
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'gte', 'lt', 'in', 'order']) {
        builder[op] = (...args: unknown[]) => {
          mocks.filters.push({ table, op, args });
          return builder;
        };
      }
      builder.range = (from: number) => {
        offset = from;
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve({
          data: (mocks.tables[table] ?? []).slice(offset, offset + 1000),
          error: null,
        });
      return builder;
    },
  }),
}));

import { GET } from './route';

function charge(id: string, extra: Record<string, unknown> = {}) {
  return {
    id: `c-${id}`,
    whatsapp_message_id: `wamid.${id}`,
    recipient: '919029130001',
    status: 'delivered',
    pricing_category: 'utility',
    pricing_type: 'regular',
    billable: true,
    pricing_source: 'meta',
    sent_at: '2026-10-16T10:00:00Z',
    delivered_at: '2026-10-16T10:00:05Z',
    read_at: null,
    failed_at: null,
    error_code: null,
    error_title: null,
    created_at: '2026-10-16T10:00:00Z',
    ...extra,
  };
}

function get(query = '') {
  return GET(new Request(`http://localhost/api/billing/transactions${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.filters = [];
  mocks.requireRole.mockResolvedValue({ accountId: 'acct-1', role: 'admin' });
  mocks.tables = {
    message_charges: [
      charge('1'),
      charge('2', { pricing_category: 'marketing', status: 'read' }),
      charge('3', { status: 'failed', pricing_category: 'marketing' }),
      charge('4', { pricing_category: 'service', billable: false }),
    ],
    messages: [
      {
        message_id: 'wamid.1',
        template_name: 'order_delivered_utility',
        content_type: 'template',
        sender_type: 'bot',
        conversation_id: 'conv-1',
      },
      {
        message_id: 'wamid.4',
        template_name: null,
        content_type: 'text',
        sender_type: 'agent',
        conversation_id: 'conv-1',
      },
    ],
    shopify_notifications: [
      {
        whatsapp_message_id: 'wamid.1',
        event: 'delivered',
        step: 1,
        order_name: '#EL1700',
        is_test: false,
      },
    ],
    broadcast_recipients: [
      { whatsapp_message_id: 'wamid.2', contact_id: 'ct-1', broadcast_id: 'b-1' },
    ],
    conversations: [{ id: 'conv-1', contact_id: 'ct-1' }],
    broadcasts: [{ id: 'b-1', name: 'Diwali sale', template_name: 'diwali_offer' }],
    contacts: [{ id: 'ct-1', name: 'Arun', phone: '919029130001' }],
  };
});

describe('GET /api/billing/transactions', () => {
  it('is for admins only', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await get()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('totals the period and only charges delivered billable messages', async () => {
    const body = await (await get()).json();
    expect(body.total).toBe(4);
    expect(body.summary).toMatchObject({
      messages: 4,
      billable: 2,
      by_status: { delivered: 2, read: 1, failed: 1 },
      amount_inr: 0.98,
      gst_inr: 0.18,
      total_inr: 1.15,
    });
    expect(body.summary.by_category.marketing).toEqual({
      count: 2,
      billable: 1,
      amount_inr: 0.86,
    });
    // Scoped to the caller's account.
    expect(mocks.filters).toContainEqual({
      table: 'message_charges',
      op: 'eq',
      args: ['account_id', 'acct-1'],
    });
  });

  it('says where each message came from', async () => {
    const { transactions } = await (await get()).json();
    const byId = Object.fromEntries(
      transactions.map((t: { whatsapp_message_id: string }) => [t.whatsapp_message_id, t])
    );
    expect(byId['wamid.1']).toMatchObject({
      source: 'shopify',
      source_detail: 'delivered#1',
      order_name: '#EL1700',
      template_name: 'order_delivered_utility',
      contact_name: 'Arun',
      amount_inr: 0.115,
    });
    expect(byId['wamid.2']).toMatchObject({
      source: 'broadcast',
      source_detail: 'Diwali sale',
      template_name: 'diwali_offer',
      amount_inr: 0.8631,
    });
    expect(byId['wamid.3']).toMatchObject({ source: 'other', amount_inr: 0 });
    expect(byId['wamid.4']).toMatchObject({ source: 'inbox', amount_inr: 0 });
  });

  it('passes valid filters through and downloads every row as CSV', async () => {
    await get('?status=read&category=marketing&from=2026-10-01&to=2026-10-16');
    expect(mocks.filters).toContainEqual({
      table: 'message_charges',
      op: 'eq',
      args: ['status', 'read'],
    });
    expect(mocks.filters).toContainEqual({
      table: 'message_charges',
      op: 'eq',
      args: ['pricing_category', 'marketing'],
    });
    expect(mocks.filters).toContainEqual({
      table: 'message_charges',
      op: 'lt',
      args: ['created_at', '2026-10-17T00:00:00.000Z'],
    });

    mocks.filters = [];
    await get('?status=bogus&category=DROP%20TABLE');
    expect(
      mocks.filters.filter((f) => f.table === 'message_charges' && f.op === 'eq')
    ).toEqual([{ table: 'message_charges', op: 'eq', args: ['account_id', 'acct-1'] }]);

    const res = await get('?format=csv&from=2026-10-01&to=2026-10-16');
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain(
      'whatsapp-transactions-2026-10-01-to-2026-10-16.csv'
    );
    expect((await res.text()).trimEnd().split('\r\n')).toHaveLength(5);
  });
});
