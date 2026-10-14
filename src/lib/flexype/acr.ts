// ============================================================
// FlexyPe Abandoned Checkout Recovery (ACR) webhook → cart fields.
//
// FlexyPe sends ACR 15 minutes after a checkout session opens without
// an order (https://docs.flexype.io/webhooks/2026-05/acr). Two payload
// versions exist and both are accepted:
//
//   2026-05  { event_type: "ABANDONED_CHECKOUT", event_id, store,
//              payload: { session_id, checkout_url, user, cart_items,
//                         checkout_context, … } }
//   2025-09  { webhook_id, shopify_domain, checkout_url, total_payable,
//              user: { phone_no, dial_code, name }, cart_items, … }
//
// The result uses the same field names as a Shopify checkout, so cart
// reminder templates map identically whichever checkout the store uses.
// Pure — no server-only imports.
// ============================================================

import {
  firstLineItemRef,
  sanitizeTemplateValue,
  type LineItemRef,
  type ShopifyFields,
} from '@/lib/shopify/order-fields';
import { pickOrderPhone } from '@/lib/shopify/phone';

type Json = Record<string, unknown>;

/** Prefix of a FlexyPe checkout in shopify_checkouts / notifications. */
export const FLEXYPE_CHECKOUT_PREFIX = 'flexype:';

/** Shopify order note attribute FlexyPe fills with the session id. */
export const FLEXYPE_SESSION_ATTRIBUTE = 'FlexyPe Session ID';

/**
 * The phone in FlexyPe's documented sample payloads, which is what the
 * dashboard's "Test" button sends. A test must never schedule real
 * messages to whoever owns that number.
 */
const SAMPLE_PHONE = '919876543210';

export function isFlexypeSample(checkout: FlexypeCheckout): boolean {
  return checkout.phone === SAMPLE_PHONE;
}

export interface FlexypeCheckout {
  /** `flexype:<session id>` — the shopify_checkouts key. */
  checkoutId: string;
  /** Digits-only E.164, or null when none could be placed. */
  phone: string | null;
  customerName: string | null;
  fields: ShopifyFields;
  /** First cart item, to look its picture up when FlexyPe sent none. */
  lineItem: LineItemRef | null;
  shopDomain: string | null;
}

export type ParseResult =
  | { ok: true; checkout: FlexypeCheckout }
  | { ok: false; reason: 'invalid_payload' | 'unsupported_event' | 'missing_id' };

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

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function money(value: number): string {
  return value.toFixed(2);
}

function urlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.pathname + parsed.search).replace(/^\/+/, '');
  } catch {
    return '';
  }
}

/** A picture WhatsApp can fetch: absolute https only. */
function imageUrl(value: unknown): string {
  const raw = str(value);
  if (!raw) return '';
  const url = raw.startsWith('//') ? `https:${raw}` : raw;
  return /^https:\/\//i.test(url) ? url : '';
}

/** Session id of the FlexyPe checkout an order came from, if any. */
export function flexypeSessionOfOrder(order: unknown): string | null {
  const attrs = obj(order)?.note_attributes;
  if (!Array.isArray(attrs)) return null;
  for (const raw of attrs) {
    const attr = obj(raw);
    if (attr && str(attr.name).toLowerCase() === FLEXYPE_SESSION_ATTRIBUTE.toLowerCase()) {
      const value = str(attr.value);
      if (value) return value;
    }
  }
  return null;
}

export function parseFlexypeAbandonedCheckout(
  body: unknown,
  defaultCountryCode: string | null
): ParseResult {
  const root = obj(body);
  if (!root) return { ok: false, reason: 'invalid_payload' };

  // 2026-05 wraps the data in `payload` and names the event; 2025-09
  // is flat and only ever carries abandoned checkouts.
  const eventType = str(root.event_type);
  if (eventType && eventType !== 'ABANDONED_CHECKOUT') {
    return { ok: false, reason: 'unsupported_event' };
  }
  const data = obj(root.payload) ?? root;
  const store = obj(root.store);

  const sessionId =
    str(data.session_id) || str(root.webhook_id) || str(root.event_id);
  if (!sessionId) return { ok: false, reason: 'missing_id' };

  const user = obj(data.user) ?? {};
  const firstName = str(user.first_name) || str(user.name).split(' ')[0] || '';
  const fullName =
    str(user.full_name) ||
    str(user.name) ||
    [str(user.first_name), str(user.last_name)].filter(Boolean).join(' ');

  const dial = str(user.dial_code).replace(/\D/g, '');
  const local = str(user.phone) || str(user.phone_no);
  const phone = pickOrderPhone(
    [
      str(user.phone_with_dial_code),
      dial && local ? `+${dial}${local.replace(/\D/g, '')}` : null,
      local,
    ],
    defaultCountryCode
  );

  const items = Array.isArray(data.cart_items) ? data.cart_items : [];
  let count = 0;
  let total = 0;
  let hasTotal = false;
  let first = '';
  let picture = '';
  for (const raw of items) {
    const item = obj(raw);
    if (!item) continue;
    const quantity = num(item.quantity);
    const qty = quantity && quantity > 0 ? quantity : 1;
    count += qty;
    const lineTotal = num(item.total_price) ?? (num(item.price) ?? 0) * qty;
    if (lineTotal) {
      total += lineTotal;
      hasTotal = true;
    }
    if (!first) {
      const title = str(item.title);
      const variant = str(obj(item.variant)?.title);
      const name =
        variant && variant.toLowerCase() !== 'default title'
          ? `${title} (${variant})`
          : title;
      if (name) first = `${name} × ${qty}`;
    }
    if (!picture) picture = imageUrl(item.image);
  }

  const fields: ShopifyFields = {};
  const put = (key: keyof ShopifyFields, value: string) => {
    if (value) fields[key] = value;
  };
  put('customer_first_name', firstName);
  put('customer_name', fullName);
  const payable = num(root.total_payable) ?? num(data.total_payable);
  put(
    'order_total',
    payable !== null ? money(payable) : hasTotal ? money(total) : ''
  );
  const context = obj(data.checkout_context);
  put(
    'currency',
    str(context?.presentment_currency) || str(context?.store_currency)
  );
  const more = items.length - 1;
  put(
    'item_summary',
    sanitizeTemplateValue(first && more > 0 ? `${first} +${more} more` : first)
  );
  if (count > 0) fields.item_count = String(count);
  const checkoutUrl = str(data.checkout_url);
  put('checkout_url', checkoutUrl);
  put('checkout_url_path', checkoutUrl ? urlPath(checkoutUrl) : '');
  put('product_image_url', picture);

  return {
    ok: true,
    checkout: {
      checkoutId: `${FLEXYPE_CHECKOUT_PREFIX}${sessionId}`,
      phone,
      customerName: fullName || null,
      fields,
      lineItem: firstLineItemRef({ line_items: items }),
      shopDomain:
        str(store?.shopify_domain) || str(root.shopify_domain) || null,
    },
  };
}
