// ============================================================
// Shopify → wacrm event model.
//
// Shopify tells us WHAT changed in coarse terms (six webhook
// topics); the customer-facing events are derived here. Pure and
// dependency-free so the settings UI can import the catalogue too.
// ============================================================

export const SHOPIFY_EVENTS = [
  'order_created',
  'tracking_added',
  'tracking_updated',
  'out_for_delivery',
  'delivered',
  'order_cancelled',
  'cart_reminder_1',
  'cart_reminder_2',
  'cart_reminder_3',
] as const;

export type ShopifyEvent = (typeof SHOPIFY_EVENTS)[number];

export function isShopifyEvent(value: unknown): value is ShopifyEvent {
  return (
    typeof value === 'string' &&
    (SHOPIFY_EVENTS as readonly string[]).includes(value)
  );
}

/** The webhook topics the merchant must add in Shopify admin. */
export const SHOPIFY_TOPICS = [
  'orders/create',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
  'checkouts/create',
  'checkouts/update',
] as const;

export type ShopifyTopic = (typeof SHOPIFY_TOPICS)[number];

export function isShopifyTopic(value: unknown): value is ShopifyTopic {
  return (
    typeof value === 'string' &&
    (SHOPIFY_TOPICS as readonly string[]).includes(value)
  );
}

/** Events that are about a shipment rather than the order itself. */
export const FULFILLMENT_EVENTS: readonly ShopifyEvent[] = [
  'tracking_added',
  'tracking_updated',
  'out_for_delivery',
  'delivered',
];

/** Reminders about a checkout the customer started and didn't finish. */
export const CART_EVENTS: readonly ShopifyEvent[] = [
  'cart_reminder_1',
  'cart_reminder_2',
  'cart_reminder_3',
];

/** Everything that is about a placed order (and its shipments). */
export const ORDER_EVENTS: readonly ShopifyEvent[] = SHOPIFY_EVENTS.filter(
  (event) => !CART_EVENTS.includes(event)
);

export function isCartEvent(event: ShopifyEvent): boolean {
  return CART_EVENTS.includes(event);
}

/**
 * Which template an event uses can depend on how the order is paid.
 * 'all' is the fallback when the order's own variant isn't set up.
 */
export const SHOPIFY_VARIANTS = ['all', 'cod', 'prepaid'] as const;

export type ShopifyVariant = (typeof SHOPIFY_VARIANTS)[number];
export type PaymentMode = Exclude<ShopifyVariant, 'all'>;

export function isShopifyVariant(value: unknown): value is ShopifyVariant {
  return (
    typeof value === 'string' &&
    (SHOPIFY_VARIANTS as readonly string[]).includes(value)
  );
}

export function isPaymentMode(value: unknown): value is PaymentMode {
  return value === 'cod' || value === 'prepaid';
}

/** A cart can't be paid for yet, so its reminders have one template. */
export function variantsForEvent(event: ShopifyEvent): readonly ShopifyVariant[] {
  return isCartEvent(event) ? ['all'] : SHOPIFY_VARIANTS;
}

/** Longest delay the schedule accepts (30 days). */
export const MAX_DELAY_MINUTES = 43200;
/**
 * A reminder sent the moment a checkout appears would reach someone
 * who is still typing their address.
 */
export const MIN_CART_DELAY_MINUTES = 10;

export interface FulfillmentState {
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipmentStatus: string | null;
}

export interface IncomingFulfillment extends FulfillmentState {
  /** Shopify's fulfillment `status` (success, cancelled, failure, …). */
  status?: string | null;
}

/**
 * Classify one fulfillment delivery against the state we stored from
 * the previous one (`null` = first time we see this shipment).
 *
 *  - A first tracking number (or, lacking a number, a first tracking
 *    link) is "tracking added".
 *  - A DIFFERENT tracking number is "tracking updated". A link that
 *    appears or changes while the number stays the same is not: Shopify
 *    routinely fills the link in after the number, and that would
 *    message the customer about nothing.
 *  - `shipment_status` reaching out_for_delivery / delivered fires
 *    once each. Out-for-delivery arriving after delivered is ignored.
 *  - A delivered parcel gets no tracking message, and a cancelled or
 *    failed fulfillment gets nothing at all.
 */
export function deriveFulfillmentEvents(
  prev: FulfillmentState | null,
  next: IncomingFulfillment
): ShopifyEvent[] {
  if (next.status === 'cancelled' || next.status === 'failure') return [];

  const events: ShopifyEvent[] = [];
  const prevNumber = prev?.trackingNumber || null;
  const prevUrl = prev?.trackingUrl || null;
  const nextNumber = next.trackingNumber || null;
  const nextUrl = next.trackingUrl || null;
  const prevStatus = prev?.shipmentStatus || null;
  const nextStatus = next.shipmentStatus || null;

  if (nextStatus !== 'delivered') {
    if (nextNumber) {
      if (!prevNumber && !prevUrl) events.push('tracking_added');
      else if (prevNumber && prevNumber !== nextNumber)
        events.push('tracking_updated');
    } else if (nextUrl && !prevNumber) {
      if (!prevUrl) events.push('tracking_added');
      else if (prevUrl !== nextUrl) events.push('tracking_updated');
    }
  }

  if (
    nextStatus === 'out_for_delivery' &&
    prevStatus !== 'out_for_delivery' &&
    prevStatus !== 'delivered'
  ) {
    events.push('out_for_delivery');
  }
  if (nextStatus === 'delivered' && prevStatus !== 'delivered') {
    events.push('delivered');
  }

  return events;
}
