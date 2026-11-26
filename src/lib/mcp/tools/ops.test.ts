import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  audit: vi.fn(),
  resolveTags: vi.fn(),
  addTag: vi.fn(),
  deliverable: vi.fn(),
}));

vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: mocks.send,
}));
vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId: mocks.audit }));
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: mocks.resolveTags,
}));
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: mocks.addTag }));
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: mocks.deliverable }));

import { fakeDb, type Tables } from '@/lib/ops/testing';
import { hasScope } from '@/lib/api-keys/scopes';

import { McpToolError } from '../errors';
import type { McpContext } from '../types';
import { opsTools } from './ops';

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const STAFF = 'c0000000-0000-4000-8000-000000000001';
const CUSTOMER = 'c0000000-0000-4000-8000-000000000002';
const FOREIGN = 'c0000000-0000-4000-8000-000000000003';
const PDF = 'https://files.example.com/labels.pdf';

const tool = (name: string) => {
  const t = opsTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const ctx = (db: McpContext['supabase'], dryRun = false): McpContext => ({
  supabase: db,
  accountId: ACCOUNT,
  keyId: 'k',
  scopes: ['ops:read', 'ops:write', 'events:read'],
  createdBy: null,
  dryRun,
});
const call = (name: string, db: McpContext['supabase'], args: unknown, dryRun = false) =>
  tool(name).handler(ctx(db, dryRun), args as never);

function world(): Tables {
  const recent = new Date(Date.now() - 3600_000).toISOString();
  return {
    contacts: [
      { id: STAFF, account_id: ACCOUNT, name: 'Priya', phone: '+910000000001', is_staff: true },
      { id: CUSTOMER, account_id: ACCOUNT, name: 'Real Customer', phone: '+910000000002', is_staff: false },
      { id: FOREIGN, account_id: OTHER, name: 'Elsewhere', phone: '+910000000003', is_staff: true },
    ],
    conversations: [
      { id: 'conv-staff', account_id: ACCOUNT, contact_id: STAFF, created_at: recent },
      { id: 'conv-cust', account_id: ACCOUNT, contact_id: CUSTOMER, created_at: recent },
    ],
    messages: [
      { id: 'm1', conversation_id: 'conv-staff', sender_type: 'customer', created_at: recent },
    ],
    shopify_orders: [
      {
        id: 'o1',
        account_id: ACCOUNT,
        shopify_order_id: 'so-1',
        order_name: '#EL2204',
        phone: '910000000002',
        contact_id: CUSTOMER,
        cancelled_at: null,
        payment_mode: 'cod',
        created_at: recent,
      },
      {
        id: 'o2',
        account_id: OTHER,
        shopify_order_id: 'so-2',
        order_name: '#EL9999',
        phone: '910000000003',
        contact_id: FOREIGN,
        created_at: recent,
      },
    ],
    shopify_fulfillments: [
      {
        id: 'f1',
        account_id: ACCOUNT,
        shopify_order_id: 'so-1',
        shipment_status: 'attempted_delivery',
        tracking_number: 'AWB777',
        tracking_company: 'Courier',
        updated_at: recent,
      },
    ],
    tags: [
      { id: 'tag-rto', account_id: ACCOUNT, name: 'Order RTO' },
      { id: 'tag-vip', account_id: ACCOUNT, name: 'VIP' },
    ],
    contact_tags: [],
    ops_settings: [],
    ndr_requests: [],
    message_templates: [],
  };
}

function head(init: { type?: string; length?: string; status?: number }) {
  return vi.fn<typeof fetch>(async () =>
    new Response(null, {
      status: init.status ?? 200,
      headers: {
        'content-type': init.type ?? 'application/pdf',
        ...(init.length === undefined ? { 'content-length': '2048' } : { 'content-length': init.length }),
      },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.send.mockResolvedValue({ messageId: 'msg-1', whatsappMessageId: 'w-1' });
  mocks.audit.mockResolvedValue('u1');
  mocks.deliverable.mockResolvedValue(true);
  mocks.resolveTags.mockResolvedValue({ tagIdByKey: new Map([['partial pay', 'tag-pp']]), skippedNames: [] });
  mocks.addTag.mockResolvedValue({ added: true, dispatched: true });
});

describe('registry shape', () => {
  it('uses :read scopes for reads and :write scopes for writes', () => {
    for (const t of opsTools) {
      if (t.tier === 'read') expect(t.scope).toMatch(/:read$/);
      else expect(t.scope).toMatch(/:write$/);
      expect(hasScope(['ops:read', 'ops:write', 'events:read'], t.scope!)).toBe(true);
    }
    expect(opsTools.map((t) => t.name).sort()).toEqual(
      [
        'apply_tag_changes',
        'find_by_order',
        'get_ndr_settings',
        'get_ops_settings',
        'get_tag_state',
        'list_events_since',
        'list_ndr_requests',
        'list_staff_contacts',
        'resolve_ndr',
        'send_document_to_staff',
        'set_contact_staff',
        'update_ndr_settings',
        'update_ops_settings',
      ].sort()
    );
  });
});

describe('find_by_order', () => {
  it('finds by #order, bare order and AWB, and returns no PII', async () => {
    const { db } = fakeDb(world());
    for (const q of ['#EL2204', 'EL2204', 'el2204', 'AWB777']) {
      const out = (await call('find_by_order', db, { query: q })) as Record<string, unknown>;
      expect(out).toMatchObject({
        order_number: '#EL2204',
        status: 'open',
        contact_id: CUSTOMER,
        conversation_id: 'conv-cust',
        is_staff: false,
        fulfilment: { status: 'attempted_delivery', awb: 'AWB777' },
      });
      const json = JSON.stringify(out);
      expect(json).not.toContain('910000000002');
      expect(json).not.toContain('Real Customer');
    }
  });

  it("does not find another account's order", async () => {
    const { db } = fakeDb(world());
    await expect(call('find_by_order', db, { query: '#EL9999' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('staff tools', () => {
  it('set_contact_staff flips the flag, dry run changes nothing, foreign ids are not_found', async () => {
    const { db, tables } = fakeDb(world());
    const dry = await call('set_contact_staff', db, { contact_id: CUSTOMER, is_staff: true }, true);
    expect(dry).toMatchObject({ changed: false, would_set: true });
    expect(tables.contacts.find((c) => c.id === CUSTOMER)!.is_staff).toBe(false);

    await call('set_contact_staff', db, { contact_id: CUSTOMER, is_staff: true });
    expect(tables.contacts.find((c) => c.id === CUSTOMER)!.is_staff).toBe(true);

    await expect(
      call('set_contact_staff', db, { contact_id: FOREIGN, is_staff: false })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(tables.contacts.find((c) => c.id === FOREIGN)!.is_staff).toBe(true);
  });

  it('list_staff_contacts returns names and ids only, scoped to the account', async () => {
    const { db } = fakeDb(world());
    const out = (await call('list_staff_contacts', db, {})) as { items: Record<string, unknown>[] };
    expect(out.items).toEqual([{ contact_id: STAFF, name: 'Priya', messaged_in_last_24h: true }]);
    expect(JSON.stringify(out)).not.toContain('910000000001');
  });
});

describe('send_document_to_staff', () => {
  it('rejects a contact that is not staff and a foreign contact', async () => {
    const { db } = fakeDb(world());
    vi.stubGlobal('fetch', head({}));
    await expect(call('send_document_to_staff', db, { contact_id: CUSTOMER, url: PDF })).rejects.toMatchObject({
      code: 'not_staff',
    });
    await expect(call('send_document_to_staff', db, { contact_id: FOREIGN, url: PDF })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('dry run inside the 24h window returns the document payload without a phone', async () => {
    const { db } = fakeDb(world());
    const fetchMock = head({});
    vi.stubGlobal('fetch', fetchMock);
    const out = (await call(
      'send_document_to_staff',
      db,
      { contact_id: STAFF, url: PDF, caption: 'Labels 27 Nov', filename: 'labels.pdf' },
      true
    )) as Record<string, unknown>;
    expect(out).toMatchObject({
      dry_run: true,
      mode: 'session',
      payload: {
        type: 'document',
        document: { link: PDF, caption: 'Labels 27 Nov', filename: 'labels.pdf' },
      },
    });
    expect(JSON.stringify(out)).not.toContain('910000000001');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
  });

  it('sends a document message inside the window', async () => {
    const { db } = fakeDb(world());
    vi.stubGlobal('fetch', head({}));
    const out = await call('send_document_to_staff', db, {
      contact_id: STAFF,
      url: PDF,
      caption: 'Labels',
      filename: 'labels.pdf',
    });
    expect(out).toEqual({ sent: true, mode: 'session', message_id: 'msg-1' });
    expect(mocks.send.mock.calls[0][2]).toEqual({
      conversationId: 'conv-staff',
      messageType: 'document',
      mediaUrl: PDF,
      contentText: 'Labels',
      filename: 'labels.pdf',
    });
  });

  it('validates the link: https, pdf, size', async () => {
    const { db } = fakeDb(world());
    await expect(
      call('send_document_to_staff', db, { contact_id: STAFF, url: 'http://files.example.com/a.pdf' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    vi.stubGlobal('fetch', head({ type: 'text/html' }));
    await expect(call('send_document_to_staff', db, { contact_id: STAFF, url: PDF })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    vi.stubGlobal('fetch', head({ length: String(50 * 1024 * 1024) }));
    await expect(call('send_document_to_staff', db, { contact_id: STAFF, url: PDF })).rejects.toThrow(
      /limit/
    );
    mocks.deliverable.mockResolvedValue(false);
    await expect(call('send_document_to_staff', db, { contact_id: STAFF, url: PDF })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('outside the window with no template: outside_24h_window with a next step', async () => {
    const t = world();
    t.messages = [];
    const { db } = fakeDb(t);
    vi.stubGlobal('fetch', head({}));
    const err = (await call('send_document_to_staff', db, { contact_id: STAFF, url: PDF }).catch(
      (e: unknown) => e
    )) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.code).toBe('outside_24h_window');
    expect(err.message).toMatch(/update_ops_settings/);
  });

  it('outside the window uses the configured document-header template', async () => {
    const t = world();
    t.messages = [];
    t.ops_settings = [
      { account_id: ACCOUNT, staff_doc_template_name: 'daily_labels', staff_doc_template_language: 'en' },
    ];
    t.message_templates = [
      {
        id: 'tpl',
        user_id: 'u1',
        account_id: ACCOUNT,
        name: 'daily_labels',
        language: 'en',
        status: 'APPROVED',
        header_type: 'document',
        body_text: 'Labels for {{1}}',
      },
    ];
    const { db } = fakeDb(t);
    vi.stubGlobal('fetch', head({}));
    const dry = (await call(
      'send_document_to_staff',
      db,
      { contact_id: STAFF, url: PDF, caption: '27 Nov' },
      true
    )) as { payload: { template: { components: unknown[] } } };
    expect(dry.payload.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'document', document: { link: PDF } }] },
      { type: 'body', parameters: [{ type: 'text', text: '27 Nov' }] },
    ]);

    await call('send_document_to_staff', db, { contact_id: STAFF, url: PDF, caption: '27 Nov' });
    expect(mocks.send.mock.calls[0][2]).toMatchObject({
      messageType: 'template',
      templateName: 'daily_labels',
      templateMessageParams: { body: ['27 Nov'], headerMediaUrl: PDF },
    });
  });
});

describe('NDR tools', () => {
  it('NDR is off by default; enabling requires an approved template; dry run saves nothing', async () => {
    const t = world();
    const { db, tables } = fakeDb(t);
    expect(await call('get_ndr_settings', db, {})).toMatchObject({ enabled: false });

    await expect(call('update_ndr_settings', db, { enabled: true })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      call('update_ndr_settings', db, { enabled: true, template_name: 'ndr_notice' })
    ).rejects.toMatchObject({ code: 'not_found' });

    tables.message_templates.push({
      id: 'tpl',
      user_id: 'u1',
      account_id: ACCOUNT,
      name: 'ndr_notice',
      language: 'en',
      status: 'APPROVED',
      body_text: 'Order {{1}}',
    });
    const dry = await call('update_ndr_settings', db, { enabled: true, template_name: 'ndr_notice' }, true);
    expect(dry).toMatchObject({ dry_run: true });
    expect(tables.ops_settings).toHaveLength(0);

    await call('update_ndr_settings', db, { enabled: true, template_name: 'ndr_notice' });
    expect(tables.ops_settings[0]).toMatchObject({ ndr_enabled: true, ndr_template_name: 'ndr_notice' });
  });

  it('lists and resolves requests, scoped to the account', async () => {
    const t = world();
    t.ndr_requests = [
      { id: 'n1', account_id: ACCOUNT, order_name: '#EL1', contact_id: CUSTOMER, state: 'answered', answer: 'reattempt', answer_text: '1', created_at: '2026-11-27T10:00:00+00:00', sent_at: '2026-11-27T10:00:00+00:00' },
      { id: 'n2', account_id: OTHER, order_name: '#EL2', contact_id: FOREIGN, state: 'sent', created_at: '2026-11-27T11:00:00+00:00', sent_at: '2026-11-27T11:00:00+00:00' },
    ];
    const { db, tables } = fakeDb(t);
    const list = (await call('list_ndr_requests', db, { state: 'answered' })) as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ order_number: '#EL1', answer: 'reattempt', state: 'answered' });

    await expect(call('resolve_ndr', db, { order_number: 'EL2' })).rejects.toMatchObject({ code: 'not_found' });
    await call('resolve_ndr', db, { order_number: 'EL1', note: 'ERP comment posted' }, true);
    expect(tables.ndr_requests[0].resolved_at).toBeUndefined();
    await call('resolve_ndr', db, { order_number: 'EL1', note: 'ERP comment posted' });
    expect(tables.ndr_requests[0].resolved_at).toBeTruthy();
  });
});

describe('list_events_since', () => {
  it('rejects a garbled cursor instead of replaying history', async () => {
    const { db } = fakeDb(world());
    await expect(call('list_events_since', db, { cursor: 'nonsense' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('ERP tag sync', () => {
  it('get_tag_state lists contacts and order numbers, no phones, skipping staff and other accounts', async () => {
    const t = world();
    const created = '2026-11-27T10:00:00+00:00';
    t.contact_tags = [
      { id: 'ct1', created_at: created, contact_id: CUSTOMER, tag_id: 'tag-rto', contacts: { account_id: ACCOUNT, is_staff: false } },
      { id: 'ct2', created_at: created, contact_id: STAFF, tag_id: 'tag-rto', contacts: { account_id: ACCOUNT, is_staff: true } },
      { id: 'ct3', created_at: created, contact_id: FOREIGN, tag_id: 'tag-rto', contacts: { account_id: OTHER, is_staff: false } },
    ];
    const { db } = fakeDb(t);
    const out = (await call('get_tag_state', db, { tags: ['order rto', 'Nope'] })) as {
      items: Record<string, unknown>[];
      unknown_tags: string[];
    };
    expect(out.items).toEqual([
      { tag: 'Order RTO', contact_id: CUSTOMER, tagged_at: created, order_numbers: ['#EL2204'] },
    ]);
    expect(out.unknown_tags).toEqual(['Nope']);
    expect(JSON.stringify(out)).not.toContain('91000000');
  });

  it('apply_tag_changes: dry run counts, then adds via the automation-firing path and removes', async () => {
    const t = world();
    t.contact_tags = [
      { id: 'ct1', created_at: 'x', contact_id: CUSTOMER, tag_id: 'tag-rto', contacts: { account_id: ACCOUNT, is_staff: false } },
    ];
    const { db, tables } = fakeDb(t);
    const args = {
      add: [{ tag: 'Partial pay', order_numbers: ['#EL2204', '#NOPE'] }, { tag: 'Order RTO', contact_ids: [STAFF] }],
      remove: [{ tag: 'Order RTO', contact_ids: [CUSTOMER, FOREIGN] }],
    };
    const dry = (await call('apply_tag_changes', db, args, true)) as Record<string, unknown>;
    expect(dry).toMatchObject({
      dry_run: true,
      added: 0 + 1,
      removed: 1,
      skipped_staff: 1,
      tags_to_create: ['Partial pay'],
      unresolved: { contact_ids: [FOREIGN], order_numbers: ['#NOPE'] },
    });
    expect(mocks.addTag).not.toHaveBeenCalled();
    expect(tables.contact_tags).toHaveLength(1);

    const real = (await call('apply_tag_changes', db, args)) as Record<string, unknown>;
    expect(real).toMatchObject({ added: 1, removed: 1 });
    expect(mocks.addTag).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, contactId: CUSTOMER, tagId: 'tag-pp' })
    );
    expect(tables.contact_tags).toHaveLength(0);
  });

  it('refuses tags outside the sync list and batches over 500', async () => {
    const { db } = fakeDb(world());
    await expect(
      call('apply_tag_changes', db, { add: [{ tag: 'VIP', contact_ids: [CUSTOMER] }] })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const many = Array.from({ length: 501 }, (_, i) => `#EL${i}`);
    await expect(
      call('apply_tag_changes', db, {
        add: [{ tag: 'Blocked', order_numbers: many.slice(0, 300) }],
        remove: [{ tag: 'Blocked', order_numbers: many.slice(300) }],
      })
    ).rejects.toThrow(/At most 500/);
  });
});
