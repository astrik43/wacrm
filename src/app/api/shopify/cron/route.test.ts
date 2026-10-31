import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), retry: vi.fn(), backfill: vi.fn() }));

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/shopify/scheduled', () => ({ runDueNotifications: mocks.run }));
vi.mock('@/lib/shopify/cod-confirm', () => ({ retryCodTags: mocks.retry }));
vi.mock('@/lib/shopify/backfill-buttons', () => ({
  backfillTemplateButtons: mocks.backfill,
}));

import { GET } from './route';

function call(secret?: string) {
  return GET(
    new Request('http://localhost/api/shopify/cron', {
      headers: secret === undefined ? {} : { 'x-cron-secret': secret },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret');
  mocks.run.mockResolvedValue({ due: 2, sent: 2, cancelled: 0, skipped: 0, failed: 0 });
  mocks.retry.mockResolvedValue({ retried: 1, synced: 1 });
  mocks.backfill.mockResolvedValue({ filled: 3 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/shopify/cron', () => {
  it('is off until a secret is configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    expect((await call('anything')).status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong secret', async () => {
    expect((await call()).status).toBe(401);
    expect((await call('wrong')).status).toBe(401);
    expect((await call('cron-secreT')).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('sends what is due and retries order tags', async () => {
    const response = await call('cron-secret');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      notifications: { due: 2, sent: 2, cancelled: 0, skipped: 0, failed: 0 },
      tags: { retried: 1, synced: 1 },
      backfill: { filled: 3 },
    });
  });

  it('a failing button backfill does not fail the sends', async () => {
    mocks.backfill.mockRejectedValue(new Error('db down'));
    const response = await call('cron-secret');
    expect(response.status).toBe(200);
    expect((await response.json()).backfill).toEqual({ filled: 0 });
  });

  it('a failing tag retry does not fail the sends', async () => {
    mocks.retry.mockRejectedValue(new Error('db down'));
    const response = await call('cron-secret');
    expect(response.status).toBe(200);
    expect((await response.json()).tags).toEqual({ retried: 0, synced: 0 });
  });

  it('reports a failed run', async () => {
    mocks.run.mockRejectedValue(new Error('db down'));
    expect((await call('cron-secret')).status).toBe(500);
  });
});
