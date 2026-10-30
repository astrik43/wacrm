// ============================================================
// Shiprocket Checkout (Fastrr) "Abandon Cart" webhook → cart fields.
//
// Set up in the Shiprocket Checkout dashboard (Settings → Webhooks →
// Add webhook, type "Abandon Cart"). Shiprocket publishes no schema
// for it; the payload seen in the wild is one flat cart object:
//
//   { cart_id, email, phone_number, first_name, last_name,
//     billing_address: { city, state, … }, checkout_url, total_price,
//     currency?, latest_stage, items: [{ title, quantity, price, … }] }
//
// with no "is abandoned" flag: everything sent to this endpoint is an
// abandoned cart. The parser is deliberately forgiving about names
// (a `data` / `cart` wrapper, `customer`, `line_items`, `image_url`,
// …) so a payload revision doesn't silently stop the reminders; every
// raw delivery is kept in the webhook log to check against.
//
// The result uses the same field names as a Shopify checkout, so cart
// reminder templates map identically whichever checkout the store
// uses. Pure — no server-only imports.
// ============================================================

import type { ExternalCheckout } from '@/lib/shopify/external-checkout';
import {
  sanitizeTemplateValue,
  type ShopifyFields,
} from '@/lib/shopify/order-fields';
import { pickOrderPhone } from '@/lib/shopify/phone';

type Json = Record<string, unknown>;

/** Prefix of a Shiprocket cart in shopify_checkouts / notifications. */
export const SHIPROCKET_CHECKOUT_PREFIX = 'shiprocket:';

/** Header carrying the secret the CRM generated for this connection. */
export const SHIPROCKET_SECRET_HEADER = 'x-chatstrik-secret';

export type ShiprocketParseResult =
  | { ok: true; checkout: ExternalCheckout; stage: string | null }
  | {
      ok: false;
      reason: 'invalid_payload' | 'missing_id' | 'checkout_completed';
      stage?: string | null;
    };

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

/** First non-empty string among `keys` of `source`. */
function pick(source: Json | null, ...keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = str(source[key]);
    if (value) return value;
  }
  return '';
}

