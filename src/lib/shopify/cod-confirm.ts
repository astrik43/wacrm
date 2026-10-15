// ============================================================
// COD confirmation (server-only).
//
// A template button opens /o/<token>, a public page where the
// customer confirms or cancels a cash-on-delivery order. There is no
// session: the unguessable token on `shopify_orders.confirm_token` IS
// the authorization, exactly like the webhook URL token.
//
// A decision is recorded once (the first press wins) and mirrored to
// Shopify as an order tag. Tagging is best-effort at press time —
// what the customer chose is never lost to a Shopify hiccup; the
// outcome is stored and `retryCodTags` (run by the cron) tries again.
// "Cancel" only tags the order. It does not cancel it in Shopify.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { addOrderTags } from './admin-api';
import { getShopifyConfigByAccount } from './config';
import type { ShopifyFields } from './order-fields';

export const COD_DECISIONS = ['confirmed', 'cancelled'] as const;
export type CodDecision = (typeof COD_DECISIONS)[number];

export function isCodDecision(value: unknown): value is CodDecision {
  return value === 'confirmed' || value === 'cancelled';
}

/** The Shopify order tag each decision adds. */
export const COD_TAGS: Record<CodDecision, string> = {
  confirmed: 'WHATSAPP CONFIRMED',
  cancelled: 'WHATSAPP CANCELLED',
};

const RETRY_BATCH = 20;
// Give the press-time attempt a moment before the cron repeats it.
const RETRY_AFTER_MS = 60_000;
// A tag that still fails after a week (app never given write_orders)
// stops being retried, so it can't crowd out fresh ones.
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface CodOrder {
  accountId: string;
  orderId: string;
  orderName: string | null;
  customerName: string | null;
  fields: ShopifyFields;
  cancelledAt: string | null;
  decision: CodDecision | null;
}

interface OrderRow {
  account_id: string;
  shopify_order_id: string;
  order_name: string | null;
  customer_name: string | null;
  fields: ShopifyFields | null;
  cancelled_at: string | null;
  cod_decision: string | null;
}

const ORDER_COLUMNS =
  'account_id, shopify_order_id, order_name, customer_name, fields, cancelled_at, cod_decision';

function isConfirmToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

function toCodOrder(row: OrderRow): CodOrder {
  return {
    accountId: row.account_id,
    orderId: row.shopify_order_id,
    orderName: row.order_name,
    customerName: row.customer_name,
    fields: row.fields ?? {},
    cancelledAt: row.cancelled_at,
    decision: isCodDecision(row.cod_decision) ? row.cod_decision : null,
  };
}

/** The order a confirmation link points at, or null. */
export async function loadCodOrder(
  db: SupabaseClient,
  token: string
): Promise<CodOrder | null> {
  if (!isConfirmToken(token)) return null;
  const { data, error } = await db
    .from('shopify_orders')
    .select(ORDER_COLUMNS)
    .eq('confirm_token', token)
    .maybeSingle();
  if (error) {
    console.error('[shopify] confirmation lookup failed:', error.message);
    return null;
  }
  return data ? toCodOrder(data as OrderRow) : null;
}

/** Tag the order in Shopify and record whether it took. */
async function syncTag(
  db: SupabaseClient,
  accountId: string,
  orderId: string,
  decision: CodDecision
): Promise<boolean> {
  const config = await getShopifyConfigByAccount(db, accountId);
  const result = config
    ? await addOrderTags(db, config, orderId, [COD_TAGS[decision]])
    : ({ ok: false, error: 'not_connected' } as const);

  const { error } = await db
    .from('shopify_orders')
    .update(
      result.ok
        ? { cod_tag_synced_at: new Date().toISOString(), cod_tag_error: null }
        : { cod_tag_error: result.error }
    )
    .eq('account_id', accountId)
    .eq('shopify_order_id', orderId);
  if (error) {
    console.error('[shopify] could not record tag result:', error.message);
  }
  if (!result.ok) {
    console.error('[shopify] order tag failed:', result.error);
  }
  return result.ok;
}

export type DecideResult =
  | { status: 'recorded'; decision: CodDecision }
  /** Someone already answered; `decision` is what stands. */
  | { status: 'already_decided'; decision: CodDecision }
  | { status: 'order_cancelled' }
  | { status: 'not_found' };

/**
 * Record what the customer pressed. Only the first press counts: the
 * update is conditional on no decision being stored, so two taps (or
 * two people with the link) can't both win.
 */
export async function decideCodOrder(
  db: SupabaseClient,
  token: string,
  decision: CodDecision
): Promise<DecideResult> {
  const order = await loadCodOrder(db, token);
  if (!order) return { status: 'not_found' };
  if (order.decision) {
    return { status: 'already_decided', decision: order.decision };
  }
  if (order.cancelledAt) return { status: 'order_cancelled' };

  const { data, error } = await db
    .from('shopify_orders')
    .update({
      cod_decision: decision,
      cod_decided_at: new Date().toISOString(),
    })
    .eq('confirm_token', token)
    .is('cod_decision', null)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    const current = await loadCodOrder(db, token);
    return current?.decision
      ? { status: 'already_decided', decision: current.decision }
      : { status: 'not_found' };
  }

  await syncTag(db, order.accountId, order.orderId, decision);
  return { status: 'recorded', decision };
}

/** Re-send tags Shopify didn't take when the customer pressed. */
export async function retryCodTags(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<{ retried: number; synced: number }> {
  const { data, error } = await db
    .from('shopify_orders')
    .select('account_id, shopify_order_id, cod_decision')
    .not('cod_decision', 'is', null)
    .is('cod_tag_synced_at', null)
    .lte('cod_decided_at', new Date(now.getTime() - RETRY_AFTER_MS).toISOString())
    .gte('cod_decided_at', new Date(now.getTime() - RETRY_WINDOW_MS).toISOString())
    .order('cod_decided_at', { ascending: true })
    .limit(RETRY_BATCH);
  if (error) throw new Error(error.message);

  let synced = 0;
  const rows =
    (data as
      | { account_id: string; shopify_order_id: string; cod_decision: string }[]
      | null) ?? [];
  for (const row of rows) {
    if (!isCodDecision(row.cod_decision)) continue;
    if (
      await syncTag(db, row.account_id, row.shopify_order_id, row.cod_decision)
    ) {
      synced++;
    }
  }
  return { retried: rows.length, synced };
}
