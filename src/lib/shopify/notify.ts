// ============================================================
// Send one Shopify-triggered WhatsApp notification, exactly once.
//
// Order of operations matters:
//   1. Is the event switched on? Which template applies depends on
//      how the order is paid: the COD / prepaid row if that one is on,
//      otherwise the "all orders" row. Nothing on → do nothing and
//      leave no row.
//   2. CLAIM the (event, order/shipment/cart) in
//      `shopify_notifications` before sending. The unique dedupe key
//      means Shopify's retries and concurrent deliveries can't produce
//      a second message. The trade-off is at-most-once: a crash
//      between claim and send leaves a `pending` row and no message.
//   3. A row with a delay is claimed as `scheduled` with everything
//      needed to send it later; GET /api/shopify/cron delivers it
//      (see scheduled.ts).
//   4. Everything that can stop the send (no phone, template not
//      approved, a mapped value missing for this order) is recorded on
//      the claimed row as `skipped` with a reason — that row is what
//      the merchant sees in Settings → Shopify → Activity.
//   5. Send through the shared core as an automated ('bot') message
//      that does not end the contact's running Flow.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { PaymentMode, ShopifyEvent, ShopifyVariant } from './events';
import type { ShopifyFields } from './order-fields';
import { parseVariableMapping, resolveSendParams } from './variable-mapping';

export interface NotifyInput {
  event: ShopifyEvent;
  dedupeKey: string;
  orderId: string | null;
  fulfillmentId: string | null;
  /** Set for cart reminders. */
  checkoutId?: string | null;
  orderName: string | null;
  /** Digits-only international number, or null when none was usable. */
  phone: string | null;
  customerName: string | null;
  fields: ShopifyFields;
  /** How the order is paid; null/absent for carts and unknown orders. */
  paymentMode?: PaymentMode | null;
  webhookId: string | null;
}

export type NotifyOutcome =
  | { status: 'disabled' }
  | { status: 'duplicate' }
  | { status: 'scheduled'; sendAt: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'sent'; messageId: string };

/** What a scheduled row needs to be sent without its webhook. */
export interface NotifyPayload {
  phone: string | null;
  customerName: string | null;
  fields: ShopifyFields;
  paymentMode: PaymentMode | null;
}

export interface EventTemplateRow {
  variant: ShopifyVariant;
  is_enabled: boolean;
  template_name: string | null;
  template_language: string | null;
  variable_mapping: unknown;
  delay_minutes: number | null;
}

const EVENT_COLUMNS =
  'variant, is_enabled, template_name, template_language, variable_mapping, delay_minutes';
const MAX_REASON_LEN = 500;

async function finish(
  db: SupabaseClient,
  ledgerId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from('shopify_notifications')
    .update(patch)
    .eq('id', ledgerId);
  if (error) {
    console.error('[shopify] failed to record notification outcome:', error.message);
  }
}

/**
 * The template settings that apply to this event for this payment
 * mode: the mode's own row when it is switched on, else "all orders".
 * `row` is null when nothing is switched on.
 */
export async function pickEventTemplate(
  db: SupabaseClient,
  accountId: string,
  event: ShopifyEvent,
  paymentMode: PaymentMode | null
): Promise<{ row: EventTemplateRow | null; error: boolean }> {
  const { data, error } = await db
    .from('shopify_event_templates')
    .select(EVENT_COLUMNS)
    .eq('account_id', accountId)
    .eq('event', event);
  if (error) {
    console.error('[shopify] event template lookup failed:', error.message);
    return { row: null, error: true };
  }
  const usable = ((data as EventTemplateRow[] | null) ?? []).filter(
    (r) => r.is_enabled && r.template_name
  );
  const row =
    (paymentMode && usable.find((r) => r.variant === paymentMode)) ||
    usable.find((r) => r.variant === 'all') ||
    null;
  return { row, error: false };
}

/**
 * Send an already-claimed notification and record what happened on
 * its ledger row. Shared by the immediate path and the cron.
 */
