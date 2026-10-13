import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ addOrderTags: vi.fn(), getConfig: vi.fn() }));

vi.mock('./admin-api', () => ({ addOrderTags: mocks.addOrderTags }));
vi.mock('./config', () => ({ getShopifyConfigByAccount: mocks.getConfig }));

import { decideCodOrder, loadCodOrder, retryCodTags } from './cod-confirm';

const TOKEN = 'Zk3vX9aQ2mLw8RtY5uHc1BnE7pJd4GsF';

const ORDER = {
  account_id: 'acct-1',
  shopify_order_id: '1001',
  order_name: '#1042',
  customer_name: 'Priya Nair',
  fields: { order_total: '1599.00' },
  cancelled_at: null,
  cod_decision: null,
};

interface FakeState {
  /** What a lookup by token returns. */
  order: Record<string, unknown> | null;
  /** Rows the conditional decision update returns; [] = lost the race. */
  decisionRows: { id: string }[];
  pendingTags: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  lookups: number;
}

function fakeDb(state: FakeState): SupabaseClient {
  return {
    from() {
      const reads: Record<string, unknown> = {
        eq: () => reads,
        not: () => reads,
        is: () => reads,
        lte: () => reads,
        gte: () => reads,
        order: () => reads,
        limit: async () => ({ data: state.pendingTags, error: null }),
        maybeSingle: async () => {
          state.lookups++;
          return { data: state.order, error: null };
        },
      };
      return {
        select: () => reads,
        update: (patch: Record<string, unknown>) => {
          state.updates.push(patch);
          const chain: Record<string, unknown> = {
            eq: () => chain,
            is: () => chain,
            select: async () => ({ data: state.decisionRows, error: null }),
            then: (resolve: (r: { error: null }) => unknown) =>
              resolve({ error: null }),
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    order: ORDER,
    decisionRows: [{ id: 'row-1' }],
    pendingTags: [],
    updates: [],
    lookups: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getConfig.mockResolvedValue({ id: 'cfg-1' });
  mocks.addOrderTags.mockResolvedValue({ ok: true });
});

describe('loadCodOrder', () => {
  it('finds the order a link points at', async () => {
    expect(await loadCodOrder(fakeDb(freshState()), TOKEN)).toMatchObject({
      accountId: 'acct-1',
      orderId: '1001',
      orderName: '#1042',
      decision: null,
    });
  });

  it('never queries for something that cannot be a token', async () => {
    const state = freshState();
    for (const bad of ['', 'short', '../../etc/passwd', 'a b c d e f g h i j k l']) {
      expect(await loadCodOrder(fakeDb(state), bad)).toBeNull();
    }
    expect(state.lookups).toBe(0);
  });
});

describe('decideCodOrder', () => {
  it('records a confirmation and tags the Shopify order', async () => {
    const state = freshState();
    expect(await decideCodOrder(fakeDb(state), TOKEN, 'confirmed')).toEqual({
      status: 'recorded',
      decision: 'confirmed',
    });
    expect(state.updates[0]).toMatchObject({ cod_decision: 'confirmed' });
    expect(mocks.addOrderTags).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'cfg-1' },
      '1001',
      ['COD confirmed']
    );
    expect(state.updates[1]).toMatchObject({ cod_tag_error: null });
    expect(state.updates[1].cod_tag_synced_at).toEqual(expect.any(String));
  });

  it('a cancellation adds its own tag', async () => {
    await decideCodOrder(fakeDb(freshState()), TOKEN, 'cancelled');
    expect(mocks.addOrderTags.mock.calls[0][3]).toEqual(['cancelled by WA CRM']);
  });

  it('keeps the decision when Shopify does not take the tag', async () => {
    mocks.addOrderTags.mockResolvedValue({
      ok: false,
      error: 'missing_write_orders_scope',
    });
    const state = freshState();
    expect(await decideCodOrder(fakeDb(state), TOKEN, 'confirmed')).toEqual({
      status: 'recorded',
      decision: 'confirmed',
    });
    expect(state.updates[1]).toEqual({
      cod_tag_error: 'missing_write_orders_scope',
    });
  });

  it('only the first answer counts', async () => {
    const answered = freshState({ order: { ...ORDER, cod_decision: 'cancelled' } });
    expect(await decideCodOrder(fakeDb(answered), TOKEN, 'confirmed')).toEqual({
      status: 'already_decided',
      decision: 'cancelled',
    });
    expect(answered.updates).toEqual([]);
    expect(mocks.addOrderTags).not.toHaveBeenCalled();
  });

  it('a press that loses the race changes nothing', async () => {
    const state = freshState({ decisionRows: [] });
    const result = await decideCodOrder(fakeDb(state), TOKEN, 'confirmed');
    expect(result.status).not.toBe('recorded');
    expect(mocks.addOrderTags).not.toHaveBeenCalled();
  });

  it('refuses an unknown link and an order already cancelled in Shopify', async () => {
    expect(
      await decideCodOrder(fakeDb(freshState({ order: null })), TOKEN, 'confirmed')
    ).toEqual({ status: 'not_found' });

    const cancelled = freshState({
      order: { ...ORDER, cancelled_at: '2026-10-12T05:30:00.000Z' },
    });
    expect(await decideCodOrder(fakeDb(cancelled), TOKEN, 'confirmed')).toEqual({
      status: 'order_cancelled',
    });
    expect(cancelled.updates).toEqual([]);
  });
});

describe('retryCodTags', () => {
  it('re-sends the tag for decisions Shopify has not taken yet', async () => {
    mocks.addOrderTags
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'shopify_http_503' });
    const state = freshState({
      pendingTags: [
        { account_id: 'acct-1', shopify_order_id: '1', cod_decision: 'confirmed' },
        { account_id: 'acct-1', shopify_order_id: '2', cod_decision: 'cancelled' },
      ],
    });
    expect(await retryCodTags(fakeDb(state))).toEqual({ retried: 2, synced: 1 });
    expect(mocks.addOrderTags.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['1', ['COD confirmed']],
      ['2', ['cancelled by WA CRM']],
    ]);
  });
});
