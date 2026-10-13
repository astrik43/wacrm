// ============================================================
// Process one verified Shopify webhook delivery.
//
// Runs inside the route's after() callback, so everything here is
// awaited (a detached promise is frozen on serverless — see the
// WhatsApp webhook) and nothing throws past the caller's try/catch
// that matters to Shopify: it already has its 200.
//
// Shopify does not guarantee ordering. An order's fulfillment can
// arrive before the order, and updates can arrive out of sequence, so:
//   - orders are upserted; fulfillment state goes through the
//     `shopify_apply_fulfillment` RPC, which locks the row, drops
//     stale deliveries and hands back the previous state atomically;
//   - a fulfillment whose order we don't have yet waits briefly, then
//     falls back to the phone on the shipment's destination address.
//
// Abandoned checkouts (`checkouts/*`) schedule up to three cart
// reminders; a completed checkout, or an order from the same phone,
// cancels the ones still waiting.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchLineItemImage } from './admin-api';
import { generateWebhookToken, type ShopifyConfigRow } from './config';
import {
  CART_EVENTS,
  deriveFulfillmentEvents,
  isPaymentMode,
  type FulfillmentState,
  type PaymentMode,
  type ShopifyEvent,
  type ShopifyTopic,
} from './events';
import {
  extractCheckoutFields,
  extractFulfillmentFields,
  extractOrderCustomer,
  extractOrderFields,
  firstLineItemRef,
  paymentModeOf,
  type ShopifyFields,
} from './order-fields';
import { notifyShopifyEvent, type NotifyOutcome } from './notify';
import { pickOrderPhone } from './phone';

type Json = Record<string, unknown>;

/** What happened to one customer-facing update a delivery produced. */
export interface ProcessOutcome {
  event: ShopifyEvent;
  status: NotifyOutcome['status'];
  reason?: string;
}

/**
 * What a delivery led to — recorded on the webhook log so "Shopify
 * sent it but the customer got nothing" can be answered from the UI.
 * `note` explains a delivery that produced no update at all.
 */
export interface ProcessResult {
  orderRef: string | null;
  note?:
    | 'invalid_payload'
    | 'missing_id'
    | 'db_error'
    | 'order_already_cancelled'
    | 'stale_update'
    | 'no_change'
    | 'order_cancelled'
    | 'checkout_completed'
    | 'no_phone';
  outcomes: ProcessOutcome[];
}

function toOutcome(event: ShopifyEvent, outcome: NotifyOutcome): ProcessOutcome {
  return 'reason' in outcome
    ? { event, status: outcome.status, reason: outcome.reason }
    : { event, status: outcome.status };
}

const ORDER_WAIT_MS = 2000;

/** Where the public confirmation page lives, when the deployment says. */
function confirmUrl(token: string): string | null {
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(origin) ? `${origin}/o/${token}` : null;
}

/**
 * Stop notifications that are still waiting for their send time.
 * `filter` narrows the rows; failures are logged and swallowed — the
 * cron re-checks every row before sending, so this is an early exit,
 * not the only guard.
 */
async function cancelScheduled(
  db: SupabaseClient,
  accountId: string,
  reason: string,
  filter: {
    orderId?: string;
    checkoutId?: string;
    phone?: string;
    cartOnly?: boolean;
    exceptEvent?: ShopifyEvent;
  }
): Promise<void> {
  let query = db
    .from('shopify_notifications')
    .update({ status: 'cancelled', reason, payload: null })
    .eq('account_id', accountId)
    .eq('status', 'scheduled');
  if (filter.orderId) query = query.eq('shopify_order_id', filter.orderId);
  if (filter.checkoutId) query = query.eq('shopify_checkout_id', filter.checkoutId);
  if (filter.phone) query = query.eq('payload->>phone', filter.phone);
  if (filter.cartOnly) query = query.in('event', [...CART_EVENTS]);
  if (filter.exceptEvent) query = query.neq('event', filter.exceptEvent);
  const { error } = await query;
  if (error) {
    console.error('[shopify] could not cancel scheduled sends:', error.message);
  }
}

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** Shopify ids are 64-bit; keep them as strings end to end. */
function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function orderPhone(order: Json, countryCode: string | null): string | null {
  const customer = obj(order.customer);
  return pickOrderPhone(
    [
      text(order.phone),
      text(customer?.phone),
      text(obj(order.shipping_address)?.phone),
      text(obj(order.billing_address)?.phone),
      text(obj(customer?.default_address)?.phone),
    ],
    countryCode
  );
}

