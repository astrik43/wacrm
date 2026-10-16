// ============================================================
// GET /api/billing/transactions — the Transaction Details page.
//
// One row per outbound WhatsApp message (message_charges, migration
// 050) for a date range, joined with what the CRM knows about it:
// recipient, template, where it came from (Shopify update, broadcast,
// automation, inbox reply), the Shopify order, Meta's billing category
// and an estimated amount. Also returns totals for the whole range.
//
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   inclusive, defaults to this month
//   &status=sent|delivered|read|failed
//   &category=marketing|utility|…
//   &page=1                           50 rows per page
//   &format=csv                       every matching row, as a CSV file
//
// Admins only: spend is account-level information.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  estimateChargeInr,
  GST_RATE,
  isChargeStatus,
} from '@/lib/billing/charges';
import {
  dateRange,
  toCsv,
  type ChargeRow,
  type Transaction,
} from '@/lib/billing/transactions';
import { supabaseAdmin } from '@/lib/flows/admin-client';

const PAGE_SIZE = 50;
/** Rows read for totals and CSV — far above any month's volume here. */
const MAX_ROWS = 20000;
const FETCH_PAGE = 1000;
const ENRICH_BATCH = 100;

type Db = ReturnType<typeof supabaseAdmin>;

const CHARGE_COLUMNS =
  'id, whatsapp_message_id, recipient, status, pricing_category, pricing_type, billable, pricing_source, sent_at, delivered_at, read_at, failed_at, error_code, error_title, created_at';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Everything the CRM knows about these messages, keyed by wamid. */
