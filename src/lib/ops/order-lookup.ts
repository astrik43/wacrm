// ============================================================
// Order / AWB lookup. Returns ids and statuses only: no phone, name,
// email or address ever leaves this module.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { orderNameVariants } from './settings';
import { latestConversationId } from './staff';

type Row = Record<string, unknown>;

export interface OrderLookup {
  order_number: string | null;
  /** cancelled | open */
  status: string;
  payment_mode: string | null;
  cod_decision: string | null;
  fulfilment: {
    status: string | null;
    awb: string | null;
    carrier: string | null;
    updated_at: string | null;
  } | null;
  contact_id: string | null;
  conversation_id: string | null;
  is_staff: boolean;
}

const ORDER_COLUMNS =
  'shopify_order_id, order_name, phone, contact_id, cancelled_at, payment_mode, cod_decision, created_at';
const FULFILLMENT_COLUMNS =
  'shopify_order_id, shipment_status, tracking_number, tracking_company, updated_at';

/** `#EL2204`, `EL2204` or an AWB. */
export async function findByOrderOrAwb(
  db: SupabaseClient,
  accountId: string,
  query: string
): Promise<OrderLookup | null> {
  const variants = orderNameVariants(query);
  if (variants.length === 0) return null;

  let order: Row | null = null;
  const { data: byName, error: nameError } = await db
    .from('shopify_orders')
    .select(ORDER_COLUMNS)
    .eq('account_id', accountId)
    .in('order_name', variants)
    .order('created_at', { ascending: false })
    .limit(1);
  if (nameError) throw new Error(`order lookup failed: ${nameError.message}`);
  order = ((byName as Row[] | null) ?? [])[0] ?? null;

  let fulfilment: Row | null = null;
  if (!order) {
    const awbs = [...new Set([query.trim(), query.trim().toUpperCase()])];
    const { data: byAwb, error: awbError } = await db
      .from('shopify_fulfillments')
      .select(FULFILLMENT_COLUMNS)
      .eq('account_id', accountId)
      .in('tracking_number', awbs)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (awbError) throw new Error(`AWB lookup failed: ${awbError.message}`);
    fulfilment = ((byAwb as Row[] | null) ?? [])[0] ?? null;
    if (!fulfilment) return null;
    if (fulfilment.shopify_order_id) {
      const { data: found, error } = await db
        .from('shopify_orders')
        .select(ORDER_COLUMNS)
        .eq('account_id', accountId)
        .eq('shopify_order_id', fulfilment.shopify_order_id as string)
        .limit(1);
      if (error) throw new Error(`order lookup failed: ${error.message}`);
      order = ((found as Row[] | null) ?? [])[0] ?? null;
    }
  } else {
    const { data: latest, error } = await db
      .from('shopify_fulfillments')
      .select(FULFILLMENT_COLUMNS)
      .eq('account_id', accountId)
      .eq('shopify_order_id', order.shopify_order_id as string)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`fulfilment lookup failed: ${error.message}`);
    fulfilment = ((latest as Row[] | null) ?? [])[0] ?? null;
  }

  // The order row only learns its contact after the first message was
  // sent for it; fall back to the stored phone (never returned).
  let contactId = (order?.contact_id as string | null) ?? null;
  if (!contactId && typeof order?.phone === 'string' && order.phone) {
    const digits = order.phone.replace(/^\+/, '');
    const { data, error } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .in('phone', [digits, `+${digits}`])
      .limit(1);
    if (error) throw new Error(`contact lookup failed: ${error.message}`);
    contactId = ((data as Row[] | null) ?? [])[0]?.id as string | null ?? null;
  }

  let isStaff = false;
  let conversationId: string | null = null;
  if (contactId) {
    const { data, error } = await db
      .from('contacts')
      .select('id, is_staff')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw new Error(`contact lookup failed: ${error.message}`);
    if (!data) {
      contactId = null;
    } else {
      isStaff = (data as Row).is_staff === true;
      conversationId = await latestConversationId(db, accountId, contactId);
    }
  }

  return {
    order_number: (order?.order_name as string | null) ?? null,
    status: order?.cancelled_at ? 'cancelled' : 'open',
    payment_mode: (order?.payment_mode as string | null) ?? null,
    cod_decision: (order?.cod_decision as string | null) ?? null,
    fulfilment: fulfilment
      ? {
          status: (fulfilment.shipment_status as string | null) ?? null,
          awb: (fulfilment.tracking_number as string | null) ?? null,
          carrier: (fulfilment.tracking_company as string | null) ?? null,
          updated_at: (fulfilment.updated_at as string | null) ?? null,
        }
      : null,
    contact_id: contactId,
    conversation_id: conversationId,
    is_staff: isStaff,
  };
}
