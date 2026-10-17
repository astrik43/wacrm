// ============================================================
// Automatic contact tags from Shopify / FlexyPe behaviour, so
// broadcasts can target "delivered customers", "RTO", "COD buyers"…
//
// Two kinds of tag:
//
//   Order status (one at a time — the latest order's state)
//     Order placed → Shipped → Out for delivery → Delivery attempted
//     → Delivered, or RTO / Cancelled. Setting one removes the others.
//
//   Lasting
//     COD buyer / Prepaid buyer — added on every order, never removed.
//     Abandoned cart — added when a cart is abandoned, removed when
//     the customer places an order.
//
// Tags are ordinary account tags (created on first use), added through
// the same path as a manual tag, so "tag added" automations fire too.
// Tagging never blocks or fails the webhook that triggered it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findOrCreateContact,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';

import type { PaymentMode } from './events';

export const ORDER_STATUS_TAGS = {
  placed: 'Order placed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  attempted: 'Delivery attempted',
  delivered: 'Delivered',
  rto: 'RTO',
  cancelled: 'Cancelled',
} as const;

export type OrderStatusTag = keyof typeof ORDER_STATUS_TAGS;

export const BUYER_TAGS: Record<PaymentMode, string> = {
  cod: 'COD buyer',
  prepaid: 'Prepaid buyer',
};

export const ABANDONED_CART_TAG = 'Abandoned cart';

export interface TagChange {
  add: string[];
  remove: string[];
}

/** Make `status` the contact's only order-status tag. */
export function statusTagChange(status: OrderStatusTag): TagChange {
  const add = ORDER_STATUS_TAGS[status];
  return {
    add: [add],
    remove: Object.values(ORDER_STATUS_TAGS).filter((name) => name !== add),
  };
}

/** Tags for a newly placed order. */
export function orderPlacedTags(paymentMode: PaymentMode): TagChange {
  const status = statusTagChange('placed');
  return {
    add: [...status.add, BUYER_TAGS[paymentMode]],
    remove: [...status.remove, ABANDONED_CART_TAG],
  };
}

/**
 * The order-status tag a shipment's Shopify status means, or null for
 * a status that says nothing new. A shipment without a status yet (just
 * created with tracking) counts as shipped.
 */
export function shipmentStatusTag(
  shipmentStatus: string | null
): OrderStatusTag | null {
  switch (shipmentStatus) {
    case null:
    case 'label_printed':
    case 'label_purchased':
    case 'confirmed':
    case 'carrier_picked_up':
    case 'in_transit':
    case 'ready_for_pickup':
      return 'shipped';
    case 'out_for_delivery':
      return 'out_for_delivery';
    case 'attempted_delivery':
      return 'attempted';
    case 'delivered':
      return 'delivered';
    // Shopify has no RTO status; couriers report a failed delivery
    // headed back to the store as `failure`.
    case 'failure':
      return 'rto';
    default:
      return null;
  }
}

/**
 * Apply a tag change to the contact for `phone` (created if the
 * customer isn't a contact yet). Logs and returns on any failure.
 */
export async function applyAutoTags(
  db: SupabaseClient,
  accountId: string,
  phone: string | null,
  customerName: string | null,
  change: TagChange
): Promise<void> {
  if (!phone || (change.add.length === 0 && change.remove.length === 0)) {
    return;
  }
  try {
    const auditUserId = await resolveAuditUserId(db, accountId);
    const contact = await findOrCreateContact(db, accountId, auditUserId, {
      phone: `+${phone.replace(/^\+/, '')}`,
      name: customerName,
    });

    const [{ tagIdByKey: addIds }, { tagIdByKey: knownIds }] = await Promise.all([
      resolveImportTagIds(db, {
        accountId,
        userId: auditUserId,
        tagNames: change.add,
        canCreateTags: true,
      }),
      // Removal only ever touches tags that already exist.
      resolveImportTagIds(db, {
        accountId,
        userId: auditUserId,
        tagNames: change.remove,
        canCreateTags: false,
      }),
    ]);
    const idsFor = (names: string[], map: Map<string, string>) =>
      names
        .map((name) => map.get(name.trim().toLowerCase()))
        .filter((id): id is string => !!id);
    const addTagIds = idsFor(change.add, addIds);
    const removeTagIds = idsFor(change.remove, knownIds).filter(
      (id) => !addTagIds.includes(id)
    );

    const { data: current, error: readError } = await db
      .from('contact_tags')
      .select('tag_id')
      .eq('contact_id', contact.id);
    if (readError) throw readError;
    const has = new Set((current ?? []).map((r) => r.tag_id as string));

    const stale = removeTagIds.filter((id) => has.has(id));
    if (stale.length > 0) {
      const { error } = await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', contact.id)
        .in('tag_id', stale);
      if (error) throw error;
    }
    for (const tagId of addTagIds) {
      if (has.has(tagId)) continue;
      await addContactTagAndDispatch({
        db,
        accountId,
        contactId: contact.id,
        tagId,
      });
    }
  } catch (err) {
    console.error('[shopify] auto-tagging failed:', err);
  }
}
