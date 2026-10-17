import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('web-push', () => ({ default: { sendNotification: mocks.send } }));

import { sendPushToAccount, vapidConfig } from './web-push';

interface Calls {
  filters: unknown[][];
  deleted: unknown[];
  touched: unknown[];
}

function fakeDb(rows: Record<string, string>[], calls: Calls): SupabaseClient {
  return {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (...args: unknown[]) => {
          calls.filters.push(args);
          return builder;
        },
        delete: () => ({
          in: async (_c: string, ids: unknown) => {
            calls.deleted.push(ids);
            return { error: null };
          },
        }),
        update: () => ({
          in: async (_c: string, ids: unknown) => {
            calls.touched.push(ids);
            return { error: null };
          },
        }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const ROWS = [
  { id: 's-1', endpoint: 'https://push.example/a', p256dh: 'pk-a', auth: 'au-a' },
  { id: 's-2', endpoint: 'https://push.example/b', p256dh: 'pk-b', auth: 'au-b' },
];
const PAYLOAD = { title: 'Priya', body: 'Hi', url: '/inbox?c=1', tag: 'conv-1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VAPID_PUBLIC_KEY', 'pub');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.com');
});
afterEach(() => vi.unstubAllEnvs());

describe('sendPushToAccount', () => {
  it("sends to every device in the account and drops ones the push service says are gone", async () => {
    mocks.send
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    const calls: Calls = { filters: [], deleted: [], touched: [] };
    const sent = await sendPushToAccount(fakeDb(ROWS, calls), 'acct-1', PAYLOAD);

    expect(sent).toBe(1);
    expect(calls.filters).toContainEqual(['account_id', 'acct-1']);
    expect(mocks.send).toHaveBeenCalledWith(
      { endpoint: 'https://push.example/a', keys: { p256dh: 'pk-a', auth: 'au-a' } },
      JSON.stringify(PAYLOAD),
      expect.objectContaining({
        vapidDetails: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' },
        urgency: 'high',
        topic: 'conv-1',
      })
    );
    expect(calls.deleted).toEqual([['s-2']]);
    expect(calls.touched).toEqual([['s-1']]);
  });

  it("keeps a device after a temporary failure, and can target one user's devices", async () => {
    mocks.send.mockRejectedValue(Object.assign(new Error('busy'), { statusCode: 503 }));
    const calls: Calls = { filters: [], deleted: [], touched: [] };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sent = await sendPushToAccount(fakeDb(ROWS.slice(0, 1), calls), 'acct-1', PAYLOAD, {
        userId: 'u-1',
      });
      expect(sent).toBe(0);
    } finally {
      error.mockRestore();
    }
    expect(calls.filters).toContainEqual(['user_id', 'u-1']);
    expect(calls.deleted).toEqual([]);
  });

  it('is off without VAPID keys', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    expect(vapidConfig()).toBeNull();
    const calls: Calls = { filters: [], deleted: [], touched: [] };
    expect(await sendPushToAccount(fakeDb(ROWS, calls), 'acct-1', PAYLOAD)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
