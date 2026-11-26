/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are untyped JSON in these tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(async () => {}),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'test-token', encrypt: (v: string) => v }));
vi.mock('@/lib/whatsapp/broadcast-core', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/broadcast-core')>()),
  deliverBroadcast: mocks.deliver,
}));

import { createFakeDb, type Row, type Tables } from '@/lib/broadcasts/fake-db.testutil';
import { runTool } from '../executor';
import { McpToolError } from '../errors';
import { broadcastsTools } from './broadcasts';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [B1, B2, T1, TX, C1, C2, S1, X1, R1, R2] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(u);

const ACC = 'acc-1';
const OTHER = 'acc-2';
const PHONES = ['+14155550101', '+14155550102', '+14155550103', '+14155550104'];

const TEMPLATE: Row = {
  id: 'tpl-1',
  account_id: ACC,
  user_id: 'u1',
  name: 'promo',
  language: 'en',
  status: 'APPROVED',
  category: 'Marketing',
  body_text: 'Hi {{1}}, shop now',
  buttons: [{ type: 'URL', text: 'Shop', url: 'https://shop.test/{{1}}' }],
};

function world(extra: Tables = {}) {
  return createFakeDb({
    contacts: [
      { id: C1, account_id: ACC, name: 'Asha', phone: PHONES[0], is_staff: false },
      { id: C2, account_id: ACC, name: 'Ben', phone: PHONES[1], is_staff: false },
      { id: S1, account_id: ACC, name: 'Staffer', phone: PHONES[2], is_staff: true },
      { id: X1, account_id: OTHER, name: 'Outsider', phone: PHONES[3], is_staff: false },
    ],
    tags: [
      { id: T1, account_id: ACC, name: 'vip' },
      { id: TX, account_id: OTHER, name: 'foreign' },
    ],
    contact_tags: [
      { contact_id: C1, tag_id: T1 },
      { contact_id: S1, tag_id: T1 },
    ],
    message_templates: [TEMPLATE],
    whatsapp_config: [{ account_id: ACC, user_id: 'owner-1', phone_number_id: 'pn-1', access_token: 'enc' }],
    broadcasts: [
      { id: B1, account_id: ACC, name: 'July', template_name: 'promo', template_language: 'en', status: 'sent', total_recipients: 2, sent_count: 2, delivered_count: 1, read_count: 1, replied_count: 0, failed_count: 0, delivery_locked_at: null, created_at: '2026-01-02T00:00:00Z' },
      { id: B2, account_id: OTHER, name: 'Theirs', template_name: 'promo', template_language: 'en', status: 'sent', total_recipients: 9, sent_count: 9, delivered_count: 0, read_count: 0, replied_count: 0, failed_count: 0, delivery_locked_at: null, created_at: '2026-01-03T00:00:00Z' },
    ],
    broadcast_recipients: [
      { id: R1, broadcast_id: B1, contact_id: C1, status: 'read', template_params: ['Asha'], created_at: '2026-01-02T00:00:01Z' },
      { id: R2, broadcast_id: B1, contact_id: C2, status: 'failed', error_message: 'bad', template_params: ['Ben'], created_at: '2026-01-02T00:00:02Z' },
    ],
    ...extra,
  });
}