function num(value: unknown): number | null {
  const n =
    typeof value === 'string' ? Number(value.replace(/[^0-9.-]/g, '')) : value;
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
function imageUrl(item: Json): string {
  const images = Array.isArray(item.images) ? item.images : [];
  const raw =
    pick(item, 'image', 'image_url', 'imageUrl', 'img_url', 'product_image') ||
    str(obj(item.image)?.src) ||
    str(images[0]) ||
    str(obj(images[0])?.src);
  if (!raw) return '';
  const url = raw.startsWith('//') ? `https:${raw}` : raw;
  return /^https:\/\//i.test(url) ? url : '';
}

/** Shopify numeric id from a plain number or a gid://shopify/… string. */
function shopifyId(value: unknown): string | null {
  const raw = str(value);
  const match = /(\d+)$/.exec(raw);
  return match ? match[1] : null;
}

// A stage like ORDER_PLACED means the cart did convert; Shopify's
// orders/create covers that, so no reminders.
const COMPLETED_STAGE = /order[_ ]?(placed|created|complete)|converted|completed|success/i;

export function parseShiprocketAbandonedCart(
  body: unknown,
  defaultCountryCode: string | null
): ShiprocketParseResult {
  const root = obj(body);
  if (!root) return { ok: false, reason: 'invalid_payload' };
  const cart = obj(root.data) ?? obj(root.cart) ?? obj(root.payload) ?? root;

  const stage = pick(cart, 'latest_stage', 'stage', 'status') || null;
  if (stage && COMPLETED_STAGE.test(stage)) {
    return { ok: false, reason: 'checkout_completed', stage };
  }

  const cartId = pick(
    cart,
    'cart_id',
    'cartId',
    'checkout_id',
    'token',
    'id',
    'order_id'
  );
  if (!cartId) return { ok: false, reason: 'missing_id', stage };

  const customer = obj(cart.customer) ?? obj(cart.user) ?? {};
  const billing = obj(cart.billing_address) ?? {};
  const shipping = obj(cart.shipping_address) ?? {};
  const firstName =
    pick(cart, 'first_name', 'firstName') ||
    pick(customer, 'first_name', 'firstName') ||
    pick(shipping, 'first_name') ||
    pick(billing, 'first_name') ||
    (
      pick(cart, 'customer_name', 'name') ||
      pick(customer, 'name', 'full_name')
    ).split(' ')[0] ||
    '';
  const lastName =
    pick(cart, 'last_name', 'lastName') ||
    pick(customer, 'last_name', 'lastName') ||
    pick(shipping, 'last_name') ||
    pick(billing, 'last_name');
  const fullName =
    pick(cart, 'customer_name', 'name') ||
    pick(customer, 'name', 'full_name') ||
    [firstName, lastName].filter(Boolean).join(' ');

  const phone = pickOrderPhone(
    [
      pick(cart, 'phone_number', 'phone', 'mobile', 'customer_phone'),
      pick(customer, 'phone_number', 'phone', 'mobile'),
      pick(shipping, 'phone'),
      pick(billing, 'phone'),
    ],
    defaultCountryCode
  );

  const items = [cart.items, cart.line_items, cart.cart_items].find(
    Array.isArray
  ) as unknown[] | undefined;
  let count = 0;
  let total = 0;
  let hasTotal = false;
  let first = '';
  let productName = '';
  let picture = '';
  let lineItem: ExternalCheckout['lineItem'] = null;
  for (const raw of items ?? []) {
    const item = obj(raw);
    if (!item) continue;
    const quantity = num(item.quantity ?? item.qty);
    const qty = quantity && quantity > 0 ? quantity : 1;
    count += qty;
    const lineTotal =
      num(item.line_price ?? item.total_price ?? item.final_line_price) ??
      (num(item.price) ?? 0) * qty;
    if (lineTotal) {
      total += lineTotal;
      hasTotal = true;
    }
    if (!first) {
      const title = pick(item, 'title', 'name', 'product_title', 'product_name');
      const variant = pick(item, 'variant_title');
      const name =
        variant && variant.toLowerCase() !== 'default title' && title
          ? `${title} (${variant})`
          : title;
      if (name) first = `${name} × ${qty}`;
      productName = title;
      const ref = {
        variantId: shopifyId(item.variant_id ?? item.variantId),
        productId: shopifyId(item.product_id ?? item.productId),
      };
      if (ref.variantId || ref.productId) lineItem = ref;
    }
    if (!picture) picture = imageUrl(item);
  }

  const fields: ShopifyFields = {};
  const put = (key: keyof ShopifyFields, value: string) => {
    if (value) fields[key] = value;
  };
  put('customer_first_name', firstName);
  put('customer_name', fullName);
  const payable = num(
    cart.total_price ?? cart.total ?? cart.cart_total ?? cart.grand_total
  );
  put(
    'order_total',
    payable !== null ? money(payable) : hasTotal ? money(total) : ''
  );
  put('currency', pick(cart, 'currency', 'currency_code') || 'INR');
  const more = (items?.length ?? 0) - 1;
  put(
    'item_summary',
    sanitizeTemplateValue(first && more > 0 ? `${first} +${more} more` : first)
  );
  put('product_name', productName);
  if (count > 0) fields.item_count = String(count);
  const checkoutUrl = pick(
    cart,
    'checkout_url',
    'cart_url',
    'abandoned_checkout_url',
    'recovery_url'
  );
  put('checkout_url', checkoutUrl);
  put('checkout_url_path', checkoutUrl ? urlPath(checkoutUrl) : '');
  put('product_image_url', picture);

  let shopDomain = pick(cart, 'shop_domain', 'shopify_domain', 'domain') || null;
  if (!shopDomain && checkoutUrl) {
    try {
      shopDomain = new URL(checkoutUrl).hostname || null;
    } catch {
      shopDomain = null;
    }
  }

  return {
    ok: true,
    stage,
    checkout: {
      checkoutId: `${SHIPROCKET_CHECKOUT_PREFIX}${cartId}`,
      phone,
      customerName: fullName || null,
      fields,
      lineItem,
      shopDomain,
    },
  };
}