async function enrich(
  db: Db,
  accountId: string,
  rows: ChargeRow[]
): Promise<Transaction[]> {
  const ids = rows.map((r) => r.whatsapp_message_id);
  if (ids.length === 0) return [];

  const [messagesRes, shopifyRes, broadcastRes] = await Promise.all([
    db
      .from('messages')
      .select('message_id, template_name, content_type, sender_type, conversation_id')
      .in('message_id', ids),
    db
      .from('shopify_notifications')
      .select('whatsapp_message_id, event, step, order_name, is_test')
      .eq('account_id', accountId)
      .in('whatsapp_message_id', ids),
    db
      .from('broadcast_recipients')
      .select('whatsapp_message_id, contact_id, broadcast_id')
      .in('whatsapp_message_id', ids),
  ]);

  type MessageRow = {
    message_id: string;
    template_name: string | null;
    content_type: string | null;
    sender_type: string | null;
    conversation_id: string;
  };
  type ShopifyRow = {
    whatsapp_message_id: string;
    event: string;
    step: number | null;
    order_name: string | null;
    is_test: boolean | null;
  };
  type BroadcastRecipientRow = {
    whatsapp_message_id: string;
    contact_id: string | null;
    broadcast_id: string;
  };
  const messages = (messagesRes.data ?? []) as MessageRow[];
  const shopify = (shopifyRes.data ?? []) as ShopifyRow[];
  const recipients = (broadcastRes.data ?? []) as BroadcastRecipientRow[];

  // Conversations scope messages to this account (message ids can
  // repeat across numbers) and lead to the contact.
  const conversationIds = [...new Set(messages.map((m) => m.conversation_id))];
  const broadcastIds = [...new Set(recipients.map((r) => r.broadcast_id))];
  const [conversationsRes, broadcastsRes] = await Promise.all([
    conversationIds.length
      ? db
          .from('conversations')
          .select('id, contact_id')
          .eq('account_id', accountId)
          .in('id', conversationIds)
      : Promise.resolve({ data: [] }),
    broadcastIds.length
      ? db
          .from('broadcasts')
          .select('id, name, template_name')
          .eq('account_id', accountId)
          .in('id', broadcastIds)
      : Promise.resolve({ data: [] }),
  ]);
  const conversations = new Map(
    ((conversationsRes.data ?? []) as { id: string; contact_id: string | null }[]).map(
      (c) => [c.id, c.contact_id]
    )
  );
  const broadcasts = new Map(
    (
      (broadcastsRes.data ?? []) as {
        id: string;
        name: string | null;
        template_name: string | null;
      }[]
    ).map((b) => [b.id, b])
  );

  const messageById = new Map<string, MessageRow & { contact_id: string | null }>();
  for (const m of messages) {
    if (!conversations.has(m.conversation_id)) continue;
    messageById.set(m.message_id, {
      ...m,
      contact_id: conversations.get(m.conversation_id) ?? null,
    });
  }
  const recipientById = new Map<string, BroadcastRecipientRow>();
  for (const r of recipients) {
    if (broadcasts.has(r.broadcast_id)) recipientById.set(r.whatsapp_message_id, r);
  }
  const shopifyById = new Map(shopify.map((s) => [s.whatsapp_message_id, s]));

  const contactIds = [
    ...new Set(
      [
        ...[...messageById.values()].map((m) => m.contact_id),
        ...[...recipientById.values()].map((r) => r.contact_id),
      ].filter((id): id is string => !!id)
    ),
  ];
  const contactsRes = contactIds.length
    ? await db
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', accountId)
        .in('id', contactIds)
    : { data: [] };
  const contacts = new Map(
    ((contactsRes.data ?? []) as { id: string; name: string | null; phone: string | null }[]).map(
      (c) => [c.id, c]
    )
  );

  return rows.map((row) => {
    const message = messageById.get(row.whatsapp_message_id);
    const recipient = recipientById.get(row.whatsapp_message_id);
    const notification = shopifyById.get(row.whatsapp_message_id);
    const broadcast = recipient ? broadcasts.get(recipient.broadcast_id) : undefined;
    const contact = contacts.get(message?.contact_id ?? recipient?.contact_id ?? '');

    let source: Transaction['source'] = 'other';
    let sourceDetail: string | null = null;
    if (notification) {
      source = 'shopify';
      sourceDetail =
        notification.step && notification.step > 0
          ? `${notification.event}#${notification.step}`
          : notification.event;
    } else if (broadcast) {
      source = 'broadcast';
      sourceDetail = broadcast.name;
    } else if (message?.sender_type === 'agent') {
      source = 'inbox';
    } else if (message) {
      source = 'automation';
    }

    return {
      ...row,
      amount_inr: estimateChargeInr(row),
      contact_name: contact?.name ?? null,
      phone: contact?.phone ?? row.recipient,
      template_name: message?.template_name ?? broadcast?.template_name ?? null,
      content_type: message?.content_type ?? (broadcast ? 'template' : null),
      source,
      source_detail: sourceDetail,
      order_name: notification?.order_name ?? null,
      is_test: notification?.is_test === true,
    };
  });
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const params = new URL(request.url).searchParams;
    const { from, to } = dateRange(params.get('from'), params.get('to'));
    const status = params.get('status');
    const category = params.get('category');
    const format = params.get('format');
    const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));

    const db = supabaseAdmin();
    const filtered = () => {
      let query = db
        .from('message_charges')
        .select(CHARGE_COLUMNS)
        .eq('account_id', ctx.accountId)
        .gte('created_at', from)
        .lt('created_at', to);
      if (isChargeStatus(status)) query = query.eq('status', status);
      if (category && /^[a-z_]{1,40}$/.test(category)) {
        query = query.eq('pricing_category', category);
      }
      return query.order('created_at', { ascending: false });
    };

    // Every matching row, for totals (and the CSV). PostgREST caps a
    // response at 1000 rows, so read in pages.
    const all: ChargeRow[] = [];
    for (let offset = 0; offset < MAX_ROWS; offset += FETCH_PAGE) {
      const { data, error } = await filtered().range(
        offset,
        offset + FETCH_PAGE - 1
      );
      if (error) {
        console.error('[GET /api/billing/transactions] fetch error:', error);
        return NextResponse.json(
          { error: 'Failed to load transactions' },
          { status: 500 }
        );
      }
      const rows = (data ?? []) as ChargeRow[];
      all.push(...rows);
      if (rows.length < FETCH_PAGE) break;
    }

    if (format === 'csv') {
      // Enriched in batches: each batch's ids go into one query URL.
      const enriched: Transaction[] = [];
      for (let i = 0; i < all.length; i += ENRICH_BATCH) {
        enriched.push(
          ...(await enrich(db, ctx.accountId, all.slice(i, i + ENRICH_BATCH)))
        );
      }
      const csv = toCsv(enriched);
      const name = `whatsapp-transactions-${from.slice(0, 10)}-to-${new Date(
        new Date(to).getTime() - 86_400_000
      )
        .toISOString()
        .slice(0, 10)}.csv`;
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const byCategory: Record<string, { count: number; billable: number; amount_inr: number }> =
      {};
    const byStatus: Record<string, number> = {};
    let amount = 0;
    let billable = 0;
    for (const row of all) {
      const cost = estimateChargeInr(row);
      const key = row.pricing_category ?? 'unknown';
      byCategory[key] ??= { count: 0, billable: 0, amount_inr: 0 };
      byCategory[key].count += 1;
      if (cost > 0) {
        byCategory[key].billable += 1;
        billable += 1;
      }
      byCategory[key].amount_inr = round2(byCategory[key].amount_inr + cost);
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      amount += cost;
    }

    const start = (page - 1) * PAGE_SIZE;
    const transactions = await enrich(
      db,
      ctx.accountId,
      all.slice(start, start + PAGE_SIZE)
    );

    return NextResponse.json({
      from,
      to,
      page,
      page_size: PAGE_SIZE,
      total: all.length,
      truncated: all.length >= MAX_ROWS,
      summary: {
        messages: all.length,
        billable,
        by_status: byStatus,
        by_category: byCategory,
        amount_inr: round2(amount),
        gst_inr: round2(amount * GST_RATE),
        total_inr: round2(amount * (1 + GST_RATE)),
      },
      transactions,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
