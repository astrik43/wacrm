// ============================================================
// The order details a template variable can be mapped to.
//
// `SHOPIFY_FIELDS` is the catalogue the settings UI offers and the
// server validates against; the extractors turn Shopify's order and
// fulfillment payloads into a flat `{ field: string }` bag. Pure — no
// server-only imports — so the client can use the catalogue.
// ============================================================

import {
  CART_EVENTS,
  FULFILLMENT_EVENTS,
  ORDER_EVENTS,
  type PaymentMode,
  type ShopifyEvent,
} from './events';

export const SHOPIFY_FIELD_KEYS = [
  'customer_first_name',
  'customer_name',
  'order_number',
  'order_total',
  'currency',
  'item_summary',
  'item_count',
  'order_status_url',
  'order_status_url_path',
  'tracking_number',
  'tracking_company',
  'tracking_url',
  'cancel_reason',
  'payment_mode',
  'cod_confirm_token',
  'cod_confirm_url',
  'checkout_url',
  'checkout_url_path',
  'product_image_url',
] as const;

export type ShopifyFieldKey = (typeof SHOPIFY_FIELD_KEYS)[number];
export type ShopifyFields = Partial<Record<ShopifyFieldKey, string>>;

export function isShopifyFieldKey(value: unknown): value is ShopifyFieldKey {
  return (
    typeof value === 'string' &&
    (SHOPIFY_FIELD_KEYS as readonly string[]).includes(value)
  );
}

interface FieldMeta {
  /** Shown in the settings preview. */
  sample: string;
  /** Events the field can be filled for; omitted = all of them. */
  events?: readonly ShopifyEvent[];
  /**
   * 'image' fields hold a picture link: they fill a template's image
   * header and are never offered for a text placeholder.
   */
  kind?: 'image';
}

export const SHOPIFY_FIELDS: Record<ShopifyFieldKey, FieldMeta> = {
  customer_first_name: { sample: 'Priya' },
  customer_name: { sample: 'Priya Nair' },
  order_number: { sample: '#1042', events: ORDER_EVENTS },
  order_total: { sample: '2499.00' },
  currency: { sample: 'INR' },
  item_summary: { sample: 'Aviator sunglasses × 1 +1 more' },
  item_count: { sample: '2' },
  order_status_url: {
    sample: 'https://example.myshopify.com/orders/abc123/authenticate?key=xyz',
    events: ORDER_EVENTS,
  },
  order_status_url_path: {
    sample: 'orders/abc123/authenticate?key=xyz',
    events: ORDER_EVENTS,
  },
  tracking_number: { sample: 'EX123456789', events: FULFILLMENT_EVENTS },
  tracking_company: { sample: 'BlueDart', events: FULFILLMENT_EVENTS },
  tracking_url: {
    sample: 'https://track.example.com/EX123456789',
    events: FULFILLMENT_EVENTS,
  },
  cancel_reason: { sample: 'customer', events: ['order_cancelled'] },
  payment_mode: { sample: 'Cash on Delivery', events: ORDER_EVENTS },
  // The slug of the public confirmation page: the suffix of a template
  // button whose URL is https://<this CRM>/o/{{1}}.
  cod_confirm_token: {
    sample: 'Zk3vX9aQ2mLw8RtY5uHc1BnE7pJd4GsF',
    events: ORDER_EVENTS,
  },
  cod_confirm_url: {
    sample: 'https://crm.example.com/o/Zk3vX9aQ2mLw8RtY5uHc1BnE7pJd4GsF',
    events: ORDER_EVENTS,
  },
  checkout_url: {
    sample: 'https://example.myshopify.com/checkouts/abc123/recover?key=xyz',
    events: CART_EVENTS,
  },
  checkout_url_path: {
    sample: 'checkouts/abc123/recover?key=xyz',
    events: CART_EVENTS,
  },
  product_image_url: {
    sample: 'https://cdn.shopify.com/s/files/sample-product.jpg',
    kind: 'image',
  },
};

export function isImageField(field: ShopifyFieldKey): boolean {
  return SHOPIFY_FIELDS[field].kind === 'image';
}

export function fieldAppliesToEvent(
  field: ShopifyFieldKey,
  event: ShopifyEvent
): boolean {
  const events = SHOPIFY_FIELDS[field].events;
  return !events || events.includes(event);
}

/** Fields that can fill a TEXT placeholder for this event. */
export function fieldsForEvent(event: ShopifyEvent): ShopifyFieldKey[] {
  return SHOPIFY_FIELD_KEYS.filter(
    (f) => fieldAppliesToEvent(f, event) && !isImageField(f)
  );
}

const MAX_VALUE_LEN = 500;

/**
 * Make a value safe to use as a WhatsApp template parameter. Meta
 * rejects parameters containing newlines, tabs, or more than four
 * consecutive spaces (error 132018), so collapse all whitespace runs.
 */
export function sanitizeTemplateValue(
  value: unknown,
  max: number = MAX_VALUE_LEN
): string {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? sanitizeTemplateValue(value)
    : '';
}

function put(fields: ShopifyFields, key: ShopifyFieldKey, value: string) {
  if (value) fields[key] = value;
}

/** Path + query of a URL, without the leading slash — a URL-button suffix. */
function urlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.pathname + parsed.search).replace(/^\/+/, '');
  } catch {
    return '';
  }
}

function summariseItems(lineItems: unknown): { summary: string; count: number } {
  const items = Array.isArray(lineItems) ? lineItems : [];
  let count = 0;
  let first = '';
  for (const raw of items) {
    const item = obj(raw);
    if (!item) continue;
    const quantity = Number(item.quantity);
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    count += qty;
    if (!first) {
      const title = str(item.title) || str(item.name);
      if (title) first = `${title} × ${qty}`;
    }
  }
  const more = items.length - 1;
  const summary = first && more > 0 ? `${first} +${more} more` : first;
  return { summary: sanitizeTemplateValue(summary), count };
}