interface StoredOrder {
  order_name: string | null;
  phone: string | null;
  customer_name: string | null;
  fields: ShopifyFields | null;
  cancelled_at: string | null;
  payment_mode: string | null;
  confirm_token: string | null;
}

async function loadOrder(
  db: SupabaseClient,
  accountId: string,
  orderId: string
): Promise<StoredOrder | null> {
  const { data } = await db
    .from('shopify_orders')
    .select(
      'order_name, phone, customer_name, fields, cancelled_at, payment_mode, confirm_token'
    )
    .eq('account_id', accountId)
    .eq('shopify_order_id', orderId)
    .maybeSingle();
  return (data as StoredOrder | null) ?? null;
}

async function handleOrder(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  topic: 'orders/create' | 'orders/cancelled',
  order: Json,
  webhookId: string | null
): Promise<ProcessResult> {
  const orderId = idOf(order.id);
  if (!orderId) return { orderRef: null, note: 'missing_id', outcomes: [] };

  const accountId = config.account_id;
  const fields = extractOrderFields(order);
  // Stored with the order, so every later shipment update for it can
  // show the same picture without another lookup. Null (no
  // credentials, no image, Shopify down) just means no picture.
  const imageUrl = await fetchLineItemImage(db, config, firstLineItemRef(order));
  if (imageUrl) fields.product_image_url = imageUrl;
  const { fullName } = extractOrderCustomer(order);
  const phone = orderPhone(order, config.default_country_code);
  const cancelledAt = timestamp(order.cancelled_at);
  const paymentMode = paymentModeOf(order);
  // The link in a message already sent must keep working, so a
  // cancellation (which overwrites the row) reuses the order's token.
  const existing =
    topic === 'orders/cancelled'
      ? await loadOrder(db, accountId, orderId)
      : null;
  const confirmToken = existing?.confirm_token ?? generateWebhookToken();
  fields.cod_confirm_token = confirmToken;
  const url = confirmUrl(confirmToken);
  if (url) fields.cod_confirm_url = url;
  const row = {
    account_id: accountId,
    shopify_order_id: orderId,
    order_name: text(order.name),
    phone,
    customer_name: fullName || null,
    fields,
    cancelled_at: cancelledAt,
    payment_mode: paymentMode,
    confirm_token: confirmToken,
    source_updated_at: timestamp(order.updated_at),
  };

  // orders/create must never clobber a cancellation that raced ahead
  // of it, so it only inserts; orders/cancelled carries the complete,
  // newer order and overwrites.
  const { error } = await db.from('shopify_orders').upsert(row, {
    onConflict: 'account_id,shopify_order_id',
    ignoreDuplicates: topic === 'orders/create',
  });
  if (error) {
    console.error('[shopify] order upsert failed:', error.message);
    return { orderRef: row.order_name ?? orderId, note: 'db_error', outcomes: [] };
  }

  const event: ShopifyEvent =
    topic === 'orders/create' ? 'order_created' : 'order_cancelled';

  if (event === 'order_cancelled') {
    // A delayed "order placed" must not land after the cancellation.
    await cancelScheduled(db, accountId, 'order_cancelled', {
      orderId,
      exceptEvent: 'order_cancelled',
    });
  } else {
    // They bought: the cart reminders have done their job. FlexyPe and
    // other third-party checkouts create orders with no checkout id,
    // so the phone is the link that always exists.
    const checkoutId = idOf(order.checkout_id);
    if (checkoutId) {
      await cancelScheduled(db, accountId, 'order_placed', {
        checkoutId,
        cartOnly: true,
      });
    }
    if (phone) {
      await cancelScheduled(db, accountId, 'order_placed', {
        phone,
        cartOnly: true,
      });
    }
  }
  // An order that is already cancelled when its create arrives gets
  // the cancellation message only.
  if (event === 'order_created' && cancelledAt) {
    return {
      orderRef: row.order_name ?? orderId,
      note: 'order_already_cancelled',
      outcomes: [],
    };
  }

  const outcome = await notifyShopifyEvent(db, accountId, {
    event,
    dedupeKey: `${event}:${orderId}`,
    orderId,
    fulfillmentId: null,
    orderName: row.order_name,
    phone,
    customerName: row.customer_name,
    fields,
    paymentMode,
    webhookId,
  });
  return {
    orderRef: row.order_name ?? orderId,
    outcomes: [toOutcome(event, outcome)],
  };
}

