import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  fulfillments: [] as Record<string, unknown>[],
  orders: [] as Record<string, unknown>[],
  orderFields: null as Record<string, unknown> | null,
  limited: false,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !db.limited }),
  RATE_LIMITS: { publicLink: {} },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        limit: async () => ({
          data: table === 'shopify_fulfillments' ? db.fulfillments : db.orders,
          error: null,
        }),
        maybeSingle: async () => ({
          data: db.orderFields ? { fields: db.orderFields } : null,
          error: null,
        }),
      };
      return builder;
    },
  }),
}));

import { makeLinkCode } from '@/lib/shopify/link-codes';
import { GET } from './route';

const TRACK = 'https://www.ithinklogistics.com/track-order-status?tracking_number=7D139859784';
const STATUS = 'https://estelleluxe.in/72364876001/orders/abc/authenticate?key=xyz';

function open(code: string) {
  return GET(new Request(`https://crm.test/r/${code}`), {
    params: Promise.resolve({ code }),
  });
}

beforeEach(() => {
  db.fulfillments = [];
  db.orders = [];
  db.orderFields = null;
  db.limited = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /r/<code>', () => {
  it("sends a tracking code to the shipment's tracking link as it is now", async () => {
    db.fulfillments = [
      { account_id: 'acct-1', shopify_order_id: '1001', tracking_url: TRACK },
    ];
    const res = await open(makeLinkCode('t', 'acct-1', '555')!);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TRACK);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('falls back to the order page while there is no tracking link yet', async () => {
    db.fulfillments = [
      { account_id: 'acct-1', shopify_order_id: '1001', tracking_url: null },
    ];
    db.orderFields = { order_status_url: STATUS };
    const res = await open(makeLinkCode('t', 'acct-1', '555')!);
    expect(res.headers.get('location')).toBe(STATUS);
  });

  it("sends an order code to the order's status page", async () => {
    db.orders = [{ account_id: 'acct-1' }];
    db.orderFields = { order_status_url: STATUS };
    const res = await open(makeLinkCode('s', 'acct-1', '1001')!);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(STATUS);
  });

  it('never redirects a code signed for another account, a bad code, or a non-web link', async () => {
    db.fulfillments = [
      { account_id: 'acct-2', shopify_order_id: '1001', tracking_url: TRACK },
    ];
    expect((await open(makeLinkCode('t', 'acct-1', '555')!)).status).toBe(404);
    expect((await open('t555.AAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await open('nonsense')).status).toBe(404);

    db.fulfillments = [
      { account_id: 'acct-1', shopify_order_id: null, tracking_url: 'javascript:alert(1)' },
    ];
    const res = await open(makeLinkCode('t', 'acct-1', '555')!);
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain("isn't available yet");
  });

  it('answers 429 when one address opens too many links', async () => {
    db.limited = true;
    expect((await open(makeLinkCode('t', 'acct-1', '555')!)).status).toBe(429);
  });
});