function tool(name: string) {
  const t = broadcastsTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function call(
  fx: ReturnType<typeof world>,
  name: string,
  args: Record<string, unknown>,
  scopes = ['broadcasts:read', 'broadcasts:send']
) {
  return (await runTool(
    tool(name),
    { supabase: fx.db, accountId: ACC, keyId: 'k1', scopes, createdBy: 'user-1' },
    args
  )) as Record<string, any>;
}

const FIELD_NAME = { '1': { type: 'field', value: 'name' } };
const BUTTON = { '0': { type: 'static', value: 'summer' } };
const baseSend = {
  name: 'Promo',
  template_name: 'promo',
  variables: FIELD_NAME,
  button_variables: BUTTON,
  audience: { type: 'all' },
};

function noPhones(result: unknown) {
  const text = JSON.stringify(result);
  for (const p of PHONES) expect(text).not.toContain(p.slice(1));
}

beforeEach(() => {
  mocks.deliver.mockClear();
  vi.unstubAllGlobals();
});

describe('registry', () => {
  it('reads use broadcasts:read, everything that sends or changes uses broadcasts:send', () => {
    for (const t of broadcastsTools) {
      expect(t.scope).toBe(t.tier === 'read' ? 'broadcasts:read' : 'broadcasts:send');
    }
    expect(broadcastsTools.map((t) => [t.name, t.tier])).toEqual(
      expect.arrayContaining([
        ['send_broadcast', 'destructive'],
        ['resume_broadcast', 'destructive'],
        ['delete_broadcast', 'destructive'],
        ['send_broadcast_test', 'write'],
        ['create_broadcast_draft', 'write'],
      ])
    );
  });
});

describe('read tools', () => {
  it("list_broadcasts shows this account's funnel only", async () => {
    const fx = world();
    const r = await call(fx, 'list_broadcasts', {});
    expect(r.items.map((b: any) => b.id)).toEqual([B1]);
    expect(r.items[0].funnel).toEqual({ sent: 2, delivered: 1, read: 1, replied: 0, failed: 0 });
  });

  it('list_broadcasts paginates with an opaque cursor', async () => {
    const fx = world();
    fx.tables.broadcasts.push({ id: 'b3', account_id: ACC, name: 'Aug', status: 'sent', created_at: '2026-01-04T00:00:00Z' });
    const r = await call(fx, 'list_broadcasts', { limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(typeof r.next_cursor).toBe('string');
  });

  it("another account's broadcast is not_found", async () => {
    const fx = world();
    for (const name of ['get_broadcast', 'get_broadcast_recipients', 'export_broadcast_recipients', 'resume_broadcast', 'delete_broadcast']) {
      await expect(call(fx, name, { broadcast_id: B2, confirm: true })).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(call(fx, 'send_broadcast_test', { phone: '+14155550101', broadcast_id: B2 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('get_broadcast_recipients filters by status and returns names, not phones', async () => {
    const fx = world();
    const r = await call(fx, 'get_broadcast_recipients', { broadcast_id: B1, status: 'failed' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ contact_id: C2, contact_name: 'Ben', status: 'failed', error: 'bad' });
    noPhones(r);
  });

  it('export_broadcast_recipients returns CSV without phones and neutralises formulas', async () => {
    const fx = world();
    fx.tables.contacts.find((c) => c.id === C1)!.name = '=HYPERLINK("x")';
    const r = await call(fx, 'export_broadcast_recipients', { broadcast_id: B1 });
    expect(r.row_count).toBe(2);
    expect(r.csv.split('\n')[0]).toContain('contact_name');
    expect(r.csv).toContain(`"'=HYPERLINK(""x"")"`);
    noPhones(r);
  });

  it('estimate_audience counts customers (staff excluded), samples names and estimates cost', async () => {
    const fx = world();
    const r = await call(fx, 'estimate_audience', { audience: { type: 'all' }, template_name: 'promo' });
    expect(r.recipients).toBe(2);
    expect(r.sample_names.sort()).toEqual(['Asha', 'Ben']);
    expect(r.estimated_cost).toMatchObject({ category: 'marketing', recipients: 2 });
    expect(r.estimated_cost.total_inr).toBeCloseTo(2 * 0.8631, 2);
    noPhones(r);

    const tags = await call(fx, 'estimate_audience', { audience: { type: 'tags', tag_ids: [T1] } });
    expect(tags.recipients).toBe(1);
    expect(tags.staff_excluded).toBe(1);
    expect(tags.estimated_cost).toBeNull();
    expect(tags.cost_note).toMatch(/template_name/);
  });

  it('estimate_audience refuses ids from another account', async () => {
    const fx = world();
    await expect(call(fx, 'estimate_audience', { audience: { type: 'tags', tag_ids: [TX] } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(fx, 'estimate_audience', { audience: { type: 'contacts', contact_ids: ['00000000-0000-4000-8000-0000000000aa'] } })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('read tools need broadcasts:read', async () => {
    const fx = world();
    await expect(call(fx, 'list_broadcasts', {}, ['broadcasts:send'])).rejects.toMatchObject({ code: 'missing_scope' });
  });
});

describe('create_broadcast_draft', () => {
  it('stores variables, button values and header link in the wizard\'s shape', async () => {
    const fx = world();
    const r = await call(fx, 'create_broadcast_draft', { name: 'Draft', template_name: 'promo', variables: FIELD_NAME, button_variables: BUTTON });
    const saved = fx.tables.broadcasts.find((b) => b.id === r.broadcast_id)!;
    expect(saved).toMatchObject({ account_id: ACC, status: 'draft', template_name: 'promo', user_id: 'user-1' });
    expect(saved.template_variables).toEqual({ '1': { type: 'field', value: 'name' }, buttons: { '0': { type: 'static', value: 'summer' } } });
  });

  it('dry run saves nothing', async () => {
    const fx = world();
    const before = fx.tables.broadcasts.length;
    const r = await call(fx, 'create_broadcast_draft', { name: 'D', template_name: 'promo', variables: FIELD_NAME, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(fx.tables.broadcasts).toHaveLength(before);
  });

  it('rejects an audience with another account\'s tag', async () => {
    const fx = world();
    await expect(
      call(fx, 'create_broadcast_draft', { name: 'D', template_name: 'promo', audience: { type: 'tags', tag_ids: [TX] } })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('send_broadcast_test', () => {
  it('dry run returns the exact Meta payload, sends nothing, and shows no phone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fx = world();
    const r = await call(fx, 'send_broadcast_test', { phone: PHONES[0], template_name: 'promo', variables: FIELD_NAME, button_variables: BUTTON, dry_run: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.contact_found).toBe(true);
    expect(r.payload.template).toEqual({
      name: 'promo',
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'summer' }] },
      ],
    });
    noPhones(r);
  });

  it('sends the same template payload the dry run showed, to the one phone', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const fx = world();
    const args = { phone: PHONES[0], template_name: 'promo', variables: FIELD_NAME, button_variables: BUTTON };
    const dry = await call(fx, 'send_broadcast_test', { ...args, dry_run: true });
    const real = await call(fx, 'send_broadcast_test', args);
    expect(real).toMatchObject({ sent: true, whatsapp_message_id: 'wamid.1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('/pn-1/messages');
    const body = JSON.parse(init.body);
    expect(body.template).toEqual(dry.payload.template);
    expect(body.to).toBe(PHONES[0].slice(1));
    noPhones(real);
  });

  it('uses a saved broadcast\'s template and values, and a "Test" stand-in for unknown numbers', async () => {
    const fx = world();
    fx.tables.broadcasts.find((b) => b.id === B1)!.template_variables = { ...FIELD_NAME, buttons: BUTTON };
    const r = await call(fx, 'send_broadcast_test', { phone: '+14155559999', broadcast_id: B1, dry_run: true });
    expect(r.contact_found).toBe(false);
    expect(r.payload.template.components[0].parameters[0].text).toBe('Test');
  });

  it('refuses a missing button value, a missing media header and an unapproved template', async () => {
    const fx = world();
    await expect(call(fx, 'send_broadcast_test', { phone: PHONES[0], template_name: 'promo', variables: FIELD_NAME })).rejects.toMatchObject({ code: 'button_param_missing' });

    fx.tables.message_templates.push({ ...TEMPLATE, id: 'tpl-2', name: 'banner', header_type: 'image', buttons: [], body_text: 'Hello' });
    await expect(call(fx, 'send_broadcast_test', { phone: PHONES[0], template_name: 'banner', dry_run: true })).rejects.toMatchObject({ code: 'invalid_input', field: 'header_media_url' });
    const ok = await call(fx, 'send_broadcast_test', { phone: PHONES[0], template_name: 'banner', header_media_url: 'https://cdn.test/a.png', dry_run: true });
    expect(ok.payload.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.test/a.png' } }] });

    fx.tables.message_templates.push({ ...TEMPLATE, id: 'tpl-3', name: 'pending_one', status: 'PENDING', buttons: [] });
    await expect(call(fx, 'send_broadcast_test', { phone: PHONES[0], template_name: 'pending_one', variables: FIELD_NAME })).rejects.toMatchObject({ code: 'template_not_approved' });
  });

  it('refuses an invalid phone and a template from another account', async () => {
    const fx = world();
    await expect(call(fx, 'send_broadcast_test', { phone: '12ab', template_name: 'promo', variables: FIELD_NAME, button_variables: BUTTON })).rejects.toMatchObject({ code: 'invalid_input', field: 'phone' });
    fx.tables.message_templates.push({ ...TEMPLATE, id: 'tpl-x', account_id: OTHER, name: 'theirs' });
    await expect(call(fx, 'send_broadcast_test', { phone: PHONES[0], template_name: 'theirs', variables: FIELD_NAME })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('send_broadcast', () => {
  it('needs confirm to run, but a dry run does not', async () => {
    const fx = world();
    await expect(call(fx, 'send_broadcast', baseSend)).rejects.toMatchObject({ code: 'confirm_required' });
    const r = await call(fx, 'send_broadcast', { ...baseSend, dry_run: true });
    expect(r.dry_run).toBe(true);
  });

  it('dry run: count (staff excluded), exact first payload, cost; creates and sends nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fx = world();
    const r = await call(fx, 'send_broadcast', { ...baseSend, dry_run: true });
    expect(r.recipients).toBe(2);
    expect(r.first_recipient_payload.template.components[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] });
    expect(r.estimated_cost.total_inr).toBeCloseTo(2 * 0.8631, 2);
    expect(fx.rpcCalls).toHaveLength(0);
    expect(fx.tables.broadcasts).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    noPhones(r);
  });

  it('never includes staff, even for "all", tags, explicit ids and phone lists', async () => {
    for (const audience of [
      { type: 'all' },
      { type: 'tags', tag_ids: [T1] },
      { type: 'contacts', contact_ids: ['00000000-0000-4000-8000-0000000000a1'] },
      { type: 'phones', phones: [PHONES[0], PHONES[2]] },
    ]) {
      const fx = world();
      if (audience.type === 'contacts') {
        fx.tables.contacts.push({ id: '00000000-0000-4000-8000-0000000000a1', account_id: ACC, name: 'Z', phone: '+14155550177', is_staff: true });
      }
      const r = await call(fx, 'send_broadcast', { ...baseSend, audience, dry_run: true }).catch((e) => e);
      if (audience.type === 'contacts') {
        // Only staff named: nothing left to send.
        expect(r).toMatchObject({ code: 'invalid_input' });
      } else {
        expect(r.recipients).toBe(audience.type === 'phones' ? 1 : audience.type === 'tags' ? 1 : 2);
      }
    }
  });

  it('refuses before sending: missing button value, missing body value, unapproved template, over the cap', async () => {
    const fx = world();
    await expect(call(fx, 'send_broadcast', { ...baseSend, button_variables: {}, dry_run: true })).rejects.toMatchObject({ code: 'button_param_missing' });
    await expect(call(fx, 'send_broadcast', { ...baseSend, variables: {}, dry_run: true })).rejects.toMatchObject({ code: 'invalid_input', field: 'variables' });
    fx.tables.message_templates.push({ ...TEMPLATE, id: 'tpl-p', name: 'draft_t', status: 'REJECTED', buttons: [] });
    await expect(call(fx, 'send_broadcast', { ...baseSend, template_name: 'draft_t', dry_run: true })).rejects.toMatchObject({ code: 'template_not_approved' });

    for (let i = 0; i < 1001; i++) fx.tables.contacts.push({ id: u(1000 + i), account_id: ACC, name: `n${i}`, phone: `+1415556${String(i).padStart(4, '0')}`, is_staff: false });
    await expect(call(fx, 'send_broadcast', { ...baseSend, dry_run: true })).rejects.toMatchObject({ code: 'invalid_input', field: 'audience' });
    expect(fx.rpcCalls).toHaveLength(0);
  });

  it('creates the broadcast atomically, freezes per-recipient params and delivers via the shared path', async () => {
    const fx = world();
    const r = await call(fx, 'send_broadcast', { ...baseSend, confirm: true, idempotency_key: 'k-1' });
    expect(r).toMatchObject({ recipients: 2 });
    expect(fx.rpcCalls).toHaveLength(1);
    const rpc = fx.rpcCalls[0].args;
    expect(rpc.p_account_id).toBe(ACC);
    expect(rpc.p_contact_ids).toEqual([C1, C2]);
    expect(rpc.p_template_params).toEqual([
      { body: ['Asha'], buttonParams: { 0: 'summer' } },
      { body: ['Ben'], buttonParams: { 0: 'summer' } },
    ]);

    const saved = fx.tables.broadcasts.find((b) => b.id === r.broadcast_id)!;
    expect(saved.template_variables).toEqual({ ...FIELD_NAME, buttons: BUTTON });

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const plan = (mocks.deliver.mock.calls[0] as unknown as [unknown, any])[1];
    expect(plan.broadcastId).toBe(r.broadcast_id);
    expect(plan.planned.map((p: any) => p.params)).toEqual([['Asha'], ['Ben']]);
    expect(plan.planned[0].messageParams.buttonParams).toEqual({ 0: 'summer' });
    // The delivery lock is released once the pass is done.
    expect(saved.delivery_locked_at).toBeNull();
    noPhones(r);
  });

  it('refuses when WhatsApp is not connected, and creates nothing', async () => {
    const fx = world();
    fx.tables.whatsapp_config.length = 0;
    await expect(call(fx, 'send_broadcast', { ...baseSend, confirm: true })).rejects.toMatchObject({ code: 'conflict' });
    expect(fx.rpcCalls).toHaveLength(0);
  });
});

describe('resume_broadcast', () => {
  it('dry run counts what would go out for the scope', async () => {
    const fx = world();
    const r = await call(fx, 'resume_broadcast', { broadcast_id: B1, scope: 'failed', dry_run: true });
    expect(r.would_send).toBe(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('retries only the failed recipients and releases the lock', async () => {
    const fx = world();
    const r = await call(fx, 'resume_broadcast', { broadcast_id: B1, scope: 'failed', confirm: true });
    expect(r).toMatchObject({ resuming: 1, remaining: 0 });
    const plan = (mocks.deliver.mock.calls[0] as unknown as [unknown, any])[1];
    expect(plan.planned.map((p: any) => p.recipientRowId)).toEqual([R2]);
    expect(fx.tables.broadcasts.find((b) => b.id === B1)!.delivery_locked_at).toBeNull();
  });

  it('refuses while another pass holds the delivery lock', async () => {
    const fx = world();
    fx.tables.broadcasts.find((b) => b.id === B1)!.delivery_locked_at = new Date().toISOString();
    await expect(call(fx, 'resume_broadcast', { broadcast_id: B1, scope: 'all', confirm: true })).rejects.toMatchObject({ code: 'conflict' });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('says so when nothing is left to send and releases the lock', async () => {
    const fx = world();
    await expect(call(fx, 'resume_broadcast', { broadcast_id: B1, scope: 'pending', confirm: true })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fx.tables.broadcasts.find((b) => b.id === B1)!.delivery_locked_at).toBeNull();
  });
});

describe('delete_broadcast', () => {
  it('refuses while sending', async () => {
    const fx = world();
    fx.tables.broadcasts.find((b) => b.id === B1)!.status = 'sending';
    await expect(call(fx, 'delete_broadcast', { broadcast_id: B1, confirm: true })).rejects.toBeInstanceOf(McpToolError);
    expect(fx.tables.broadcasts.some((b) => b.id === B1)).toBe(true);
  });

  it('dry run keeps it; confirm deletes only this account\'s broadcast', async () => {
    const fx = world();
    const dry = await call(fx, 'delete_broadcast', { broadcast_id: B1, dry_run: true });
    expect(dry.would_delete.broadcast_id).toBe(B1);
    expect(fx.tables.broadcasts.some((b) => b.id === B1)).toBe(true);
    await call(fx, 'delete_broadcast', { broadcast_id: B1, confirm: true });
    expect(fx.tables.broadcasts.some((b) => b.id === B1)).toBe(false);
    expect(fx.tables.broadcasts.some((b) => b.id === B2)).toBe(true);
  });
});
