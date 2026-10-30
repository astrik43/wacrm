// ============================================================
// One-off backfill: header picture + buttons (links as sent) on
// Shopify messages sent before the send path started keeping them
// (see src/lib/whatsapp/sent-template.ts).
//
// Every button value a Shopify message carries can be rebuilt exactly:
// the link codes are deterministic signatures of the order / shipment /
// checkout id, and the COD confirmation token and status-page path are
// stored with the order. So for each sent notification: rebuild the
// fields, run the update's current variable mapping over them, and
// store the result on the message. Nothing is sent.
//
// Runs a batch per Shopify cron tick and is idempotent: only messages
// with no stored payload are touched, and one that can't be rebuilt
// gets an empty payload so it isn't retried. Only notifications from
// before BACKFILL_BEFORE are looked at, so once they are done each tick
// costs a few small queries. Safe to delete after it has caught up.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isCartEvent, type ShopifyEvent } from '@/lib/shopify/events';
import { makeLinkCode } from '@/lib/shopify/link-codes';
import type { ShopifyFields } from '@/lib/shopify/order-fields';
import {
  parseVariableMapping,
  resolveSendParams,
} from '@/lib/shopify/variable-mapping';
import {
  sentTemplatePayload,
  type SentTemplatePayload,
} from '@/lib/whatsapp/sent-template';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

/** Sends from the release that started storing buttons onwards have them. */
export const BACKFILL_BEFORE = '2026-10-31T00:00:00Z';
const BATCH = 50;
const SCAN = 1000;

interface SentRow {
  id: string;
  account_id: string;
  event: string;
  step: number | null;
  shopify_order_id: string | null;
  shopify_fulfillment_id: string | null;
  shopify_checkout_id: string | null;
  message_id: string;
}

interface TemplateMessage {
  id: string;
  template_name: string | null;
}

const NOTHING: SentTemplatePayload = { kind: 'template', buttons: [] };

async function fieldsFor(
  db: SupabaseClient,
  row: SentRow
): Promise<ShopifyFields> {
  if (isCartEvent(row.event as ShopifyEvent)) {
    if (!row.shopify_checkout_id) return {};
    const { data } = await db
      .from('shopify_checkouts')
      .select('fields')
      .eq('account_id', row.account_id)
      .eq('shopify_checkout_id', row.shopify_checkout_id)
      .maybeSingle();
    const fields = { ...((data?.fields as ShopifyFields | null) ?? {}) };
    const link = makeLinkCode('c', row.account_id, row.shopify_checkout_id);
    if (link) fields.checkout_link_code = link;
    return fields;
  }

  const fields: ShopifyFields = {};
  if (row.shopify_order_id) {
    const { data } = await db
      .from('shopify_orders')
      .select('fields')
      .eq('account_id', row.account_id)
      .eq('shopify_order_id', row.shopify_order_id)
      .maybeSingle();
    Object.assign(fields, (data?.fields as ShopifyFields | null) ?? {});
    const link = makeLinkCode('s', row.account_id, row.shopify_order_id);
    if (link) fields.order_link_code = link;
  }
  if (row.shopify_fulfillment_id) {
    const link = makeLinkCode('t', row.account_id, row.shopify_fulfillment_id);
    if (link) fields.tracking_link_code = link;
  }
  return fields;
}

async function rebuild(
  db: SupabaseClient,
  row: SentRow,
  message: TemplateMessage
): Promise<SentTemplatePayload> {
  if (!message.template_name) return NOTHING;
  const { data: settings } = await db
    .from('shopify_event_templates')
    .select('step, template_name, template_language, variable_mapping')
    .eq('account_id', row.account_id)
    .eq('event', row.event)
    .eq('template_name', message.template_name);
  const candidates = (settings ?? []) as {
    step: number | null;
    template_language: string | null;
    variable_mapping: unknown;
  }[];
  const setting =
    candidates.find((s) => (s.step ?? 0) === (row.step ?? 0)) ?? candidates[0];
  if (!setting) return NOTHING;

  const resolved = await resolveTemplateRow(
    db,
    row.account_id,
    message.template_name,
    setting.template_language
  );
  const mapping = parseVariableMapping(setting.variable_mapping);
  if (!resolved.row || !mapping) return NOTHING;

  const params = resolveSendParams(resolved.row, mapping, await fieldsFor(db, row));
  if (!params.ok) return NOTHING;
  return sentTemplatePayload(resolved.row, params.params) ?? NOTHING;
}

export async function backfillTemplateButtons(
  db: SupabaseClient
): Promise<{ filled: number }> {
  const { data: sent, error } = await db
    .from('shopify_notifications')
    .select(
      'id, account_id, event, step, shopify_order_id, shopify_fulfillment_id, shopify_checkout_id, message_id'
    )
    .eq('status', 'sent')
    .not('message_id', 'is', null)
    .lt('created_at', BACKFILL_BEFORE)
    .order('created_at', { ascending: false })
    .limit(SCAN);
  if (error || !sent?.length) return { filled: 0 };

  const rows = sent as SentRow[];
  const byMessage = new Map(rows.map((r) => [r.message_id, r]));
  const ids = [...byMessage.keys()];

  const todo: TemplateMessage[] = [];
  for (let i = 0; i < ids.length && todo.length < BATCH; i += 200) {
    const { data } = await db
      .from('messages')
      .select('id, template_name')
      .in('id', ids.slice(i, i + 200))
      .eq('content_type', 'template')
      .is('interactive_payload', null);
    todo.push(...((data ?? []) as TemplateMessage[]));
  }

  let filled = 0;
  for (const message of todo.slice(0, BATCH)) {
    const row = byMessage.get(message.id);
    if (!row) continue;
    let payload = NOTHING;
    try {
      payload = await rebuild(db, row, message);
    } catch (err) {
      console.error('[shopify backfill] rebuild failed:', err);
    }
    const { error: updateErr } = await db
      .from('messages')
      .update({ interactive_payload: payload })
      .eq('id', message.id)
      .is('interactive_payload', null);
    if (!updateErr && payload.buttons.length > 0) filled++;
  }
  return { filled };
}
