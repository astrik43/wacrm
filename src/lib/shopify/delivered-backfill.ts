// ============================================================
// Tag the customers of past orders "Order Delivered" / "Order RTO".
//
// New shipments are tagged as Shopify reports them (handleFulfillment
// in process.ts). Orders from before that — including ones from before
// the store was connected — are read back from Shopify, a page of 100
// at a time: the settings page calls this once per page and passes the
// cursor on, so no single request runs long and the admin sees
// progress. Tagging is idempotent (a contact that already has a tag is
// left alone, so no automation fires twice), so running it again is
// harmless.
//
//   Order Delivered — a shipment Shopify shows as delivered, on an
//                     order that isn't cancelled.
//   Order RTO       — a shipment Shopify shows as not delivered,
//                     cancelled or not (a returned COD order usually
//                     gets cancelled afterwards).
//
// A customer can get both. One without a contact yet gets one, exactly
// as a new order would make one. While test mode is on, only test
// numbers are tagged, as with live webhooks.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchOrderDeliveryPage } from './admin-api';
import {
  applyAutoTags,
  orderDeliveredTags,
  orderRtoTags,
  type TagChange,
} from './auto-tags';
import type { ShopifyConfigRow } from './config';
import { pickOrderPhone } from './phone';
import { allowedInTestMode } from './process';

export type DeliveredPageResult =
  | {
      ok: true;
      /** Orders read from Shopify on this page. */
      scanned: number;
      /** Distinct customers tagged "Order Delivered" on this page. */
      delivered: number;
      /** Distinct customers tagged "Order RTO" on this page. */
      returned: number;
      /** Delivered or returned orders with no usable phone number. */
      noPhone: number;
      /** Creation time of the oldest order Shopify returned (first page). */
      oldestOrderAt: string | null;
      nextCursor: string | null;
    }
  | { ok: false; error: string };

interface Customer {
  name: string | null;
  delivered: boolean;
  returned: boolean;
}

export async function tagDeliveredCustomersPage(
  db: SupabaseClient,
  config: ShopifyConfigRow,
  after: string | null
): Promise<DeliveredPageResult> {
  const page = await fetchOrderDeliveryPage(db, config, after);
  if (!page.ok) return page;

  const customers = new Map<string, Customer>();
  let noPhone = 0;
  for (const order of page.orders) {
    const delivered = order.delivered && !order.cancelled;
    const returned = order.returned;
    if (!delivered && !returned) continue;
    const phone = pickOrderPhone(order.phones, config.default_country_code);
    if (!phone) {
      noPhone++;
      continue;
    }
    if (!allowedInTestMode(config, phone)) continue;
    const customer = customers.get(phone) ?? {
      name: null,
      delivered: false,
      returned: false,
    };
    customer.name ??= order.name;
    customer.delivered ||= delivered;
    customer.returned ||= returned;
    customers.set(phone, customer);
  }

  let delivered = 0;
  let returned = 0;
  for (const [phone, customer] of customers) {
    const change: TagChange = { add: [], remove: [] };
    if (customer.delivered) {
      change.add.push(...orderDeliveredTags().add);
      delivered++;
    }
    if (customer.returned) {
      change.add.push(...orderRtoTags().add);
      returned++;
    }
    await applyAutoTags(db, config.account_id, phone, customer.name, change);
  }

  // Oldest first, so the first page holds the oldest order.
  const oldestOrderAt = after ? null : (page.orders[0]?.createdAt ?? null);
  return {
    ok: true,
    scanned: page.orders.length,
    delivered,
    returned,
    noPhone,
    oldestOrderAt,
    nextCursor: page.nextCursor,
  };
}
