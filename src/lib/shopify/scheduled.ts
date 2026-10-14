// ============================================================
// Deliver Shopify notifications whose delay has run out.
//
// A notification with a delay is claimed as `scheduled` by
// notifyShopifyEvent and waits here. GET /api/shopify/cron calls
// `runDueNotifications` on a schedule; nothing inside the app does.
//
// Per row:
//   1. CLAIM it (scheduled → pending, by id) so overlapping cron runs
//      can't both send it. Same at-most-once trade-off as the
//      immediate path: a crash after the claim leaves a `pending` row.
//   2. Is it still wanted? The order may have been cancelled, the cart
//      bought, or the update switched off since it was scheduled —
//      those end as `cancelled` with the reason.
//   3. Send with the template settings as they are NOW, so fixing a
//      template or mapping applies to messages already waiting. A
//      follow-up whose step was removed since is cancelled.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isCartEvent, isPaymentMode, isShopifyEvent } from './events';
import {
  deliverNotification,
  pickEventSteps,
  type NotifyOutcome,
  type NotifyPayload,
} from './notify';
import type { ShopifyFields } from './order-fields';

const BATCH = 50;

interface DueRow {
  id: string;
  account_id: string;
  event: string;
  step: number | null;
  shopify_order_id: string | null;
  shopify_checkout_id: string | null;
  payload: Partial<NotifyPayload> | null;
}

export interface RunSummary {
  due: number;
  sent: number;
  cancelled: number;
  skipped: number;
  failed: number;
}

async function cancel(
  db: SupabaseClient,
  id: string,
  reason: string
): Promise<void> {
  const { error } = await db
    .from('shopify_notifications')
    .update({ status: 'cancelled', reason, payload: null })
    .eq('id', id);
  if (error) {
    console.error('[shopify] could not cancel notification:', error.message);
  }
}

/** Why a due row should not be sent after all, or null to go ahead. */
async function stopReason(
  db: SupabaseClient,
  row: DueRow,
  phone: string | null
): Promise<{ reason: string | null; fields?: ShopifyFields }> {
  if (row.shopify_order_id && row.event !== 'order_cancelled') {
    const { data } = await db
      .from('shopify_orders')
      .select('cancelled_at')
      .eq('account_id', row.account_id)
      .eq('shopify_order_id', row.shopify_order_id)
      .maybeSingle();
    if ((data as { cancelled_at: string | null } | null)?.cancelled_at) {
      return { reason: 'order_cancelled' };
    }
  }

  if (row.shopify_checkout_id) {
    const { data } = await db
      .from('shopify_checkouts')
      .select('completed_at, created_at, fields')
      .eq('account_id', row.account_id)
      .eq('shopify_checkout_id', row.shopify_checkout_id)
      .maybeSingle();
    const checkout = data as {
      completed_at: string | null;
      created_at: string;
      fields: ShopifyFields | null;
    } | null;
    if (checkout?.completed_at) return { reason: 'checkout_completed' };

    // Third-party checkouts never mark the Shopify checkout completed;
    // an order from the same phone since then means they bought.
    if (phone && checkout) {
      const { data: orders } = await db
        .from('shopify_orders')
        .select('id')
        .eq('account_id', row.account_id)
        .eq('phone', phone)
        .gte('created_at', checkout.created_at)
        .limit(1);
      if (orders && orders.length > 0) return { reason: 'order_placed' };
    }
    // The cart as it is now, not as it was when first seen.
    if (checkout?.fields) return { reason: null, fields: checkout.fields };
  }

  return { reason: null };
}

export async function runDueNotifications(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<RunSummary> {
  const summary: RunSummary = {
    due: 0,
    sent: 0,
    cancelled: 0,
    skipped: 0,
    failed: 0,
  };

  const { data, error } = await db
    .from('shopify_notifications')
    .select(
      'id, account_id, event, step, shopify_order_id, shopify_checkout_id, payload'
    )
    .eq('status', 'scheduled')
    .lte('send_at', now.toISOString())
    .order('send_at', { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(error.message);

  const due = (data as DueRow[] | null) ?? [];
  summary.due = due.length;

  for (const row of due) {
    const { data: claim } = await db
      .from('shopify_notifications')
      .update({ status: 'pending' })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    try {
      if (!isShopifyEvent(row.event)) {
        await cancel(db, row.id, 'unknown_event');
        summary.cancelled++;
        continue;
      }
      const event = row.event;
      const payload = row.payload ?? {};
      const phone = typeof payload.phone === 'string' ? payload.phone : null;

      const stop = await stopReason(db, row, phone);
      if (stop.reason) {
        await cancel(db, row.id, stop.reason);
        summary.cancelled++;
        continue;
      }

      const paymentMode =
        !isCartEvent(event) && isPaymentMode(payload.paymentMode)
          ? payload.paymentMode
          : null;
      const picked = await pickEventSteps(
        db,
        row.account_id,
        event,
        paymentMode
      );
      if (picked.error) {
        // Put it back; the next run tries again.
        await db
          .from('shopify_notifications')
          .update({ status: 'scheduled' })
          .eq('id', row.id);
        summary.failed++;
        continue;
      }
      const stepRow = picked.rows.find((r) => (r.step ?? 0) === (row.step ?? 0));
      if (!stepRow) {
        await cancel(db, row.id, 'event_disabled');
        summary.cancelled++;
        continue;
      }

      const outcome: NotifyOutcome = await deliverNotification(
        db,
        row.account_id,
        row.id,
        stepRow,
        {
          event,
          orderId: row.shopify_order_id,
          phone,
          customerName:
            typeof payload.customerName === 'string'
              ? payload.customerName
              : null,
          fields: { ...(payload.fields ?? {}), ...(stop.fields ?? {}) },
        }
      );
      if (outcome.status === 'sent') summary.sent++;
      else if (outcome.status === 'skipped') summary.skipped++;
      else summary.failed++;
    } catch (err) {
      const reason = (
        err instanceof Error ? err.message : 'unknown_error'
      ).slice(0, 500);
      console.error('[shopify] scheduled send threw:', reason);
      await db
        .from('shopify_notifications')
        .update({ status: 'failed', reason, payload: null })
        .eq('id', row.id);
      summary.failed++;
    }
  }

  return summary;
}
