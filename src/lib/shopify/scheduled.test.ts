import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), pick: vi.fn() }));

vi.mock('./notify', () => ({
  deliverNotification: mocks.deliver,
  pickEventTemplate: mocks.pick,
}));

import { runDueNotifications } from './scheduled';

const EVENT_ROW = { variant: 'all', is_enabled: true, template_name: 'tpl' };

const ORDER_ROW = {
  id: 'n-1',
  account_id: 'acct-1',
  event: 'order_created',
  shopify_order_id: '1001',
  shopify_checkout_id: null,
  payload: {
    phone: '919876543210',
    customerName: 'Priya Nair',
    fields: { order_number: '#1042' },
    paymentMode: 'cod',
  },
};

const CART_ROW = {
  id: 'n-2',
  account_id: 'acct-1',
  event: 'cart_reminder_1',
  shopify_order_id: null,
  shopify_checkout_id: '777',
  payload: {
    phone: '919876543210',
    customerName: 'Priya Nair',
    fields: { item_summary: 'Old cart' },
    paymentMode: null,
  },
};

interface FakeState {
  due: Record<string, unknown>[];
  /** Ids another cron run already took. */
  alreadyClaimed: string[];
  order: Record<string, unknown> | null;
  checkout: Record<string, unknown> | null;
  /** Orders from the cart's phone since the checkout. */
  ordersSince: { id: string }[];
  updates: { id: unknown; patch: Record<string, unknown> }[];
}

function fakeDb(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const reads: Record<string, unknown> = {
        eq: () => reads,
        lte: () => reads,
        gte: () => reads,
        order: () => reads,
        limit: async () => ({
          data: table === 'shopify_notifications' ? state.due : state.ordersSince,
          error: null,
        }),
        maybeSingle: async () => ({
          data: table === 'shopify_checkouts' ? state.checkout : state.order,
          error: null,
        }),
      };
      return {
        select: () => reads,
        update: (patch: Record<string, unknown>) => {
          const entry = { id: undefined as unknown, patch };
          state.updates.push(entry);
          const chain: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              if (column === 'id') entry.id = value;
              return chain;
            },
            select: () => chain,
            // The claim: scheduled → pending, unless someone beat us.
            maybeSingle: async () => ({
              data: state.alreadyClaimed.includes(String(entry.id))
                ? null
                : { id: entry.id },
              error: null,
            }),
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
    due: [ORDER_ROW],
    alreadyClaimed: [],
    order: { cancelled_at: null },
    checkout: null,
    ordersSince: [],
    updates: [],
    ...overrides,
  };
}

/** The patches written to one notification, after its claim. */
function outcomeOf(state: FakeState, id: string) {
  return state.updates.filter((u) => u.id === id).map((u) => u.patch).slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.pick.mockResolvedValue({ row: EVENT_ROW, error: false });
  mocks.deliver.mockResolvedValue({ status: 'sent', messageId: 'm' });
});

describe('runDueNotifications', () => {
  it('claims a due update and sends it with the current template settings', async () => {
    const state = freshState();
    const summary = await runDueNotifications(fakeDb(state));

    expect(summary).toMatchObject({ due: 1, sent: 1, cancelled: 0 });
    expect(state.updates[0]).toEqual({ id: 'n-1', patch: { status: 'pending' } });
    expect(mocks.pick).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'order_created',
      'cod'
    );
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'n-1',
      EVENT_ROW,
      {
        event: 'order_created',
        orderId: '1001',
        phone: '919876543210',
        customerName: 'Priya Nair',
        fields: { order_number: '#1042' },
      }
    );
  });

  it('does not send what another run already claimed', async () => {
    const state = freshState({ alreadyClaimed: ['n-1'] });
    const summary = await runDueNotifications(fakeDb(state));
    expect(summary.sent).toBe(0);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('cancels an update whose order was cancelled meanwhile', async () => {
    const state = freshState({ order: { cancelled_at: '2026-10-13T05:00:00.000Z' } });
    const summary = await runDueNotifications(fakeDb(state));
    expect(summary).toMatchObject({ sent: 0, cancelled: 1 });
    expect(outcomeOf(state, 'n-1')).toEqual([
      { status: 'cancelled', reason: 'order_cancelled', payload: null },
    ]);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('still sends a delayed cancellation notice for a cancelled order', async () => {
    const state = freshState({
      due: [{ ...ORDER_ROW, event: 'order_cancelled' }],
      order: { cancelled_at: '2026-10-13T05:00:00.000Z' },
    });
    expect((await runDueNotifications(fakeDb(state))).sent).toBe(1);
  });

  it('cancels an update that was switched off meanwhile', async () => {
    mocks.pick.mockResolvedValue({ row: null, error: false });
    const state = freshState();
    expect((await runDueNotifications(fakeDb(state))).cancelled).toBe(1);
    expect(outcomeOf(state, 'n-1')).toEqual([
      { status: 'cancelled', reason: 'event_disabled', payload: null },
    ]);
  });

  it('puts an update back when the settings cannot be read', async () => {
    mocks.pick.mockResolvedValue({ row: null, error: true });
    const state = freshState();
    await runDueNotifications(fakeDb(state));
    expect(outcomeOf(state, 'n-1')).toEqual([{ status: 'scheduled' }]);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('counts what could not be sent', async () => {
    mocks.deliver.mockResolvedValue({ status: 'skipped', reason: 'no_phone' });
    expect((await runDueNotifications(fakeDb(freshState()))).skipped).toBe(1);

    mocks.deliver.mockRejectedValue(new Error('boom'));
    const state = freshState();
    expect((await runDueNotifications(fakeDb(state))).failed).toBe(1);
    expect(outcomeOf(state, 'n-1')).toEqual([
      { status: 'failed', reason: 'boom', payload: null },
    ]);
  });
});

describe('runDueNotifications — cart reminders', () => {
  const CHECKOUT = {
    completed_at: null,
    created_at: '2026-10-13T04:00:00.000Z',
    fields: { item_summary: 'Heritage Watch × 1' },
  };

  it('sends with the cart as it is now, and no payment mode', async () => {
    const state = freshState({ due: [CART_ROW], checkout: CHECKOUT });
    expect((await runDueNotifications(fakeDb(state))).sent).toBe(1);
    expect(mocks.pick).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'cart_reminder_1',
      null
    );
    expect(mocks.deliver.mock.calls[0][4]).toMatchObject({
      orderId: null,
      fields: { item_summary: 'Heritage Watch × 1' },
    });
  });

  it('cancels when the checkout was completed', async () => {
    const state = freshState({
      due: [CART_ROW],
      checkout: { ...CHECKOUT, completed_at: '2026-10-13T04:30:00.000Z' },
    });
    await runDueNotifications(fakeDb(state));
    expect(outcomeOf(state, 'n-2')).toEqual([
      { status: 'cancelled', reason: 'checkout_completed', payload: null },
    ]);
  });

  it('cancels when the same phone has ordered since', async () => {
    const state = freshState({
      due: [CART_ROW],
      checkout: CHECKOUT,
      ordersSince: [{ id: 'o-1' }],
    });
    await runDueNotifications(fakeDb(state));
    expect(outcomeOf(state, 'n-2')).toEqual([
      { status: 'cancelled', reason: 'order_placed', payload: null },
    ]);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
