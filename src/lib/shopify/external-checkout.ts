// ============================================================
// An abandoned cart from a third-party checkout (FlexyPe, Shiprocket
// Checkout) that replaces Shopify's own, already parsed into the
// fields a Shopify checkout would give. processExternalCheckout turns
// it into cart reminders. Pure — no server-only imports.
// ============================================================

import type { LineItemRef, ShopifyFields } from '@/lib/shopify/order-fields';

export interface ExternalCheckout {
  /** `<provider>:<cart id>` — the shopify_checkouts key. */
  checkoutId: string;
  /** Digits-only E.164, or null when none could be placed. */
  phone: string | null;
  customerName: string | null;
  fields: ShopifyFields;
  /** First cart item, to look its picture up when none was sent. */
  lineItem: LineItemRef | null;
  shopDomain: string | null;
}