interface StoredCheckout {
  fields: ShopifyFields | null;
  source_updated_at: string | null;
}

async function handleCheckout(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  checkout: Json,
  webhookId: string | null
): Promise<ProcessResult> {
  const checkoutId = idOf(checkout.id);
  if (!checkoutId) return { orderRef: null, note: 'missing_id', outcomes: [] };

  const accountId = config.account_id;
  const fields = extractCheckoutFields(checkout);
  const { fullName } = extractOrderCustomer(checkout);
  const orderRef = fullName || text(checkout.name) || checkoutId;
  const updatedAt = timestamp(checkout.updated_at);
  const completedAt = timestamp(checkout.completed_at);

  const { data: existingRow } = await db
    .from('shopify_checkouts')
    .select('fields, source_updated_at')
    .eq('account_id', accountId)
    .eq('shopify_checkout_id', checkoutId)
    .maybeSingle();
  const existing = (existingRow as StoredCheckout | null) ?? null;
  if (
    existing?.source_updated_at &&
    updatedAt &&
    updatedAt < existing.source_updated_at
  ) {
    return { orderRef, note: 'stale_update', outcomes: [] };
  }

  // Shopify sends an update for every keystroke-level change of a
  // checkout; look the picture up once and keep it.
  const imageUrl =
    existing?.fields?.product_image_url ??
    (await fetchLineItemImage(db, config, firstLineItemRef(checkout)));
  if (imageUrl) fields.product_image_url = imageUrl;

  const phone = orderPhone(checkout, config.default_country_code);
  const { error } = await db.from('shopify_checkouts').upsert(
    {
      account_id: accountId,
      shopify_checkout_id: checkoutId,
      phone,
      customer_name: fullName || null,
      fields,
      completed_at: completedAt,
      source_updated_at: updatedAt,
    },
    { onConflict: 'account_id,shopify_checkout_id' }
  );
  if (error) {
    console.error('[shopify] checkout upsert failed:', error.message);
    return { orderRef, note: 'db_error', outcomes: [] };
  }

  if (completedAt) {
    await cancelScheduled(db, accountId, 'checkout_completed', {
      checkoutId,
      cartOnly: true,
    });
    return { orderRef, note: 'checkout_completed', outcomes: [] };
  }
  // Wait for the update that carries a phone number; nothing is
  // claimed, so that later delivery can still schedule the reminders.
  if (!phone) return { orderRef, note: 'no_phone', outcomes: [] };

  const outcomes: ProcessOutcome[] = [];
  for (const event of CART_EVENTS) {
    const outcome = await notifyShopifyEvent(db, accountId, {
      event,
      dedupeKey: `${event}:${checkoutId}`,
      orderId: null,
      fulfillmentId: null,
      checkoutId,
      orderName: orderRef,
      phone,
      customerName: fullName || null,
      fields,
      webhookId,
    });
    // Every later update of the same checkout finds the reminders
    // already claimed; that is not news.
    if (outcome.status !== 'duplicate' && outcome.status !== 'disabled') {
      outcomes.push(toOutcome(event, outcome));
    }
  }
  return outcomes.length > 0
    ? { orderRef, outcomes }
    : { orderRef, note: 'no_change', outcomes: [] };
}

interface ApplyResult {
  applied: boolean;
  was_new: boolean;
  prev_tracking_number: string | null;
  prev_tracking_url: string | null;
  prev_shipment_status: string | null;
}

