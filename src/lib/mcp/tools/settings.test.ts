import { afterEach, describe, expect, it, vi } from 'vitest';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

import { runTool, type CallerContext } from '../executor';
import { fakeDb, type Row } from './settings/fake-db';
import { settingsTools } from './settings';

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (u: string) => !/127\.|localhost|10\./.test(u)),
}));

const A = 'acct-a';
const B = 'acct-b';
const TOKEN = 'EAAG-test-access-token-value';
const ID1 = '44444444-4444-4444-8444-444444444444';

function tool(name: string) {
  const t = settingsTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function caller(db: CallerContext['supabase'], accountId = A): CallerContext {
  return {
    supabase: db,
    accountId,
    keyId: 'key-1',
    scopes: ['settings:read', 'settings:write', 'webhooks:manage'],
    createdBy: 'user-1',
  };
}

function waConfig(account = A): Row {
  return {
    account_id: account,
    phone_number_id: '1000',
    waba_id: '2000',
    access_token: encrypt(TOKEN),
    status: 'connected',
    registered_at: '2026-01-01T00:00:00Z',
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('whatsapp settings', () => {
  it('get_whatsapp_status returns live status and never the token', async () => {
    const fetchMock = vi.fn(async () =>
      json({ display_phone_number: '+1 555 0100', verified_name: 'Shop', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb({ whatsapp_config: [waConfig()] });
    const out = await runTool(tool('get_whatsapp_status'), caller(db), {});
    expect(out).toMatchObject({ configured: true, quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', registered: true });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports not configured for an account without a number', async () => {
    const { db } = fakeDb({ whatsapp_config: [waConfig(B)] });
    expect(await runTool(tool('get_whatsapp_status'), caller(db), {})).toEqual({ configured: false });
  });

  it('verify_whatsapp_registration dry run does not call Meta', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb({ whatsapp_config: [waConfig()] });
    const out = (await runTool(tool('verify_whatsapp_registration'), caller(db), { dry_run: true })) as Row;
    expect(out.dry_run).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verify_whatsapp_registration runs the checks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => (String(u).includes('subscribed_apps') ? json({ data: [{ id: 'app' }] }) : json({ id: '1000', display_phone_number: 'x' })))
    );
    const { db } = fakeDb({ whatsapp_config: [waConfig()] });
    const out = (await runTool(tool('verify_whatsapp_registration'), caller(db), {})) as Row;
    expect(out.live).toBe(true);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('update_business_profile dry run shows a diff and posts nothing', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ about: 'Old', websites: [] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb({ whatsapp_config: [waConfig()] });
    const out = (await runTool(tool('update_business_profile'), caller(db), { about: 'New', dry_run: true })) as {
      diff: Record<string, unknown>;
    };
    expect(out.diff.about).toEqual({ from: 'Old', to: 'New' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBeUndefined();
  });

  it('update_business_profile posts the change to Meta', async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ success: true }) : json({ data: [{ about: 'Old' }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb({ whatsapp_config: [waConfig()] });
    await runTool(tool('update_business_profile'), caller(db), { about: 'New' });
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ messaging_product: 'whatsapp', about: 'New' });
  });

  it('update_business_profile needs at least one field', async () => {
    const { db } = fakeDb({ whatsapp_config: [waConfig()] });
    await expect(runTool(tool('update_business_profile'), caller(db), {})).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('notifications', () => {
  const rows = (): Row[] => [
    { id: 'n1', account_id: A, user_id: 'user-1', title: 'one', read_at: null, created_at: '2026-01-02T00:00:00Z' },
    { id: 'n2', account_id: A, user_id: 'user-1', title: 'two', read_at: '2026-01-02T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'n3', account_id: A, user_id: 'someone-else', title: 'not mine', read_at: null, created_at: '2026-01-03T00:00:00Z' },
    { id: 'n4', account_id: B, user_id: 'user-1', title: 'other account', read_at: null, created_at: '2026-01-03T00:00:00Z' },
  ];

  it('lists only the key owner notifications in this account', async () => {
    const { db } = fakeDb({ notifications: rows() });
    const out = (await runTool(tool('list_notifications'), caller(db), {})) as { items: Row[]; unread_count: number };
    expect(out.items.map((i) => i.id)).toEqual(['n1', 'n2']);
    expect(out.unread_count).toBe(1);
  });

  it('mark_notifications_read dry run then real, owner rows only', async () => {
    const { db, tables } = fakeDb({ notifications: rows() });
    const dry = (await runTool(tool('mark_notifications_read'), caller(db), { all: true, dry_run: true })) as Row;
    expect(dry.would_mark_read).toBe(1);
    expect(tables.notifications.find((r) => r.id === 'n1')!.read_at).toBeNull();

    await runTool(tool('mark_notifications_read'), caller(db), { all: true });
    expect(tables.notifications.find((r) => r.id === 'n1')!.read_at).not.toBeNull();
    expect(tables.notifications.find((r) => r.id === 'n3')!.read_at).toBeNull();
    expect(tables.notifications.find((r) => r.id === 'n4')!.read_at).toBeNull();
  });

  it('needs ids or all', async () => {
    const { db } = fakeDb({ notifications: rows() });
    await expect(runTool(tool('mark_notifications_read'), caller(db), {})).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('webhook endpoints', () => {
  const endpoint = (account = A): Row => ({
    id: ID1,
    account_id: account,
    url: 'https://hooks.example.com/x',
    events: ['message.received'],
    is_active: true,
    failure_count: 3,
    secret: encrypt('whsec_original'),
    created_at: '2026-01-01T00:00:00Z',
  });

  it('list never returns the secret and is account scoped', async () => {
    const { db } = fakeDb({ webhook_endpoints: [endpoint(), { ...endpoint(B), id: 'zzz' }] });
    const out = (await runTool(tool('list_webhook_endpoints'), caller(db), {})) as { items: Row[] };
    expect(out.items).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('create returns the secret once and stores it encrypted', async () => {
    const { db, tables } = fakeDb({});
    const out = (await runTool(tool('create_webhook_endpoint'), caller(db), {
      url: 'https://hooks.example.com/in',
      events: ['message.received'],
    })) as { secret: string };
    expect(out.secret).toMatch(/^whsec_/);
    const stored = tables.webhook_endpoints[0];
    expect(stored.account_id).toBe(A);
    expect(stored.secret).not.toBe(out.secret);
    expect(decrypt(stored.secret as string)).toBe(out.secret);

    const listed = await runTool(tool('list_webhook_endpoints'), caller(db), {});
    expect(JSON.stringify(listed)).not.toContain(out.secret);
  });

  it('create rejects http, private hosts and unknown events; dry run writes nothing', async () => {
    const { db, tables } = fakeDb({});
    const bad = (args: Row) => runTool(tool('create_webhook_endpoint'), caller(db), args);
    await expect(bad({ url: 'http://hooks.example.com', events: ['message.received'] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bad({ url: 'https://127.0.0.1/x', events: ['message.received'] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bad({ url: 'https://hooks.example.com', events: ['nope'] })).rejects.toMatchObject({ code: 'invalid_input' });
    const dry = (await bad({ url: 'https://hooks.example.com', events: ['message.received'], dry_run: true })) as Row;
    expect(dry.dry_run).toBe(true);
    expect(tables.webhook_endpoints ?? []).toHaveLength(0);
  });

  it('update re-enables and clears the failure streak; other accounts are not_found', async () => {
    const { db, tables } = fakeDb({ webhook_endpoints: [{ ...endpoint(), is_active: false }] });
    await runTool(tool('update_webhook_endpoint'), caller(db), { webhook_id: ID1, is_active: true });
    expect(tables.webhook_endpoints[0]).toMatchObject({ is_active: true, failure_count: 0 });
    await expect(
      runTool(tool('update_webhook_endpoint'), caller(db, B), { webhook_id: ID1, is_active: false })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('delete needs confirm and is account scoped', async () => {
    const { db, tables } = fakeDb({ webhook_endpoints: [endpoint()] });
    await expect(runTool(tool('delete_webhook_endpoint'), caller(db), { webhook_id: ID1 })).rejects.toMatchObject({ code: 'confirm_required' });
    await expect(
      runTool(tool('delete_webhook_endpoint'), caller(db, B), { webhook_id: ID1, confirm: true })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(tables.webhook_endpoints).toHaveLength(1);
    await runTool(tool('delete_webhook_endpoint'), caller(db), { webhook_id: ID1, confirm: true });
    expect(tables.webhook_endpoints).toHaveLength(0);
  });

  it('send_test_webhook posts a signed test event without touching failure counters', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, tables, log } = fakeDb({ webhook_endpoints: [endpoint()] });

    const dry = (await runTool(tool('send_test_webhook'), caller(db), { webhook_id: ID1, dry_run: true })) as Row;
    expect(dry.dry_run).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const out = await runTool(tool('send_test_webhook'), caller(db), { webhook_id: ID1 });
    expect(out).toMatchObject({ delivered: true, http_status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/x');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Wacrm-Event']).toBe('webhook.test');
    expect(headers['X-Wacrm-Signature']).toBeTruthy();
    expect(init.redirect).toBe('manual');
    expect(tables.webhook_endpoints[0].failure_count).toBe(3);
    expect(log.filter((l) => l.table === 'webhook_endpoints' && l.op === 'update')).toHaveLength(0);
  });

  it('send_test_webhook reports a failing receiver', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    const { db } = fakeDb({ webhook_endpoints: [endpoint()] });
    expect(await runTool(tool('send_test_webhook'), caller(db), { webhook_id: ID1 })).toMatchObject({
      delivered: false,
      http_status: 500,
    });
  });
});
