// ============================================================
// Send one Shopify-triggered WhatsApp notification, exactly once.
//
// Order of operations matters:
//   1. Is the event switched on? If not, do nothing and leave no row.
//   2. CLAIM the (event, order/shipment) in `shopify_notifications`
//      before sending. The unique dedupe key means Shopify's retries
//      and concurrent deliveries can't produce a second message. The
//      trade-off is at-most-once: a crash between claim and send
//      leaves a `pending` row and no message.
//   3. Everything that can stop the send (no phone, template not
//      approved, a mapped value missing for this order) is recorded on
//      the claimed row as `skipped` with a reason — that row is what
//      the merchant sees in Settings → Shopify → Activity.
//   4. Send through the shared core as an automated ('bot') message
//      that does not end the contact's running Flow.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { ShopifyEvent } from './events';
import type { ShopifyFields } from './order-fields';
import { parseVariableMapping, resolveSendParams } from './variable-mapping';

export interface NotifyInput {
  event: ShopifyEvent;
  dedupeKey: string;
  orderId: string | null;
  fulfillmentId: string | null;
  orderName: string | null;
  /** Digits-only international number, or null when none was usable. */
  phone: string | null;
  customerName: string | null;
  fields: ShopifyFields;
  webhookId: string | null;
}

export type NotifyOutcome =
  | { status: 'disabled' }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'sent'; messageId: string };

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

export async function notifyShopifyEvent(
  db: SupabaseClient,
  accountId: string,
  input: NotifyInput
): Promise<NotifyOutcome> {
  // 1. Switched on?
  const { data: eventRow, error: eventErr } = await db
    .from('shopify_event_templates')
    .select('is_enabled, template_name, template_language, variable_mapping')
    .eq('account_id', accountId)
    .eq('event', input.event)
    .maybeSingle();
  if (eventErr) {
    // Unknown whether the merchant wants this message — don't claim,
    // so a later delivery of the same change can still send it.
    console.error('[shopify] event template lookup failed:', eventErr.message);
    return { status: 'failed', reason: 'db_error' };
  }
  if (!eventRow?.is_enabled || !eventRow.template_name) {
    return { status: 'disabled' };
  }

  // 2. Claim. An empty result means another delivery already owns it.
  const { data: claimed, error: claimErr } = await db
    .from('shopify_notifications')
    .upsert(
      {
        account_id: accountId,
        event: input.event,
        shopify_order_id: input.orderId,
        shopify_fulfillment_id: input.fulfillmentId,
        order_name: input.orderName,
        dedupe_key: input.dedupeKey,
        status: 'pending',
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

  const skip = async (reason: string): Promise<NotifyOutcome> => {
    await finish(db, ledgerId, { status: 'skipped', reason });
    return { status: 'skipped', reason };
  };

  // 3. Preconditions.
  if (!input.phone) return skip('no_phone');

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

  // 4. Send.
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
    await finish(db, ledgerId, { status: 'failed', reason });
    return { status: 'failed', reason };
  }
}