async function handleFulfillment(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  fulfillment: Json,
  webhookId: string | null
): Promise<ProcessResult> {
  const fulfillmentId = idOf(fulfillment.id);
  if (!fulfillmentId) return { orderRef: null, note: 'missing_id', outcomes: [] };

  const accountId = config.account_id;
  const orderId = idOf(fulfillment.order_id);
  const fallbackRef = text(fulfillment.name) ?? orderId;
  const fulfillmentFields = extractFulfillmentFields(fulfillment);
  const next = {
    trackingNumber: fulfillmentFields.tracking_number ?? null,
    trackingUrl: fulfillmentFields.tracking_url ?? null,
    shipmentStatus: text(fulfillment.shipment_status),
    status: text(fulfillment.status),
  };

  const { data, error } = await db.rpc('shopify_apply_fulfillment', {
    p_account_id: accountId,
    p_fulfillment_id: fulfillmentId,
    p_order_id: orderId,
    p_tracking_number: next.trackingNumber,
    p_tracking_url: next.trackingUrl,
    p_tracking_company: fulfillmentFields.tracking_company ?? null,
    p_shipment_status: next.shipmentStatus,
    p_source_updated_at: timestamp(fulfillment.updated_at),
  });
  if (error) {
    console.error('[shopify] fulfillment apply failed:', error.message);
    return { orderRef: fallbackRef, note: 'db_error', outcomes: [] };
  }
  const result = (Array.isArray(data) ? data[0] : data) as ApplyResult | null;
  // Stale delivery: a newer state is already stored and announced.
  if (!result?.applied) {
    return { orderRef: fallbackRef, note: 'stale_update', outcomes: [] };
  }

  const prev: FulfillmentState | null = result.was_new
    ? null
    : {
        trackingNumber: result.prev_tracking_number,
        trackingUrl: result.prev_tracking_url,
        shipmentStatus: result.prev_shipment_status,
      };
  const events = deriveFulfillmentEvents(prev, next);
  if (events.length === 0) {
    return { orderRef: fallbackRef, note: 'no_change', outcomes: [] };
  }

  let order = orderId ? await loadOrder(db, accountId, orderId) : null;
  if (!order && orderId) {
    // fulfillments/create can beat orders/create by a moment.
    await new Promise((resolve) => setTimeout(resolve, ORDER_WAIT_MS));
    order = await loadOrder(db, accountId, orderId);
  }
  if (order?.cancelled_at) {
    return {
      orderRef: order.order_name ?? fallbackRef,
      note: 'order_cancelled',
      outcomes: [],
    };
  }

  // An order placed before the store was connected never had its
  // picture looked up; the shipment lists the same items.
  if (!order) {
    const imageUrl = await fetchLineItemImage(
      db,
      config,
      firstLineItemRef(fulfillment)
    );
    if (imageUrl) fulfillmentFields.product_image_url = imageUrl;
  }

  const destination = obj(fulfillment.destination);
  const phone =
    order?.phone ??
    pickOrderPhone([text(destination?.phone)], config.default_country_code);
  // Order values win; the fulfillment's own name/number only fill gaps
  // for orders placed before the store was connected.
  const fields: ShopifyFields = {
    ...fulfillmentFields,
    ...(order?.fields ?? {}),
    ...(next.trackingNumber ? { tracking_number: next.trackingNumber } : {}),
    ...(next.trackingUrl ? { tracking_url: next.trackingUrl } : {}),
  };
  const orderName = order?.order_name ?? fields.order_number ?? null;
  const customerName = order?.customer_name ?? fields.customer_name ?? null;
  const paymentMode: PaymentMode | null = isPaymentMode(order?.payment_mode)
    ? order.payment_mode
    : null;

  const outcomes: ProcessOutcome[] = [];
  for (const event of events) {
    const dedupeKey =
      event === 'tracking_updated'
        ? `${event}:${fulfillmentId}:${next.trackingNumber ?? next.trackingUrl}`
        : `${event}:${fulfillmentId}`;
    const outcome = await notifyShopifyEvent(db, accountId, {
      event,
      dedupeKey,
      orderId,
      fulfillmentId,
      orderName,
      phone,
      customerName,
      fields,
      paymentMode,
      webhookId,
    });
    outcomes.push(toOutcome(event, outcome));
  }
  return { orderRef: orderName ?? fallbackRef, outcomes };
}

export async function processShopifyWebhook(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  topic: ShopifyTopic,
  payload: unknown,
  webhookId: string | null
): Promise<ProcessResult> {
  const body = obj(payload);
  if (!body) return { orderRef: null, note: 'invalid_payload', outcomes: [] };

  if (topic === 'orders/create' || topic === 'orders/cancelled') {
    return handleOrder(db, config, topic, body, webhookId);
  }
  if (topic === 'checkouts/create' || topic === 'checkouts/update') {
    return handleCheckout(db, config, body, webhookId);
  }
  return handleFulfillment(db, config, body, webhookId);
}
