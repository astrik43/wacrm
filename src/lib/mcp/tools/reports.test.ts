import { describe, expect, it } from 'vitest';

import { fakeDb } from '@/lib/reports/fake-db';

import { runTool, type CallerContext } from '../executor';
import { reportsTools } from './reports';

const A = 'acc-a';
const B = 'acc-b';
const NOW = new Date();
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function tool(name: string) {
  const t = reportsTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

function seed() {
  return fakeDb({
    contacts: [
      { id: 'c-cust', account_id: A, phone: '+911111111111', is_staff: false, created_at: iso(60) },
      { id: 'c-staff', account_id: A, phone: '+912222222222', is_staff: true, created_at: iso(60) },
      { id: 'c-other', account_id: B, phone: '+913333333333', is_staff: false, created_at: iso(60) },
    ],
    conversations: [
      { id: 'v-cust', account_id: A, contact_id: 'c-cust', status: 'closed', assigned_agent_id: 'u-1', created_at: iso(120), updated_at: iso(30) },
      { id: 'v-staff', account_id: A, contact_id: 'c-staff', status: 'open', assigned_agent_id: 'u-1', created_at: iso(120), updated_at: iso(30) },
      { id: 'v-other', account_id: B, contact_id: 'c-other', status: 'open', assigned_agent_id: 'u-9', created_at: iso(120), updated_at: iso(30) },
    ],
    messages: [
      // customer conversation: answered after 10 minutes
      { conversation_id: 'v-cust', sender_type: 'customer', sender_id: null, created_at: iso(100) },
      { conversation_id: 'v-cust', sender_type: 'agent', sender_id: 'u-1', created_at: iso(90) },
      // staff conversation: answered after 1 minute, must not count
      { conversation_id: 'v-staff', sender_type: 'customer', sender_id: null, created_at: iso(100) },
      { conversation_id: 'v-staff', sender_type: 'agent', sender_id: 'u-1', created_at: iso(99) },
      // other account
      { conversation_id: 'v-other', sender_type: 'customer', sender_id: null, created_at: iso(100) },
      { conversation_id: 'v-other', sender_type: 'agent', sender_id: 'u-9', created_at: iso(50) },
    ],
    profiles: [
      { user_id: 'u-1', account_id: A, full_name: 'Asha' },
      { user_id: 'u-9', account_id: B, full_name: 'Other' },
    ],
    broadcasts: [
      { id: 'b-1', account_id: A, name: 'Sale', template_name: 't', status: 'sent', created_at: iso(200) },
      { id: 'b-2', account_id: B, name: 'Hidden', template_name: 't', status: 'sent', created_at: iso(200) },
    ],
    broadcast_recipients: [
      { id: 'r1', broadcast_id: 'b-1', contact_id: 'c-cust', status: 'read', whatsapp_message_id: 'w1' },
      { id: 'r2', broadcast_id: 'b-1', contact_id: 'c-staff', status: 'delivered', whatsapp_message_id: 'w2' },
      { id: 'r3', broadcast_id: 'b-2', contact_id: 'c-other', status: 'read', whatsapp_message_id: 'w3' },
    ],
    message_charges: [
      { id: 'm1', account_id: A, whatsapp_message_id: 'w1', recipient: '911111111111', status: 'delivered', pricing_category: 'marketing', billable: true, created_at: iso(190) },
      { id: 'm2', account_id: A, whatsapp_message_id: 'w2', recipient: '912222222222', status: 'delivered', pricing_category: 'marketing', billable: true, created_at: iso(190) },
      { id: 'm3', account_id: B, whatsapp_message_id: 'w3', recipient: '913333333333', status: 'delivered', pricing_category: 'marketing', billable: true, created_at: iso(190) },
    ],
    tags: [
      { id: 't-1', account_id: A, name: 'vip', color: '#000' },
      { id: 't-2', account_id: B, name: 'other', color: '#000' },
    ],
    contact_tags: [
      { id: 'x1', contact_id: 'c-cust', tag_id: 't-1' },
      { id: 'x2', contact_id: 'c-staff', tag_id: 't-1' },
      { id: 'x3', contact_id: 'c-other', tag_id: 't-2' },
    ],
    pipelines: [
      { id: 'p-1', account_id: A, name: 'Sales' },
      { id: 'p-2', account_id: B, name: 'Theirs' },
    ],
    pipeline_stages: [
      { id: 's-1', pipeline_id: 'p-1', name: 'New', position: 0 },
      { id: 's-2', pipeline_id: 'p-2', name: 'Theirs', position: 0 },
    ],
    deals: [
      { id: 'd1', account_id: A, stage_id: 's-1', contact_id: 'c-cust', value: 100, status: 'open' },
      { id: 'd2', account_id: A, stage_id: 's-1', contact_id: 'c-staff', value: 900, status: 'open' },
      { id: 'd3', account_id: B, stage_id: 's-2', contact_id: 'c-other', value: 500, status: 'open' },
    ],
  });
}

function caller(db: ReturnType<typeof seed>['db'], scopes = ['reports:read']): CallerContext {
  return { supabase: db, accountId: A, keyId: 'k', scopes, createdBy: null };
}

describe('reports tools', () => {
  it('uses reports:read and the read tier for every tool', () => {
    for (const t of reportsTools) {
      expect(t.tier).toBe('read');
      expect(t.scope).toBe('reports:read');
    }
  });

  it('refuses a key without the reports scope', async () => {
    const { db } = seed();
    await expect(
      runTool(tool('get_dashboard_summary'), caller(db, ['tags:read']), {})
    ).rejects.toMatchObject({ code: 'missing_scope' });
  });

  it('dashboard summary excludes staff conversations, response time and contacts', async () => {
    const { db } = seed();
    const r = (await runTool(tool('get_dashboard_summary'), caller(db), { days: 7 })) as {
      conversations_opened: number;
      conversations_closed: number;
      open_conversations_now: number;
      new_contacts: number;
      response_time_minutes: { average: number; samples: number };
      messages_per_day: { inbound: number; outbound: number }[];
    };
    expect(r.conversations_opened).toBe(1);
    expect(r.conversations_closed).toBe(1);
    // the only open conversation of this account belongs to staff
    expect(r.open_conversations_now).toBe(0);
    expect(r.new_contacts).toBe(1);
    // 10 minutes (customer), not 1 (staff) or 50 (other account)
    expect(r.response_time_minutes).toMatchObject({ average: 10, samples: 1 });
    const inbound = r.messages_per_day.reduce((s, d) => s + d.inbound, 0);
    expect(inbound).toBe(1);
  });

  it('agent performance ignores staff chats and other accounts', async () => {
    const { db } = seed();
    const r = (await runTool(tool('get_agent_performance'), caller(db), { days: 7 })) as {
      items: { name: string; chats_handled: number; first_response_minutes: { average: number } }[];
    };
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: 'Asha', chats_handled: 1 });
    expect(r.items[0].first_response_minutes.average).toBe(10);
  });

  it('broadcast performance leaves staff recipients out and hides other accounts', async () => {
    const { db } = seed();
    const r = (await runTool(tool('get_broadcast_performance'), caller(db), { days: 7 })) as {
      items: { id: string; recipients: number; staff_excluded: number; read: number }[];
    };
    expect(r.items.map((b) => b.id)).toEqual(['b-1']);
    expect(r.items[0]).toMatchObject({ recipients: 1, staff_excluded: 1, read: 1 });
  });

  it('spend report skips staff recipients and other accounts', async () => {
    const { db } = seed();
    const r = (await runTool(tool('get_spend_report'), caller(db), { days: 7 })) as {
      totals: { messages: number; amount: number };
      staff_excluded: number;
      per_broadcast: { broadcast_id: string; messages: number }[];
    };
    expect(r.totals.messages).toBe(1);
    expect(r.totals.amount).toBeCloseTo(0.86, 2);
    expect(r.staff_excluded).toBe(1);
    expect(r.per_broadcast).toEqual([expect.objectContaining({ broadcast_id: 'b-1', messages: 1 })]);
  });

  it('top tags and deal value skip staff contacts', async () => {
    const { db } = seed();
    const tags = (await runTool(tool('get_top_tags'), caller(db), {})) as {
      items: { name: string; contacts: number }[];
    };
    expect(tags.items).toEqual([expect.objectContaining({ name: 'vip', contacts: 1 })]);

    const deals = (await runTool(tool('get_deal_value_by_stage'), caller(db), {})) as {
      items: { stage: string; deals: number; total_value: number }[];
      total_value: number;
    };
    expect(deals.items).toEqual([expect.objectContaining({ stage: 'New', deals: 1, total_value: 100 })]);
    expect(deals.total_value).toBe(100);
  });

  it('rejects an unparseable date', async () => {
    const { db } = seed();
    await expect(
      runTool(tool('get_spend_report'), caller(db), { from: 'not-a-date' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
