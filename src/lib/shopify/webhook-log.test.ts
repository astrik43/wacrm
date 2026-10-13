import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  finishWebhookEvent,
  orderRefOf,
  recordWebhookEvent,
} from './webhook-log';

interface FakeState {
  inserts: Record<string, unknown>[];
  updates: { patch: Record<string, unknown>; id: unknown }[];
  prunes: { accountId: unknown; before: unknown }[];
  insertError: { message: string } | null;
}

let state: FakeState;

function fakeDb(): SupabaseClient {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        state.inserts.push(row);
        return {
          select: () => ({
            single: async () =>
              state.insertError
                ? { data: null, error: state.insertError }
                : { data: { id: 'log-1' }, error: null },
          }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          state.updates.push({ patch, id });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: (_col: string, accountId: unknown) => ({
          lt: async (_c: string, before: unknown) => {
            state.prunes.push({ accountId, before });
            return { error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const BASE = {
  account_id: 'acct-1',
  topic: 'orders/create',
  shopify_webhook_id: 'wh-1',
  shop_domain: 'acme.myshopify.com',
};

beforeEach(() => {
  state = { inserts: [], updates: [], prunes: [], insertError: null };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordWebhookEvent', () => {
  it('stores the delivery and prunes rows older than 30 days', async () => {
    const id = await recordWebhookEvent(fakeDb(), {
      ...BASE,
      status: 'received',
      order_ref: '#1042',
      payload: { id: 1 },
    });

    expect(id).toBe('log-1');
    expect(state.inserts[0]).toEqual({
      ...BASE,
      status: 'received',
      detail: null,
      order_ref: '#1042',
      payload: { id: 1 },
    });
    expect(state.prunes).toHaveLength(1);
    expect(state.prunes[0].accountId).toBe('acct-1');
    const ageDays =
      (Date.now() - Date.parse(String(state.prunes[0].before))) / 86_400_000;
    expect(ageDays).toBeCloseTo(30, 1);
  });

  it('drops an oversized payload but keeps the row', async () => {
    await recordWebhookEvent(fakeDb(), {
      ...BASE,
      status: 'received',
      payload: { blob: 'x'.repeat(300 * 1024) },
    });
    expect(state.inserts[0]).toMatchObject({
      payload: null,
      detail: 'payload_too_large_to_store',
    });
  });

  it('returns null instead of throwing when the write fails', async () => {
    state.insertError = { message: 'relation does not exist' };
    expect(
      await recordWebhookEvent(fakeDb(), { ...BASE, status: 'received' })
    ).toBeNull();

    const broken = {
      from: () => {
        throw new Error('down');
      },
    } as unknown as SupabaseClient;
    expect(
      await recordWebhookEvent(broken, { ...BASE, status: 'received' })
    ).toBeNull();
  });
});

describe('finishWebhookEvent', () => {
  it('records the outcome on the logged row', async () => {
    await finishWebhookEvent(fakeDb(), 'log-1', {
      status: 'processed',
      detail: null,
      order_ref: '#1042',
      outcome: [{ event: 'order_created', status: 'sent' }],
    });
    expect(state.updates).toEqual([
      {
        id: 'log-1',
        patch: {
          status: 'processed',
          detail: null,
          order_ref: '#1042',
          outcome: [{ event: 'order_created', status: 'sent' }],
        },
      },
    ]);
  });

  it('clips a long error message and does nothing without a row', async () => {
    await finishWebhookEvent(fakeDb(), 'log-1', {
      status: 'error',
      detail: 'e'.repeat(900),
    });
    expect(String(state.updates[0].patch.detail)).toHaveLength(500);

    await finishWebhookEvent(fakeDb(), null, { status: 'processed' });
    expect(state.updates).toHaveLength(1);
  });
});

describe('orderRefOf', () => {
  it('reads the order or fulfillment name', () => {
    expect(orderRefOf({ name: '#1042' })).toBe('#1042');
    expect(orderRefOf({ name: '  ' })).toBeNull();
    expect(orderRefOf({})).toBeNull();
    expect(orderRefOf(null)).toBeNull();
  });
});
