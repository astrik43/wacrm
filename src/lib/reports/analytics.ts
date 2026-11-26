// ============================================================
// Account-scoped analytics queries (server-only, service-role safe).
//
// The dashboard's own queries (src/lib/dashboard/queries.ts) run in
// the browser and rely on RLS to scope rows, so they cannot be reused
// with a service-role client. These take an explicit accountId and
// filter every query by it.
//
// Staff contacts (`contacts.is_staff`) are internal team members, not
// customers: every customer metric below leaves them out.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { estimateChargeInr, GST_RATE } from '@/lib/billing/charges';

type Db = SupabaseClient;
type Row = Record<string, unknown>;

/** Rows read per metric. Far above a month's volume for one WhatsApp number. */
export const MAX_ROWS = 20000;
const PAGE = 1000;
const IN_CHUNK = 100;

export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** `days` back from now (default 30, max 366), or an explicit from / to. */
export function resolveRange(opts: { days?: number; from?: string; to?: string }): DateRange {
  const to = opts.to ? new Date(opts.to) : new Date();
  const toMs = Number.isNaN(to.getTime()) ? Date.now() : to.getTime();
  const from = opts.from ? new Date(opts.from) : null;
  const fromMs =
    from && !Number.isNaN(from.getTime())
      ? from.getTime()
      : toMs - Math.min(Math.max(opts.days ?? 30, 1), 366) * DAY_MS;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

type PageResult = { data: unknown[] | null; error: { message: string } | null };

/** Read every row of a query, a page at a time (PostgREST caps a response). */
export async function fetchAll<T = Row>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
  cap = MAX_ROWS
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

export interface StaffSet {
  ids: Set<string>;
  /** Digits-only phones, to match message_charges.recipient. */
  phones: Set<string>;
}

/** The account's internal team contacts, which customer metrics skip. */
export async function loadStaff(db: Db, accountId: string): Promise<StaffSet> {
  const { rows } = await fetchAll<{ id: string; phone: string | null }>((a, b) =>
    db
      .from('contacts')
      .select('id, phone')
      .eq('account_id', accountId)
      .eq('is_staff', true)
      .order('id')
      .range(a, b)
  );
  return {
    ids: new Set(rows.map((r) => r.id)),
    phones: new Set(rows.map((r) => digits(r.phone)).filter(Boolean)),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function avg(xs: number[]): number | null {
  return xs.length === 0 ? null : round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// --- conversations + messages (non-staff only) -------------------------

interface Conv {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  created_at: string;
  updated_at: string;
}
interface Msg {
  conversation_id: string;
  sender_type: string;
  sender_id: string | null;
  created_at: string;
}

/** Conversations touched since `from`, customers only. */
async function loadCustomerConversations(
  db: Db,
  accountId: string,
  from: string,
  staff: StaffSet
): Promise<{ convs: Conv[]; truncated: boolean }> {
  const { rows, truncated } = await fetchAll<Conv>((a, b) =>
    db
      .from('conversations')
      .select('id, contact_id, status, assigned_agent_id, created_at, updated_at')
      .eq('account_id', accountId)
      .gte('updated_at', from)
      .order('id')
      .range(a, b)
  );
  return { convs: rows.filter((c) => !staff.ids.has(c.contact_id)), truncated };
}

/** Messages of these conversations in the range, oldest first per conversation. */
async function loadMessages(db: Db, convIds: string[], range: DateRange): Promise<Msg[]> {
  const out: Msg[] = [];
  for (const part of chunks(convIds)) {
    const { rows } = await fetchAll<Msg>((a, b) =>
      db
        .from('messages')
        .select('conversation_id, sender_type, sender_id, created_at')
        .in('conversation_id', part)
        .gte('created_at', range.from)
        .lt('created_at', range.to)
        .order('created_at')
        .range(a, b)
    );
    out.push(...rows);
  }
  return out.sort((x, y) =>
    x.conversation_id === y.conversation_id
      ? x.created_at.localeCompare(y.created_at)
      : x.conversation_id.localeCompare(y.conversation_id)
  );
}

export interface ResponseSample {
  conversationId: string;
  minutes: number;
  responderType: string;
  responderId: string | null;
}

/**
 * Pair each unanswered customer message with the next outbound one.
 * Input must be sorted by conversation then time. Same rule as the
 * dashboard's response-time chart.
 */
export function responseSamples(messages: Msg[]): ResponseSample[] {
  const samples: ResponseSample[] = [];
  let current = '';
  let pending: number | null = null;
  for (const m of messages) {
    if (m.conversation_id !== current) {
      current = m.conversation_id;
      pending = null;
    }
    const ts = Date.parse(m.created_at);
    if (m.sender_type === 'customer') {
      if (pending === null) pending = ts;
    } else if (pending !== null) {
      samples.push({
        conversationId: m.conversation_id,
        minutes: (ts - pending) / 60_000,
        responderType: m.sender_type,
        responderId: m.sender_id,
      });
      pending = null;
    }
  }
  return samples.filter((s) => s.minutes >= 0);
}

export async function dashboardSummary(db: Db, accountId: string, range: DateRange) {
  const staff = await loadStaff(db, accountId);
  const { convs, truncated } = await loadCustomerConversations(db, accountId, range.from, staff);
  const inRange = (iso: string) => iso >= range.from && iso < range.to;

  const messages = await loadMessages(
    db,
    convs.map((c) => c.id),
    range
  );

  const perDay = new Map<string, { inbound: number; outbound: number }>();
  for (const m of messages) {
    const day = m.created_at.slice(0, 10);
    const bucket = perDay.get(day) ?? { inbound: 0, outbound: 0 };
    if (m.sender_type === 'customer') bucket.inbound++;
    else bucket.outbound++;
    perDay.set(day, bucket);
  }

  const minutes = responseSamples(messages).map((s) => s.minutes);

  const openNow = await fetchAll<{ id: string; contact_id: string }>((a, b) =>
    db
      .from('conversations')
      .select('id, contact_id')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .order('id')
      .range(a, b)
  );
  const newContacts = await fetchAll<{ id: string }>((a, b) =>
    db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_staff', false)
      .gte('created_at', range.from)
      .lt('created_at', range.to)
      .order('id')
      .range(a, b)
  );

  return {
    range,
    conversations_opened: convs.filter((c) => inRange(c.created_at)).length,
    // "Closed" is when a closed conversation was last touched in the range.
    conversations_closed: convs.filter((c) => c.status === 'closed' && inRange(c.updated_at))
      .length,
    open_conversations_now: openNow.rows.filter((c) => !staff.ids.has(c.contact_id)).length,
    new_contacts: newContacts.rows.length,
    messages_per_day: [...perDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v })),
    response_time_minutes: {
      average: avg(minutes),
      median: median(minutes),
      samples: minutes.length,
    },
    staff_excluded: true,
    truncated: truncated || newContacts.truncated,
  };
}

// --- broadcasts ----------------------------------------------------------

const DELIVERED = new Set(['delivered', 'read', 'replied']);
const READ = new Set(['read', 'replied']);

export async function broadcastPerformance(
  db: Db,
  accountId: string,
  range: DateRange,
  limit: number
) {
  const staff = await loadStaff(db, accountId);
  const { data } = await db
    .from('broadcasts')
    .select('id, name, template_name, status, created_at')
    .eq('account_id', accountId)
    .gte('created_at', range.from)
    .lt('created_at', range.to)
    .order('created_at', { ascending: false })
    .limit(limit);
  const broadcasts = (data ?? []) as {
    id: string;
    name: string;
    template_name: string;
    status: string;
    created_at: string;
  }[];

  const recipients: { broadcast_id: string; contact_id: string; status: string }[] = [];
  for (const part of chunks(broadcasts.map((b) => b.id))) {
    const { rows } = await fetchAll<(typeof recipients)[number]>((a, b) =>
      db
        .from('broadcast_recipients')
        .select('broadcast_id, contact_id, status')
        .in('broadcast_id', part)
        .order('id')
        .range(a, b)
    );
    recipients.push(...rows);
  }

  const rate = (n: number, d: number) => (d === 0 ? null : round1((n / d) * 100));
  const items = broadcasts.map((b) => {
    const all = recipients.filter((r) => r.broadcast_id === b.id);
    const mine = all.filter((r) => !staff.ids.has(r.contact_id));
    const count = (pred: (s: string) => boolean) => mine.filter((r) => pred(r.status)).length;
    const attempted = count((s) => s !== 'pending');
    const delivered = count((s) => DELIVERED.has(s));
    const read = count((s) => READ.has(s));
    const replied = count((s) => s === 'replied');
    const failed = count((s) => s === 'failed');
    return {
      id: b.id,
      name: b.name,
      template_name: b.template_name,
      status: b.status,
      created_at: b.created_at,
      recipients: mine.length,
      staff_excluded: all.length - mine.length,
      sent: attempted,
      delivered,
      read,
      replied,
      failed,
      delivery_rate_pct: rate(delivered, attempted),
      read_rate_pct: rate(read, delivered),
      reply_rate_pct: rate(replied, delivered),
    };
  });
  return { range, items };
}

// --- tags ------------------------------------------------------------------

export async function topTags(db: Db, accountId: string, limit: number) {
  const staff = await loadStaff(db, accountId);
  const { rows: tags } = await fetchAll<{ id: string; name: string; color: string | null }>(
    (a, b) =>
      db.from('tags').select('id, name, color').eq('account_id', accountId).order('id').range(a, b)
  );
  const byTag = new Map<string, number>();
  for (const part of chunks(tags.map((t) => t.id))) {
    const { rows } = await fetchAll<{ contact_id: string; tag_id: string }>((a, b) =>
      db
        .from('contact_tags')
        .select('contact_id, tag_id')
        .in('tag_id', part)
        .order('id')
        .range(a, b)
    );
    for (const r of rows) {
      if (staff.ids.has(r.contact_id)) continue;
      byTag.set(r.tag_id, (byTag.get(r.tag_id) ?? 0) + 1);
    }
  }
  return tags
    .map((t) => ({ tag_id: t.id, name: t.name, color: t.color, contacts: byTag.get(t.id) ?? 0 }))
    .sort((a, b) => b.contacts - a.contacts || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// --- deals -----------------------------------------------------------------

export async function dealValueByStage(
  db: Db,
  accountId: string,
  status: 'open' | 'won' | 'lost'
) {
  const staff = await loadStaff(db, accountId);
  const { rows: pipelines } = await fetchAll<{ id: string; name: string }>((a, b) =>
    db.from('pipelines').select('id, name').eq('account_id', accountId).order('id').range(a, b)
  );
  const stages: { id: string; pipeline_id: string; name: string; position: number }[] = [];
  for (const part of chunks(pipelines.map((p) => p.id))) {
    const { rows } = await fetchAll<(typeof stages)[number]>((a, b) =>
      db
        .from('pipeline_stages')
        .select('id, pipeline_id, name, position')
        .in('pipeline_id', part)
        .order('id')
        .range(a, b)
    );
    stages.push(...rows);
  }
  const { rows: deals } = await fetchAll<{
    stage_id: string;
    contact_id: string;
    value: number | string | null;
  }>((a, b) =>
    db
      .from('deals')
      .select('stage_id, contact_id, value')
      .eq('account_id', accountId)
      .eq('status', status)
      .order('id')
      .range(a, b)
  );
  const agg = new Map<string, { count: number; total: number }>();
  for (const d of deals) {
    if (staff.ids.has(d.contact_id)) continue;
    const cur = agg.get(d.stage_id) ?? { count: 0, total: 0 };
    cur.count++;
    cur.total += Number(d.value ?? 0);
    agg.set(d.stage_id, cur);
  }
  const pipelineName = new Map(pipelines.map((p) => [p.id, p.name]));
  const items = stages
    .sort((a, b) => a.pipeline_id.localeCompare(b.pipeline_id) || a.position - b.position)
    .map((s) => ({
      pipeline_id: s.pipeline_id,
      pipeline: pipelineName.get(s.pipeline_id) ?? null,
      stage_id: s.id,
      stage: s.name,
      deals: agg.get(s.id)?.count ?? 0,
      total_value: round2(agg.get(s.id)?.total ?? 0),
    }));
  return { status, items, total_value: round2(items.reduce((s, i) => s + i.total_value, 0)) };
}

// --- spend -------------------------------------------------------------------

interface ChargeRow {
  whatsapp_message_id: string;
  recipient: string | null;
  status: string;
  pricing_category: string | null;
  billable: boolean | null;
  created_at: string;
}

export async function spendReport(db: Db, accountId: string, range: DateRange) {
  const staff = await loadStaff(db, accountId);
  const { rows: all, truncated } = await fetchAll<ChargeRow>((a, b) =>
    db
      .from('message_charges')
      .select('whatsapp_message_id, recipient, status, pricing_category, billable, created_at')
      .eq('account_id', accountId)
      .gte('created_at', range.from)
      .lt('created_at', range.to)
      .order('created_at')
      .range(a, b)
  );
  // Messages to the team are not customer spend.
  const rows = all.filter((r) => !staff.phones.has(digits(r.recipient)));

  const byMonth = new Map<string, { messages: number; amount: number }>();
  const byCategory = new Map<string, { messages: number; billable: number; amount: number }>();
  let amount = 0;
  for (const r of rows) {
    const cost = estimateChargeInr(r);
    amount += cost;
    const month = r.created_at.slice(0, 7);
    const m = byMonth.get(month) ?? { messages: 0, amount: 0 };
    m.messages++;
    m.amount += cost;
    byMonth.set(month, m);
    const cat = r.pricing_category ?? 'unknown';
    const c = byCategory.get(cat) ?? { messages: 0, billable: 0, amount: 0 };
    c.messages++;
    if (cost > 0) c.billable++;
    c.amount += cost;
    byCategory.set(cat, c);
  }

  // Cost per broadcast: tie each charge to its broadcast through the
  // recipient row that carries the same message id.
  const { data: bData } = await db
    .from('broadcasts')
    .select('id, name')
    .eq('account_id', accountId)
    .gte('created_at', new Date(Date.parse(range.from) - 7 * DAY_MS).toISOString())
    .lt('created_at', range.to)
    .limit(200);
  const broadcasts = (bData ?? []) as { id: string; name: string }[];
  const wamidToBroadcast = new Map<string, string>();
  for (const part of chunks(broadcasts.map((b) => b.id))) {
    const { rows: recips } = await fetchAll<{
      broadcast_id: string;
      whatsapp_message_id: string | null;
    }>((a, b) =>
      db
        .from('broadcast_recipients')
        .select('broadcast_id, whatsapp_message_id')
        .in('broadcast_id', part)
        .order('id')
        .range(a, b)
    );
    for (const r of recips) {
      if (r.whatsapp_message_id) wamidToBroadcast.set(r.whatsapp_message_id, r.broadcast_id);
    }
  }
  const perBroadcast = new Map<string, { messages: number; amount: number }>();
  for (const r of rows) {
    const id = wamidToBroadcast.get(r.whatsapp_message_id);
    if (!id) continue;
    const cur = perBroadcast.get(id) ?? { messages: 0, amount: 0 };
    cur.messages++;
    cur.amount += estimateChargeInr(r);
    perBroadcast.set(id, cur);
  }

  const name = new Map(broadcasts.map((b) => [b.id, b.name]));
  return {
    range,
    currency: 'INR',
    note: 'Estimated from Meta India rates before GST; Meta publishes the official totals.',
    totals: {
      messages: rows.length,
      amount: round2(amount),
      gst: round2(amount * GST_RATE),
      total_with_gst: round2(amount * (1 + GST_RATE)),
    },
    by_month: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, messages: v.messages, amount: round2(v.amount) })),
    by_category: [...byCategory.entries()]
      .sort(([, a], [, b]) => b.amount - a.amount)
      .map(([category, v]) => ({
        category,
        messages: v.messages,
        billable: v.billable,
        amount: round2(v.amount),
      })),
    per_broadcast: [...perBroadcast.entries()]
      .sort(([, a], [, b]) => b.amount - a.amount)
      .map(([id, v]) => ({
        broadcast_id: id,
        name: name.get(id) ?? null,
        messages: v.messages,
        amount: round2(v.amount),
        cost_per_message: v.messages ? round2(v.amount / v.messages) : 0,
      })),
    staff_excluded: all.length - rows.length,
    truncated,
  };
}

// --- agents ------------------------------------------------------------------

export async function agentPerformance(db: Db, accountId: string, range: DateRange) {
  const staff = await loadStaff(db, accountId);
  const { convs, truncated } = await loadCustomerConversations(db, accountId, range.from, staff);
  const messages = await loadMessages(
    db,
    convs.map((c) => c.id),
    range
  );

  // First human reply per conversation, credited to whoever sent it.
  const firstReply = new Map<string, ResponseSample>();
  for (const s of responseSamples(messages)) {
    if (s.responderType === 'agent' && !firstReply.has(s.conversationId)) {
      firstReply.set(s.conversationId, s);
    }
  }

  const agents = new Map<string, { handled: number; closed: number; minutes: number[] }>();
  const entry = (id: string) => {
    const e = agents.get(id) ?? { handled: 0, closed: 0, minutes: [] };
    agents.set(id, e);
    return e;
  };
  for (const c of convs) {
    if (!c.assigned_agent_id) continue;
    const e = entry(c.assigned_agent_id);
    e.handled++;
    if (c.status === 'closed') e.closed++;
  }
  for (const s of firstReply.values()) {
    if (s.responderId) entry(s.responderId).minutes.push(s.minutes);
  }

  const ids = [...agents.keys()];
  const names = new Map<string, string>();
  for (const part of chunks(ids)) {
    const { data } = await db
      .from('profiles')
      .select('user_id, full_name')
      .eq('account_id', accountId)
      .in('user_id', part);
    for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) {
      names.set(p.user_id, p.full_name ?? 'Unnamed');
    }
  }

  return {
    range,
    // Members only: a user id with no profile in this account is not listed.
    items: ids
      .filter((id) => names.has(id))
      .map((id) => {
        const e = agents.get(id)!;
        return {
          user_id: id,
          name: names.get(id)!,
          chats_handled: e.handled,
          chats_closed: e.closed,
          first_response_minutes: {
            average: avg(e.minutes),
            median: median(e.minutes),
            samples: e.minutes.length,
          },
        };
      })
      .sort((a, b) => b.chats_handled - a.chats_handled),
    staff_excluded: true,
    truncated,
  };
}
