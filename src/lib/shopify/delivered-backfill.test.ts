import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  applyTags: vi.fn(),
}));

vi.mock('./admin-api', () => ({ fetchOrderDeliveryPage: mocks.fetchPage }));
vi.mock('./auto-tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auto-tags')>()),
  applyAutoTags: mocks.applyTags,
}));

import type { ShopifyConfigRow } from './config';
import { tagDeliveredCustomersPage } from './delivered-backfill';

const db = {} as SupabaseClient;
const CONFIG = {
  account_id: 'acc-1',
  default_country_code: '91',
} as ShopifyConfigRow;

function order(over: Partial<{
  cancelled: boolean;
  delivered: boolean;
  returned: boolean;
  createdAt: string | null;
  phones: (string | null)[];
  name: string | null;
}>) {
  return {
    cancelled: false,
    delivered: true,
    returned: false,
    createdAt: '2026-09-10T19:48:30Z',
    phones: [null, '9876543210', null],
    name: 'Priya Nair',
    ...over,
  };
}

beforeEach(() => {
  mocks.fetchPage.mockReset();
  mocks.applyTags.mockReset();
});

describe('tagDeliveredCustomersPage', () => {
  it('tags each delivered, uncancelled customer once', async () => {
    mocks.fetchPage.mockResolvedValue({
      ok: true,
      nextCursor: 'cur-2',
      orders: [
        order({}),
        // Same customer again, number spelled differently.
        order({ phones: ['+91 98765 43210', null, null], name: null }),
        order({ delivered: false, phones: ['9000000001'] }),
        order({ cancelled: true, phones: ['9000000002'] }),
        order({ phones: [null, null, null] }),
        order({ phones: [null, '9123456780', null], name: 'Ravi K' }),
      ],
    });

    const result = await tagDeliveredCustomersPage(db, CONFIG, null);

    expect(result).toEqual({
      ok: true,
      scanned: 6,
      delivered: 2,
      returned: 0,
      noPhone: 1,
      oldestOrderAt: '2026-09-10T19:48:30Z',
      nextCursor: 'cur-2',
    });
    const delivered = { add: ['Order Delivered'], remove: [] };
    expect(mocks.applyTags.mock.calls).toEqual([
      [db, 'acc-1', '919876543210', 'Priya Nair', delivered],
      [db, 'acc-1', '919123456780', 'Ravi K', delivered],
    ]);
  });

  it('tags RTO customers, cancelled or not, alongside delivered ones', async () => {
    mocks.fetchPage.mockResolvedValue({
      ok: true,
      nextCursor: null,
      orders: [
        // Delivered once, RTO the next time: both tags.
        order({}),
        order({ delivered: false, returned: true, cancelled: true }),
        // Only ever RTO.
        order({
          delivered: false,
          returned: true,
          phones: ['9123456780'],
          name: 'Ravi K',
        }),
      ],
    });

    const result = await tagDeliveredCustomersPage(db, CONFIG, null);

    expect(result).toMatchObject({ ok: true, delivered: 1, returned: 2, noPhone: 0 });
    expect(mocks.applyTags.mock.calls).toEqual([
      [db, 'acc-1', '919876543210', 'Priya Nair', {
        add: ['Order Delivered', 'Order RTO'],
        remove: [],
      }],
      [db, 'acc-1', '919123456780', 'Ravi K', { add: ['Order RTO'], remove: [] }],
    ]);
  });

  it('tags only test numbers while test mode is on', async () => {
    mocks.fetchPage.mockResolvedValue({
      ok: true,
      nextCursor: null,
      orders: [order({}), order({ phones: ['9123456780'], name: 'Ravi K' })],
    });
    const result = await tagDeliveredCustomersPage(
      db,
      { ...CONFIG, test_mode: true, test_phones: ['919123456780'] },
      null
    );
    expect(result).toMatchObject({ ok: true, delivered: 1 });
    expect(mocks.applyTags.mock.calls.map((c) => c[2])).toEqual(['919123456780']);
  });

  it('reports the oldest order only on the first page', async () => {
    mocks.fetchPage.mockResolvedValue({ ok: true, nextCursor: null, orders: [order({})] });
    const result = await tagDeliveredCustomersPage(db, CONFIG, 'cur-2');
    expect(mocks.fetchPage).toHaveBeenCalledWith(db, CONFIG, 'cur-2');
    expect(result).toMatchObject({ ok: true, oldestOrderAt: null, nextCursor: null });
  });

  it('passes a Shopify error through without tagging', async () => {
    mocks.fetchPage.mockResolvedValue({ ok: false, error: 'Access denied' });
    const result = await tagDeliveredCustomersPage(db, CONFIG, null);
    expect(result).toEqual({ ok: false, error: 'Access denied' });
    expect(mocks.applyTags).not.toHaveBeenCalled();
  });
});
