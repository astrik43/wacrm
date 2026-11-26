import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb } from '@/lib/reports/fake-db';

const sendTest = vi.fn(async () => ({ status: 'sent' as const }));
const processHook = vi.fn(async () => ({ orderRef: '#1', outcomes: [{ event: 'order_created', status: 'sent' }] }));
const tagPage = vi.fn(async () => ({
  ok: true as const,
  scanned: 10,
  delivered: 4,
  returned: 1,
  noPhone: 2,
  oldestOrderAt: '2026-01-01T00:00:00Z',
  nextCursor: 'next-1',
}));

vi.mock('@/lib/shopify/notify', () => ({ sendTestNotification: (...a: unknown[]) => (sendTest as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@/lib/shopify/process', () => ({ processShopifyWebhook: (...a: unknown[]) => (processHook as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@/lib/shopify/delivered-backfill', () => ({ tagDeliveredCustomersPage: (...a: unknown[]) => (tagPage as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async (_db: unknown, _acc: string, name: string) =>
    name === 'welcome'
      ? { row: { name: 'welcome', status: 'APPROVED' }, malformed: false, language: 'en' }
      : name === 'draft'
        ? { row: { name: 'draft', status: 'PENDING' }, malformed: false, language: 'en' }
        : { row: null, malformed: false, language: 'en' },
}));
vi.mock('@/lib/shopify/variable-mapping', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopify/variable-mapping')>()),
  validateVariableMapping: () => [],
}));

import { runTool, type CallerContext } from '../executor';
import { commerceTools } from './commerce';

const A = 'acc-a';
const B = 'acc-b';
const PHONE = '919876543210';
const SECRET = 'super-secret-value';

function tool(name: string) {
  const t = commerceTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

function seed() {
  return fakeDb({
    shopify_configs: [
      {
        id: 'cfg', account_id: A, webhook_token: 'tok-should-never-leak', webhook_secret: SECRET,
        shop_domain: 'shop.myshopify.com', default_country_code: '91', is_active: true,
        last_webhook_at: '2026-01-01T00:00:00Z', api_client_id: 'cid', api_client_secret: SECRET,
        api_access_token: SECRET, api_token_expires_at: null, api_scopes: 'read_orders,write_orders',
        flexype_secret: SECRET, flexype_last_webhook_at: null, shiprocket_secret: null,
        shiprocket_last_webhook_at: null, test_mode: true, test_phones: [PHONE],
      },
      { id: 'cfg-b', account_id: B, webhook_token: 't2', webhook_secret: 'x', shop_domain: 'b.myshopify.com', is_active: true, test_mode: false, test_phones: [] },
    ],
    contacts: [
      { id: 'c-1', account_id: A },
      { id: 'c-b', account_id: B },
    ],
    shopify_orders: [
      { id: 'o-1', account_id: A, shopify_order_id: 's1', order_name: '#1001', phone: PHONE, customer_name: 'Hidden Name', contact_id: 'c-1', payment_mode: 'cod', cancelled_at: null, fields: { order_total: '499', currency: 'INR', customer_name: 'Hidden Name' }, created_at: '2026-02-01T00:00:00Z' },
      { id: 'o-b', account_id: B, shopify_order_id: 's9', order_name: '#9001', phone: '910000000000', contact_id: 'c-b', payment_mode: 'prepaid', fields: {}, created_at: '2026-02-02T00:00:00Z' },
    ],
    shopify_fulfillments: [
      { account_id: A, shopify_fulfillment_id: 'f1', shopify_order_id: 's1', tracking_number: 'TRK1', tracking_company: 'X', shipment_status: 'in_transit', created_at: '2026-02-02T00:00:00Z', updated_at: '2026-02-02T00:00:00Z' },
    ],
    shopify_notifications: [
      { id: 'n-1', account_id: A, event: 'order_created', shopify_order_id: 's1', order_name: '#1001', status: 'skipped', reason: 'test_mode', variant: 'cod', step: 0, send_at: null, is_test: false, created_at: '2026-02-01T00:00:01Z' },
      { id: 'n-2', account_id: A, event: 'order_created', shopify_order_id: 's1', order_name: 'Test · #1', status: 'sent', reason: null, variant: 'all', step: 0, send_at: null, is_test: true, created_at: '2026-02-01T00:00:02Z' },
      { id: 'n-b', account_id: B, event: 'order_created', shopify_order_id: 's9', order_name: '#9001', status: 'failed', reason: 'x', variant: 'all', step: 0, send_at: null, is_test: false, created_at: '2026-02-01T00:00:03Z' },
    ],
    shopify_event_templates: [
      { account_id: A, event: 'order_created', variant: 'all', step: 0, is_enabled: false, template_name: 'welcome', template_language: 'en', variable_mapping: { body: [] }, delay_minutes: 0, updated_at: null },
    ],
    shopify_webhook_events: [
      { id: 'w-1', account_id: A, received_at: '2026-02-01T00:00:00Z', topic: 'orders/create', order_ref: '#1001', status: 'processed', detail: null, outcome: [], payload: { name: '#1001', phone: PHONE }, shopify_webhook_id: 'wh1' },
      { id: 'w-b', account_id: B, received_at: '2026-02-01T00:00:00Z', topic: 'orders/create', order_ref: '#9001', status: 'processed', detail: null, outcome: [], payload: { name: '#9001' }, shopify_webhook_id: 'wh2' },
    ],
    contact_tags: [{ contact_id: 'c-1', tag_id: 'tag-1' }],
    tags: [{ id: 'tag-1', account_id: A, name: 'Order Delivered' }],
  });
}

function caller(db: ReturnType<typeof seed>['db'], scopes = ['commerce:read', 'commerce:write']): CallerContext {
  return { supabase: db, accountId: A, keyId: 'k', scopes, createdBy: null };
}

const call = (db: ReturnType<typeof seed>['db'], name: string, args: unknown = {}, scopes?: string[]) =>
  runTool(tool(name), caller(db, scopes), args) as Promise<Record<string, unknown>>;

beforeEach(() => {
  sendTest.mockClear();
  processHook.mockClear();
  tagPage.mockClear();
});

describe('commerce tool registry', () => {
  it('reads use commerce:read, writes and destructive use commerce:write', () => {
    for (const t of commerceTools) {
      expect(t.scope).toBe(t.tier === 'read' ? 'commerce:read' : 'commerce:write');
    }
  });

  it('refuses a read-only key on write tools', async () => {
    const { db } = seed();
    await expect(call(db, 'set_shopify_test_mode', { enabled: false }, ['commerce:read'])).rejects.toMatchObject({ code: 'missing_scope' });
  });
});

describe('get_shopify_status', () => {
  it('reports state without secrets, tokens or full numbers', async () => {
    const { db } = seed();
    const r = await call(db, 'get_shopify_status');
    const json = JSON.stringify(r);
    expect(r).toMatchObject({ connected: true, test_mode: true, test_numbers_count: 1 });
    expect((r.api_credentials as { saved: boolean }).saved).toBe(true);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('tok-should-never-leak');
    expect(json).not.toContain(PHONE);
    expect(json).toContain('3210');
  });
});

describe('orders', () => {
  it('searches only this account and hides customer details', async () => {
    const { db } = seed();
    const r = (await call(db, 'search_orders', { order_number: '1001' })) as { items: { order_number: string }[] };
    expect(r.items.map((i) => i.order_number)).toEqual(['#1001']);
    const all = (await call(db, 'search_orders')) as { items: unknown[] };
    expect(all.items).toHaveLength(1);
    const json = JSON.stringify(all);
    expect(json).not.toContain(PHONE);
    expect(json).not.toContain('Hidden Name');
  });

  it('gets an order with timeline, notifications and contact tags', async () => {
    const { db } = seed();
    const r = (await call(db, 'get_order', { order_number: '1001' })) as {
      shipments: unknown[]; notifications: unknown[]; contact_tags: string[]; order: { contact_id: string };
    };
    expect(r.shipments).toHaveLength(1);
    expect(r.notifications).toHaveLength(2);
    expect(r.contact_tags).toEqual(['Order Delivered']);
    expect(r.order.contact_id).toBe('c-1');
  });

  it("returns not_found for another account's order and contact", async () => {
    const { db } = seed();
    await expect(call(db, 'get_order', { order_id: 'o-b'.padEnd(36, '0') })).rejects.toBeTruthy();
    await expect(call(db, 'get_order', { order_number: '9001' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(db, 'list_contact_orders', { contact_id: '00000000-0000-4000-8000-0000000000bb' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('order update events', () => {
  it('lists defaults and saved config', async () => {
    const { db } = seed();
    const r = (await call(db, 'list_order_update_events', { event: 'order_created' })) as { items: { variant: string; template_name: string | null; configured: boolean }[] };
    expect(r.items.find((i) => i.variant === 'all')).toMatchObject({ template_name: 'welcome', configured: true });
    expect(r.items.find((i) => i.variant === 'cod')?.configured).toBe(false);
  });

  it('dry run shows the diff and writes nothing', async () => {
    const { db, writes } = seed();
    const r = (await runTool(tool('update_order_update_event'), caller(db), { event: 'order_created', is_enabled: true, delay_minutes: 5, dry_run: true })) as { dry_run: boolean; changes: Record<string, unknown> };
    expect(r.dry_run).toBe(true);
    expect(Object.keys(r.changes).sort()).toEqual(['delay_minutes', 'is_enabled']);
    expect(writes.filter((w) => w.table !== 'mcp_audit_log')).toHaveLength(0);
  });

  it('saves a valid change, and validates like the settings page', async () => {
    const { db, writes } = seed();
    const r = await call(db, 'update_order_update_event', { event: 'order_created', is_enabled: true });
    expect(r.saved).toBe(true);
    expect(writes.find((w) => w.op === 'upsert')?.values).toMatchObject({ account_id: A, is_enabled: true });

    await expect(call(db, 'update_order_update_event', { event: 'cart_reminder_1', is_enabled: true, template_name: 'welcome', delay_minutes: 1 })).rejects.toMatchObject({ field: 'delay_minutes' });
    await expect(call(db, 'update_order_update_event', { event: 'order_created', template_name: 'draft' })).rejects.toMatchObject({ code: 'template_not_approved' });
    await expect(call(db, 'update_order_update_event', { event: 'order_created', template_name: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(db, 'update_order_update_event', { event: 'cart_reminder_1', variant: 'cod' })).rejects.toMatchObject({ field: 'variant' });
  });
});

describe('test mode and test send', () => {
  it('normalises test numbers, masks them and scopes the update by account', async () => {
    const { db, writes } = seed();
    const r = (await call(db, 'set_shopify_test_mode', { enabled: true, test_numbers: ['098765 43211'] })) as { test_numbers: string[] };
    expect(r.test_numbers).toEqual(['••••3211']);
    const w = writes.find((x) => x.op === 'update');
    expect(w?.values).toMatchObject({ test_mode: true, test_phones: ['919876543211'] });
    expect(w?.filters).toEqual({ account_id: A });
    await expect(call(db, 'set_shopify_test_mode', { enabled: true, test_numbers: ['abc'] })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('test mode dry run changes nothing', async () => {
    const { db, writes } = seed();
    await runTool(tool('set_shopify_test_mode'), caller(db), { enabled: false, dry_run: true });
    expect(writes.filter((w) => w.table !== 'mcp_audit_log')).toHaveLength(0);
  });

  it('send test dry run sends nothing; real run calls the wrapped sender', async () => {
    const { db } = seed();
    const dry = (await runTool(tool('send_order_update_test'), caller(db), { event: 'order_created', phone: '+919876543299', dry_run: true })) as { would_send: { recipient: string } };
    expect(dry.would_send.recipient).toBe('••••3299');
    expect(sendTest).not.toHaveBeenCalled();

    const r = await call(db, 'send_order_update_test', { event: 'order_created', phone: '+919876543299' });
    expect(r.sent).toBe(true);
    expect(sendTest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain('919876543299');
  });
});

describe('logs and replay', () => {
  it('notification log is account scoped, hides tests by default and explains skips', async () => {
    const { db } = seed();
    const r = (await call(db, 'list_notification_log')) as { items: { status: string; reason: string; order_number: string }[] };
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ status: 'skipped', reason: 'test_mode', order_number: '#1001' });
    const withTests = (await call(db, 'list_notification_log', { include_tests: true })) as { items: unknown[] };
    expect(withTests.items).toHaveLength(2);
  });

  it('webhook list omits payloads and other accounts', async () => {
    const { db } = seed();
    const r = (await call(db, 'list_webhook_events')) as { items: { id: string }[] };
    expect(r.items.map((i) => i.id)).toEqual(['w-1']);
    expect(JSON.stringify(r)).not.toContain(PHONE);
  });

  it('replay: needs confirm, dry run processes nothing, other account is not_found', async () => {
    const { db } = seed();
    const id = '00000000-0000-4000-8000-000000000001';
    await expect(runTool(tool('replay_webhook_event'), caller(db), { event_id: id })).rejects.toMatchObject({ code: 'confirm_required' });
    await expect(runTool(tool('replay_webhook_event'), caller(db), { event_id: id, confirm: true })).rejects.toMatchObject({ code: 'not_found' });

    db.from('shopify_webhook_events');
    const seeded = fakeDb({
      shopify_configs: [{ account_id: A, test_mode: true, test_phones: [PHONE], is_active: true }],
      shopify_webhook_events: [{ id, account_id: A, topic: 'orders/create', order_ref: '#1', status: 'processed', shopify_webhook_id: 'wh', payload: { name: '#1' } }],
    });
    const dry = (await runTool(tool('replay_webhook_event'), caller(seeded.db), { event_id: id, dry_run: true })) as { would_replay: { test_mode: boolean } };
    expect(dry.would_replay.test_mode).toBe(true);
    expect(processHook).not.toHaveBeenCalled();

    const real = await runTool(tool('replay_webhook_event'), caller(seeded.db), { event_id: id, confirm: true });
    expect(processHook).toHaveBeenCalledTimes(1);
    expect(real).toMatchObject({ replayed: true });
  });
});

describe('tag_delivered_customers', () => {
  it('returns page counts and a cursor, never phones; dry run does not call Shopify', async () => {
    const { db } = seed();
    const dry = await runTool(tool('tag_delivered_customers'), caller(db), { dry_run: true });
    expect(tagPage).not.toHaveBeenCalled();
    expect(dry).toMatchObject({ dry_run: true });

    const r = await call(db, 'tag_delivered_customers', { cursor: 'abc' });
    expect(tagPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ account_id: A }), 'abc');
    expect(r).toEqual({ scanned: 10, delivered: 4, returned: 1, noPhone: 2, oldestOrderAt: '2026-01-01T00:00:00Z', next_cursor: 'next-1' });
  });

  it('turns a Shopify refusal into upstream_error', async () => {
    const { db } = seed();
    tagPage.mockResolvedValueOnce({ ok: false, error: 'missing scope' } as never);
    await expect(call(db, 'tag_delivered_customers')).rejects.toMatchObject({ code: 'upstream_error' });
  });
});
