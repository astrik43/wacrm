// ============================================================
// Send one Shopify-triggered WhatsApp notification, exactly once.
//
// An update can send several messages ("steps"): the first, plus
// follow-ups such as a feedback request days after delivery. Each step
// goes through the same path with its own dedupe key and delay.
//
// Order of operations matters:
//   1. Is the event switched on? Which messages apply depends on how
//      the order is paid: the COD / prepaid ones if any of those is on,
//      otherwise the "all orders" ones. Nothing on → do nothing and
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
//   5. Test mode: while it is on, only the store's test numbers get
//      messages; any other phone is recorded as `skipped` (test_mode)
//      and never scheduled. Checked again at send time, so a message
//      scheduled before test mode was switched on is held back too.
//   6. Send through the shared core as an automated ('bot') message
//      that does not end the contact's running Flow.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  stepDedupeKey,
  type PaymentMode,
  type ShopifyEvent,
  type ShopifyVariant,
} from './events';
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
  step: number;
  is_enabled: boolean;
  template_name: string | null;
  template_language: string | null;
  variable_mapping: unknown;
  delay_minutes: number | null;
}

const EVENT_COLUMNS =
  'variant, step, is_enabled, template_name, template_language, variable_mapping, delay_minutes';
const MAX_REASON_LEN = 500;

/** Whether the store is in test mode, and who may still be messaged. */
export interface TestGuard {
  testMode: boolean;
  phones: string[];
}

/**
 * The account's test-mode settings. `null` when they can't be read —
 * callers must not send then: test mode exists so that a customer
 * never gets a message the merchant is still trying out.
 */
export async function loadTestGuard(
  db: SupabaseClient,
  accountId: string
): Promise<TestGuard | null> {
  const { data, error } = await db
    .from('shopify_configs')
    .select('test_mode, test_phones')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[shopify] test mode lookup failed:', error.message);
    return null;
  }
  const row = data as { test_mode?: boolean; test_phones?: string[] | null } | null;
  return {
    testMode: row?.test_mode === true,
    phones: Array.isArray(row?.test_phones) ? row.test_phones : [],
  };
}

export function blockedByTestMode(guard: TestGuard, phone: string | null): boolean {
  return guard.testMode && !(phone && guard.phones.includes(phone));
}

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
 * The messages this event sends for this payment mode, first step
 * first: the mode's own ones when any of them is switched on, else the
 * "all orders" ones. Empty when nothing is switched on.
 */
