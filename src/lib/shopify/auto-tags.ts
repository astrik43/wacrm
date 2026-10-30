// ============================================================
// Automatic contact tags from Shopify / FlexyPe / Shiprocket behaviour, so
// broadcasts can target COD customers, prepaid customers and abandoned
// carts. The names match the ones Interakt used, so contacts imported
// from Interakt and new customers share the same tags.
//
//   Order Placed(CoD) / Order Placed(Prepaid)
//     added on every order by how it is paid, never removed — a
//     customer who ordered both ways has both.
//   Abandoned Cart
//     added when a cart is abandoned, removed when the customer places
//     an order.
//
// Shipment progress is deliberately not tagged: with several orders in
// flight a single status tag can't say which order it is about.
//
// Tags are ordinary account tags (created on first use, matched
// case-insensitively), added through the same path as a manual tag, so
// "tag added" automations fire too. Tagging never blocks or fails the
// webhook that triggered it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findOrCreateContact,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';

import type { PaymentMode } from './events';

export const ORDER_PLACED_TAGS: Record<PaymentMode, string> = {
  cod: 'Order Placed(CoD)',
  prepaid: 'Order Placed(Prepaid)',
};

export const ABANDONED_CART_TAG = 'Abandoned Cart';

export interface TagChange {
  add: string[];
  remove: string[];
}

/** Tags for a newly placed order: its payment tag; the cart is bought. */
export function orderPlacedTags(paymentMode: PaymentMode): TagChange {
  return {
    add: [ORDER_PLACED_TAGS[paymentMode]],
    remove: [ABANDONED_CART_TAG],
  };
}

/** Tags for an abandoned checkout. */
export function abandonedCartTags(): TagChange {
  return { add: [ABANDONED_CART_TAG], remove: [] };
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
