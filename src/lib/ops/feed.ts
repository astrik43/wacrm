// ============================================================
// Agent event feed, DERIVED from existing tables (no event table, no
// hooks in the write paths):
//
//   inbound_message  messages (customer, not an interactive tap)
//   button_reply     messages (customer, interactive tap)
//   ndr_reply        ndr_requests.replied_at
//   cod_confirmation shopify_orders.cod_decided_at
//   order_event      shopify_orders.created_at (order placed) and
//                    shopify_fulfillments.updated_at (shipment moved)
//   tag_added        contact_tags.created_at
//
// Every source is walked by (timestamp, id) ascending. The cursor is
// that pair of the last event handed out, so a poller that passes
// `next_cursor` back sees each event exactly once, in order. Sources
// are merged client-side; each is asked for `limit + 1` rows past the
// cursor, which is enough for the merged first `limit`.
//
// Events carry ids, order numbers and short excerpts — never a phone
// number, name or email.
//
// Caveat: inbound messages are stamped with Meta's send time, so a
// message processed minutes late can sort before the cursor. At
// normal webhook latency (seconds) this does not occur.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decodeCursor, encodeCursor } from '@/lib/api/v1/pagination';

import { chunk, excerpt } from './settings';

export const EVENT_TYPES = [
  'inbound_message',
  'button_reply',
  'ndr_reply',
  'cod_confirmation',
  'order_event',
  'tag_added',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface FeedEvent {
  /** The source row's id (an event whose row changes again is a new event). */
  id: string;
  type: EventType;
  at: string;
  contact_id: string | null;
  conversation_id?: string | null;
  order_number?: string | null;
  is_staff?: boolean;
  text?: string | null;
  data?: Record<string, unknown>;
}

type Row = Record<string, unknown>;

interface Source {
  type: EventType;
  table: string;
  tsCol: string;
  select: string;
  /** Account scoping + type filters. */
  scope: (q: any, accountId: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  map: (row: Row) => FeedEvent;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const SOURCES: Source[] = [
  {
    type: 'inbound_message',
    table: 'messages',
    tsCol: 'created_at',
    select:
      'id, created_at, content_type, content_text, conversation_id, conversations!inner(account_id, contact_id, contacts(is_staff))',
    scope: (q, accountId) =>
      q
        .eq('conversations.account_id', accountId)
        .eq('sender_type', 'customer')
        .neq('content_type', 'interactive'),
    map: (r) => messageEvent('inbound_message', r),
  },
  {
    type: 'button_reply',
    table: 'messages',
    tsCol: 'created_at',
    select:
      'id, created_at, content_type, content_text, interactive_reply_id, conversation_id, conversations!inner(account_id, contact_id, contacts(is_staff))',
    scope: (q, accountId) =>
      q
        .eq('conversations.account_id', accountId)
        .eq('sender_type', 'customer')
        .eq('content_type', 'interactive'),
    map: (r) => messageEvent('button_reply', r),
  },
  {
    type: 'ndr_reply',
    table: 'ndr_requests',
    tsCol: 'replied_at',
    select: 'id, order_name, contact_id, state, answer, answer_text, replied_at',
    scope: (q, accountId) => q.eq('account_id', accountId),
    map: (r) => ({
      id: r.id as string,
      type: 'ndr_reply',
      at: r.replied_at as string,
      contact_id: str(r.contact_id),
      order_number: str(r.order_name),
      text: excerpt(r.answer_text),
      data: { answer: r.answer ?? null, state: r.state ?? null },
    }),
  },
  {
    type: 'cod_confirmation',
    table: 'shopify_orders',
    tsCol: 'cod_decided_at',
    select: 'id, order_name, contact_id, cod_decision, cod_decided_at',
    scope: (q, accountId) => q.eq('account_id', accountId),
    map: (r) => ({
      id: r.id as string,
      type: 'cod_confirmation',
      at: r.cod_decided_at as string,
      contact_id: str(r.contact_id),
      order_number: str(r.order_name),
      data: { decision: r.cod_decision ?? null },
    }),
  },
  {
    type: 'order_event',
    table: 'shopify_orders',
    tsCol: 'created_at',
    select: 'id, order_name, contact_id, payment_mode, created_at',
    scope: (q, accountId) => q.eq('account_id', accountId),
    map: (r) => ({
      id: r.id as string,
      type: 'order_event',
      at: r.created_at as string,
      contact_id: str(r.contact_id),
      order_number: str(r.order_name),
      data: { kind: 'order_placed', payment_mode: r.payment_mode ?? null },
    }),
  },
  {
    type: 'order_event',
    table: 'shopify_fulfillments',
    tsCol: 'updated_at',
    select:
      'id, shopify_order_id, shipment_status, tracking_company, tracking_number, updated_at',
    scope: (q, accountId) => q.eq('account_id', accountId),
    map: (r) => ({
      id: r.id as string,
      type: 'order_event',
      at: r.updated_at as string,
      contact_id: null,
      order_number: null,
      data: {
        kind: 'shipment_update',
        shipment_status: r.shipment_status ?? null,
        tracking_company: r.tracking_company ?? null,
        awb: r.tracking_number ?? null,
        shopify_order_id: r.shopify_order_id ?? null,
      },
    }),
  },
  {
    type: 'tag_added',
    table: 'contact_tags',
    tsCol: 'created_at',
    select: 'id, created_at, contact_id, tags(name), contacts!inner(account_id, is_staff)',
    scope: (q, accountId) => q.eq('contacts.account_id', accountId),
    map: (r) => {
      const tag = r.tags as { name?: string } | null;
      const contact = r.contacts as { is_staff?: boolean } | null;
      return {
        id: r.id as string,
        type: 'tag_added',
        at: r.created_at as string,
        contact_id: str(r.contact_id),
        is_staff: contact?.is_staff === true,
        data: { tag: tag?.name ?? null },
      };
    },
  },
];

function messageEvent(type: EventType, r: Row): FeedEvent {
  const conv = r.conversations as
    | { contact_id?: string; contacts?: { is_staff?: boolean } | null }
    | null;
  return {
    id: r.id as string,
    type,
    at: r.created_at as string,
    contact_id: str(conv?.contact_id),
    conversation_id: str(r.conversation_id),
    is_staff: conv?.contacts?.is_staff === true,
    text: excerpt(r.content_text),
    ...(type === 'button_reply'
      ? { data: { reply_id: r.interactive_reply_id ?? null } }
      : {}),
  };
}

const compare = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export interface FeedPage {
  events: FeedEvent[];
  next_cursor: string | null;
  has_more: boolean;
}

export async function listEventsSince(
  db: SupabaseClient,
  accountId: string,
  opts: { cursor?: string | null; since?: string | null; types?: EventType[]; limit: number }
): Promise<FeedPage> {
  const cursor = decodeCursor(opts.cursor ?? null);
  const wanted = new Set(opts.types && opts.types.length > 0 ? opts.types : EVENT_TYPES);
  const since =
    opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const fetched = await Promise.all(
    SOURCES.filter((s) => wanted.has(s.type)).map(async (s) => {
      let q = s.scope(db.from(s.table).select(s.select), accountId);
      q = cursor
        ? q.or(
            `${s.tsCol}.gt.${cursor.createdAt},and(${s.tsCol}.eq.${cursor.createdAt},id.gt.${cursor.id})`
          )
        : q.gt(s.tsCol, since);
      const { data, error } = await q
        .order(s.tsCol, { ascending: true })
        .order('id', { ascending: true })
        .limit(opts.limit + 1);
      if (error) throw new Error(`event feed (${s.type}) failed: ${error.message}`);
      return ((data as Row[] | null) ?? []).map(s.map);
    })
  );

  const merged = fetched.flat().sort(compare);
  const hasMore = merged.length > opts.limit;
  const events = merged.slice(0, opts.limit);

  await attachOrderNumbers(db, accountId, events);

  const last = events[events.length - 1];
  return {
    events,
    next_cursor: last
      ? encodeCursor({ created_at: last.at, id: last.id })
      : (opts.cursor ?? null),
    has_more: hasMore,
  };
}

/** Shipment events know their Shopify order id; give them the order number + contact. */
async function attachOrderNumbers(
  db: SupabaseClient,
  accountId: string,
  events: FeedEvent[]
): Promise<void> {
  const ids = [
    ...new Set(
      events
        .filter((e) => e.type === 'order_event' && e.data?.kind === 'shipment_update')
        .map((e) => e.data?.shopify_order_id)
        .filter((v): v is string => typeof v === 'string')
    ),
  ];
  const names = new Map<string, { name: string | null; contact: string | null }>();
  for (const part of chunk(ids)) {
    const { data, error } = await db
      .from('shopify_orders')
      .select('shopify_order_id, order_name, contact_id')
      .eq('account_id', accountId)
      .in('shopify_order_id', part);
    if (error) throw new Error(`event feed order lookup failed: ${error.message}`);
    for (const r of (data as Row[] | null) ?? []) {
      names.set(r.shopify_order_id as string, {
        name: str(r.order_name),
        contact: str(r.contact_id),
      });
    }
  }
  for (const e of events) {
    if (e.type !== 'order_event' || e.data?.kind !== 'shipment_update') continue;
    const hit = names.get(e.data.shopify_order_id as string);
    e.order_number = hit?.name ?? null;
    e.contact_id = hit?.contact ?? null;
    delete e.data.shopify_order_id;
  }
}