export async function pickEventSteps(
  db: SupabaseClient,
  accountId: string,
  event: ShopifyEvent,
  paymentMode: PaymentMode | null
): Promise<{ rows: EventTemplateRow[]; error: boolean }> {
  const { data, error } = await db
    .from('shopify_event_templates')
    .select(EVENT_COLUMNS)
    .eq('account_id', accountId)
    .eq('event', event);
  if (error) {
    console.error('[shopify] event template lookup failed:', error.message);
    return { rows: [], error: true };
  }
  const usable = ((data as EventTemplateRow[] | null) ?? []).filter(
    (r) => r.is_enabled && r.template_name
  );
  const ofVariant = (variant: ShopifyVariant) =>
    usable
      .filter((r) => r.variant === variant)
      .sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  const own = paymentMode ? ofVariant(paymentMode) : [];
  return { rows: own.length > 0 ? own : ofVariant('all'), error: false };
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
    /**
     * Test-mode settings already loaded by the caller; 'bypass' for a
     * "Send test", which goes to the number the admin chose.
     */
    testGuard?: TestGuard | 'bypass';
  }
): Promise<NotifyOutcome> {
  const skip = async (reason: string): Promise<NotifyOutcome> => {
    await finish(db, ledgerId, { status: 'skipped', reason, payload: null });
    return { status: 'skipped', reason };
  };

  if (!input.phone) return skip('no_phone');
  if (input.testGuard !== 'bypass') {
    const guard = input.testGuard ?? (await loadTestGuard(db, accountId));
    if (!guard) {
      await finish(db, ledgerId, { status: 'failed', reason: 'db_error', payload: null });
      return { status: 'failed', reason: 'db_error' };
    }
    if (blockedByTestMode(guard, input.phone)) return skip('test_mode');
  }
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

/**
 * Claim, and send or schedule, every message the event has switched
 * on. Returns the first message's outcome — that is what the webhook
 * log shows; follow-ups appear in Activity on their own rows.
 */
export async function notifyShopifyEvent(
  db: SupabaseClient,
  accountId: string,
  input: NotifyInput
): Promise<NotifyOutcome> {
  const paymentMode = input.paymentMode ?? null;

  // 1. Switched on?
  const picked = await pickEventSteps(db, accountId, input.event, paymentMode);
  if (picked.error) {
    // Unknown whether the merchant wants this message — don't claim,
    // so a later delivery of the same change can still send it.
    return { status: 'failed', reason: 'db_error' };
  }
  if (picked.rows.length === 0) return { status: 'disabled' };

  const guard = await loadTestGuard(db, accountId);
  if (!guard) return { status: 'failed', reason: 'db_error' };

  let first: NotifyOutcome | null = null;
  for (const eventRow of picked.rows) {
    const outcome = await notifyStep(
      db,
      accountId,
      input,
      eventRow,
      paymentMode,
      guard
    );
    first ??= outcome;
  }
  return first ?? { status: 'disabled' };
}

async function notifyStep(
  db: SupabaseClient,
  accountId: string,
  input: NotifyInput,
  eventRow: EventTemplateRow,
  paymentMode: PaymentMode | null,
  guard: TestGuard
): Promise<NotifyOutcome> {
  const step = eventRow.step ?? 0;
  const delayMinutes = Math.max(0, Math.floor(eventRow.delay_minutes ?? 0));
  // Nothing to wait for when there is nobody to send to (or test mode
  // holds this phone back): claim it as an ordinary row so it is
  // recorded as skipped straight away.
  const scheduled =
    delayMinutes > 0 &&
    Boolean(input.phone) &&
    !blockedByTestMode(guard, input.phone);
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
        step,
        shopify_order_id: input.orderId,
        shopify_fulfillment_id: input.fulfillmentId,
        shopify_checkout_id: input.checkoutId ?? null,
        order_name: input.orderName,
        dedupe_key: stepDedupeKey(input.dedupeKey, step),
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
    testGuard: guard,
  });
}

export interface TestSendInput {
  event: ShopifyEvent;
  variant: ShopifyVariant;
  step: number;
  templateName: string;
  templateLanguage: string | null;
  variableMapping: unknown;
  phone: string;
  /** Shown in Activity, e.g. "Test · #1042". */
  orderName: string;
  fields: ShopifyFields;
}

/**
 * "Send test" from the settings dialog: send one message right now to
 * the number the admin chose, whatever its delay and whether or not it
 * is switched on, and whether or not test mode is on. Logged in
 * Activity as a test so it is never mistaken for a customer message.
 */
export async function sendTestNotification(
  db: SupabaseClient,
  accountId: string,
  input: TestSendInput
): Promise<NotifyOutcome> {
  const { data, error } = await db
    .from('shopify_notifications')
    .insert({
      account_id: accountId,
      event: input.event,
      step: input.step,
      variant: input.variant,
      order_name: input.orderName,
      dedupe_key: `test:${crypto.randomUUID()}`,
      status: 'pending',
      is_test: true,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[shopify] test send claim failed:', error?.message);
    return { status: 'failed', reason: 'db_error' };
  }

  return deliverNotification(
    db,
    accountId,
    (data as { id: string }).id,
    {
      variant: input.variant,
      step: input.step,
      is_enabled: true,
      template_name: input.templateName,
      template_language: input.templateLanguage,
      variable_mapping: input.variableMapping,
      delay_minutes: 0,
    },
    {
      event: input.event,
      orderId: null,
      phone: input.phone,
      // A test must not rename the admin's own contact.
      customerName: null,
      fields: input.fields,
      testGuard: 'bypass',
    }
  );
}