/** Customer display names from an order payload. */
export function extractOrderCustomer(order: unknown): {
  firstName: string;
  fullName: string;
} {
  const o = obj(order) ?? {};
  const customer = obj(o.customer);
  const shipping = obj(o.shipping_address);
  const billing = obj(o.billing_address);
  const firstName =
    str(customer?.first_name) ||
    str(shipping?.first_name) ||
    str(billing?.first_name);
  const lastName =
    str(customer?.last_name) ||
    str(shipping?.last_name) ||
    str(billing?.last_name);
  const fullName =
    [firstName, lastName].filter(Boolean).join(' ') ||
    str(shipping?.name) ||
    str(billing?.name);
  return { firstName, fullName };
}

/** Flat mappable values from an `orders/*` webhook payload. */
export function extractOrderFields(order: unknown): ShopifyFields {
  const o = obj(order) ?? {};
  const fields: ShopifyFields = {};
  const { firstName, fullName } = extractOrderCustomer(o);
  put(fields, 'customer_first_name', firstName);
  put(fields, 'customer_name', fullName);
  put(fields, 'order_number', str(o.name));
  put(fields, 'order_total', str(o.current_total_price) || str(o.total_price));
  put(fields, 'currency', str(o.currency));
  const { summary, count } = summariseItems(o.line_items);
  put(fields, 'item_summary', summary);
  if (count > 0) fields.item_count = String(count);
  const statusUrl = str(o.order_status_url);
  put(fields, 'order_status_url', statusUrl);
  put(fields, 'order_status_url_path', statusUrl ? urlPath(statusUrl) : '');
  put(fields, 'cancel_reason', str(o.cancel_reason));
  fields.payment_mode = paymentModeLabel(paymentModeOf(o));
  return fields;
}

const COD_GATEWAY = /cash on delivery|\bcod\b/i;

/**
 * How an order is paid, from the gateways Shopify lists on it. Any
 * cash-on-delivery gateway ("Cash on Delivery (COD)") makes it COD;
 * everything else, including an order with no gateway, is prepaid.
 */
export function paymentModeOf(order: unknown): PaymentMode {
  const o = obj(order) ?? {};
  const names = Array.isArray(o.payment_gateway_names)
    ? o.payment_gateway_names
    : [];
  const candidates = [...names, o.gateway];
  return candidates.some((n) => typeof n === 'string' && COD_GATEWAY.test(n))
    ? 'cod'
    : 'prepaid';
}

/** What a customer reads for a payment mode. */
export function paymentModeLabel(mode: PaymentMode): string {
  return mode === 'cod' ? 'Cash on Delivery' : 'Prepaid';
}

/**
 * Flat mappable values from a `checkouts/*` payload — the same names
 * as an order where they mean the same thing, so a cart template maps
 * "customer name" and "items" exactly like an order template.
 */
export function extractCheckoutFields(checkout: unknown): ShopifyFields {
  const c = obj(checkout) ?? {};
  const fields: ShopifyFields = {};
  const { firstName, fullName } = extractOrderCustomer(c);
  put(fields, 'customer_first_name', firstName);
  put(fields, 'customer_name', fullName);
  put(fields, 'order_total', str(c.total_price));
  put(fields, 'currency', str(c.presentment_currency) || str(c.currency));
  const { summary, count } = summariseItems(c.line_items);
  put(fields, 'item_summary', summary);
  if (count > 0) fields.item_count = String(count);
  const recoverUrl = str(c.abandoned_checkout_url);
  put(fields, 'checkout_url', recoverUrl);
  put(fields, 'checkout_url_path', recoverUrl ? urlPath(recoverUrl) : '');
  return fields;
}

function firstOf(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? str(value[0]) : '';
}

/**
 * Flat mappable values from a `fulfillments/*` payload. Besides the
 * tracking fields this carries a best-effort customer name and order
 * number, used only when we never saw the order itself (placed before
 * the store was connected).
 */
export function extractFulfillmentFields(fulfillment: unknown): ShopifyFields {
  const f = obj(fulfillment) ?? {};
  const fields: ShopifyFields = {};
  put(
    fields,
    'tracking_number',
    str(f.tracking_number) || firstOf(f.tracking_numbers)
  );
  put(fields, 'tracking_url', str(f.tracking_url) || firstOf(f.tracking_urls));
  put(fields, 'tracking_company', str(f.tracking_company));

  const destination = obj(f.destination);
  const firstName = str(destination?.first_name);
  const fullName =
    str(destination?.name) ||
    [firstName, str(destination?.last_name)].filter(Boolean).join(' ');
  put(fields, 'customer_first_name', firstName);
  put(fields, 'customer_name', fullName);
  // Fulfillment names look like "#1042.1" — the order number plus a
  // per-shipment suffix.
  put(fields, 'order_number', str(f.name).replace(/\.\d+$/, ''));
  return fields;
}

/** Shopify ids of the first line item — what the product-image lookup needs. */
export interface LineItemRef {
  variantId: string | null;
  productId: string | null;
}

function numericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

/**
 * The first line item of an order or fulfillment payload. `null` when
 * there is none, or it is a custom item with no product behind it.
 */
export function firstLineItemRef(payload: unknown): LineItemRef | null {
  const items = obj(payload)?.line_items;
  const first = Array.isArray(items) ? obj(items[0]) : null;
  if (!first) return null;
  const ref = {
    variantId: numericId(first.variant_id),
    productId: numericId(first.product_id),
  };
  return ref.variantId || ref.productId ? ref : null;
}