export async function deliverNotification(
  db: SupabaseClient,
  accountId: string,
  ledgerId: string,
  eventRow: EventTemplateRow,
  input: {
    event: ShopifyEvent;
    orderId: string | null;
    phone: string | null;
    customerName: string | null;
    fields: ShopifyFields;
  }
): Promise<NotifyOutcome> {
  const skip = async (reason: string): Promise<NotifyOutcome> => {
    await finish(db, ledgerId, { status: 'skipped', reason, payload: null });
    return { status: 'skipped', reason };
  };

  if (!input.phone) return skip('no_phone');
  if (!eventRow.template_name) return skip('template_not_found');

  const resolved = await resolveTemplateRow(
    db,
    accountId,
    eventRow.template_name,
    eventRow.template_language
  );
  if (resolved.malformed) return skip('template_malformed');
  // Without the local row the send would go out with no components at
  // all, and we couldn't check approval — treat it as not sendable.
  if (!resolved.row) return skip('template_not_found');
  if (resolved.row.status !== 'APPROVED') return skip('template_not_approved');

  const mapping = parseVariableMapping(eventRow.variable_mapping);
  if (!mapping) return skip('mapping_invalid');
  const params = resolveSendParams(resolved.row, mapping, input.fields);
  if (!params.ok) return skip(`missing_variable:${params.missing}`);

  try {
    // No name passed: resolveConversationByPhone renames an EXISTING
    // contact to whatever it is given, and a Shopify checkout name must
    // not overwrite one an agent curated.
    const conversation = await resolveConversationByPhone(
      db,
      accountId,
      input.phone
    );
    if (conversation.contactCreated && input.customerName) {
      await db
        .from('contacts')
        .update({ name: input.customerName })
        .eq('id', conversation.contactId)
        .eq('account_id', accountId);
    }

    const result = await sendMessageToConversation(
      db,
      accountId,
      {
        conversationId: conversation.conversationId,
        messageType: 'template',
        templateName: resolved.row.name,
        templateLanguage: resolved.language,
        templateParams: params.params.body ?? [],
        templateMessageParams: params.params,
      },
      { senderType: 'bot', pauseActiveFlows: false }
    );

    await finish(db, ledgerId, {
      status: 'sent',
      message_id: result.messageId,
      whatsapp_message_id: result.whatsappMessageId,
      payload: null,
    });
    if (input.orderId) {
      await db
        .from('shopify_orders')
        .update({ contact_id: conversation.contactId })
        .eq('account_id', accountId)
        .eq('shopify_order_id', input.orderId);
    }
    return { status: 'sent', messageId: result.messageId };
  } catch (err) {
    const reason = (
      err instanceof SendMessageError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : 'unknown_error'
    ).slice(0, MAX_REASON_LEN);
    console.error(`[shopify] ${input.event} send failed:`, reason);
    await finish(db, ledgerId, { status: 'failed', reason, payload: null });
    return { status: 'failed', reason };
  }
}

export async function notifyShopifyEvent(
  db: SupabaseClient,
  accountId: string,
  input: NotifyInput
): Promise<NotifyOutcome> {
  const paymentMode = input.paymentMode ?? null;

  // 1. Switched on?
  const picked = await pickEventTemplate(db, accountId, input.event, paymentMode);
  if (picked.error) {
    // Unknown whether the merchant wants this message — don't claim,
    // so a later delivery of the same change can still send it.
    return { status: 'failed', reason: 'db_error' };
  }
  const eventRow = picked.row;
  if (!eventRow) return { status: 'disabled' };

  const delayMinutes = Math.max(0, Math.floor(eventRow.delay_minutes ?? 0));
  // Nothing to wait for when there is nobody to send to: claim it as
  // an ordinary row so it is recorded as skipped straight away.
  const scheduled = delayMinutes > 0 && Boolean(input.phone);
  const sendAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  const payload: NotifyPayload = {
    phone: input.phone,
    customerName: input.customerName,
    fields: input.fields,
    paymentMode,
  };

  // 2. Claim. An empty result means another delivery already owns it.
  const { data: claimed, error: claimErr } = await db
    .from('shopify_notifications')
    .upsert(
      {
        account_id: accountId,
        event: input.event,
        shopify_order_id: input.orderId,
        shopify_fulfillment_id: input.fulfillmentId,
        shopify_checkout_id: input.checkoutId ?? null,
        order_name: input.orderName,
        dedupe_key: input.dedupeKey,
        status: scheduled ? 'scheduled' : 'pending',
        variant: eventRow.variant,
        send_at: scheduled ? sendAt : null,
        payload: scheduled ? payload : null,
        shopify_webhook_id: input.webhookId,
      },
      { onConflict: 'account_id,dedupe_key', ignoreDuplicates: true }
    )
    .select('id');
  if (claimErr) {
    console.error('[shopify] notification claim failed:', claimErr.message);
    return { status: 'failed', reason: 'db_error' };
  }
  const ledgerId = (claimed as { id: string }[] | null)?.[0]?.id;
  if (!ledgerId) return { status: 'duplicate' };

  // 3. Later, or now.
  if (scheduled) return { status: 'scheduled', sendAt };

  return deliverNotification(db, accountId, ledgerId, eventRow, {
    event: input.event,
    orderId: input.orderId,
    phone: input.phone,
    customerName: input.customerName,
    fields: input.fields,
  });
}
