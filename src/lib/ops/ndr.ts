// ============================================================
// NDR (non-delivery report) flow.
//
//   courier reports a failed delivery attempt
//     → maybeSendNdr: ONE template per order ("we couldn't deliver
//       order {{1}}, reply 1 to reattempt, 2 for a new time"), only when
//       ops_settings.ndr_enabled, the template is approved, the order's
//       customer is allowed through Shopify test mode and is not staff.
//       ndr_requests has a unique (account, order) key, so a second
//       NDR for the same order claims nothing and sends nothing.
//   customer replies (button tap, or the text "1" / "2")
//     → handleNdrReply (called from the WhatsApp inbound webhook):
//       matches the contact's open NDR, records the answer, tags the
//       contact `NDR: reattempt` / `NDR: reschedule`, and emits the
//       `ndr.reply` outgoing webhook. The ERP comment is NOT written
//       here: the agent reads the ndr_reply event (list_events_since)
//       and posts it with the ERP's own tools. wacrm never calls the ERP.
//
// Nothing here throws into its caller: both entry points are invoked
// from webhooks that must still answer 200.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import {
  NDR_REATTEMPT_TAG,
  NDR_RESCHEDULE_TAG,
} from '@/lib/shopify/auto-tags';
import {
  blockedByTestMode,
  dropIfEmpty,
  loadTestGuard,
} from '@/lib/shopify/notify';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

import { excerpt, getOpsSettings } from './settings';
import { isStaffPhone } from './staff';

/** An unanswered NDR stops matching replies after this long. */
export const NDR_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type NdrAnswer = 'reattempt' | 'new_time' | 'other';

/** The shipment statuses that mean "a delivery attempt failed". */
export const NDR_SHIPMENT_STATUSES = ['attempted_delivery', 'failure'];

export type NdrSendOutcome =
  | { status: 'disabled' }
  | { status: 'skipped'; reason: string }
  | { status: 'duplicate' }
  | { status: 'failed'; reason: string }
  | { status: 'sent'; messageId: string };

/**
 * Send the NDR template for an order, once. Safe to call on every
 * failed-delivery update: everything that can stop it is checked
 * before the claim, and the claim is the dedupe.
 */
export async function maybeSendNdr(
  db: SupabaseClient,
  accountId: string,
  input: { orderName: string | null; phone: string | null }
): Promise<NdrSendOutcome> {
  try {
    const settings = await getOpsSettings(db, accountId);
    if (!settings.ndr_enabled || !settings.ndr_template_name) {
      return { status: 'disabled' };
    }
    const orderName = input.orderName?.trim();
    if (!orderName) return { status: 'skipped', reason: 'no_order' };
    if (!input.phone) return { status: 'skipped', reason: 'no_phone' };

    // Test mode: only the store's test numbers may be messaged.
    const guard = await loadTestGuard(db, accountId);
    if (!guard) return { status: 'failed', reason: 'db_error' };
    if (blockedByTestMode(guard, input.phone)) {
      return { status: 'skipped', reason: 'test_mode' };
    }
    if (await isStaffPhone(db, accountId, input.phone)) {
      return { status: 'skipped', reason: 'staff_contact' };
    }

    const resolved = await resolveTemplateRow(
      db,
      accountId,
      settings.ndr_template_name,
      settings.ndr_template_language
    );
    if (resolved.malformed) return { status: 'skipped', reason: 'template_malformed' };
    if (!resolved.row) return { status: 'skipped', reason: 'template_not_found' };
    if (resolved.row.status !== 'APPROVED') {
      return { status: 'skipped', reason: 'template_not_approved' };
    }

    // Claim (account, order). An empty result: this order already has one.
    const { data: claimed, error: claimError } = await db
      .from('ndr_requests')
      .upsert(
        { account_id: accountId, order_name: orderName, state: 'sent' },
        { onConflict: 'account_id,order_name', ignoreDuplicates: true }
      )
      .select('id');
    if (claimError) {
      console.error('[ndr] claim failed:', claimError.message);
      return { status: 'failed', reason: 'db_error' };
    }
    const requestId = (claimed as { id: string }[] | null)?.[0]?.id;
    if (!requestId) return { status: 'duplicate' };

    let conversationId: string | null = null;
    try {
      const conversation = await resolveConversationByPhone(db, accountId, input.phone);
      conversationId = conversation.conversationId;
      await db
        .from('ndr_requests')
        .update({ contact_id: conversation.contactId })
        .eq('id', requestId)
        .eq('account_id', accountId);

      const result = await sendMessageToConversation(
        db,
        accountId,
        {
          conversationId,
          messageType: 'template',
          templateName: resolved.row.name,
          templateLanguage: resolved.language,
          templateParams: [orderName],
          templateMessageParams: { body: [orderName] },
        },
        { senderType: 'bot', pauseActiveFlows: false }
      );
      await db
        .from('ndr_requests')
        .update({ message_id: result.messageId, sent_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('account_id', accountId);
      return { status: 'sent', messageId: result.messageId };
    } catch (err) {
      const reason =
        err instanceof SendMessageError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'unknown_error';
      console.error('[ndr] send failed:', reason);
      // Nothing reached the customer: release the claim so a later
      // failed-delivery update can try again.
      await db
        .from('ndr_requests')
        .delete()
        .eq('id', requestId)
        .eq('account_id', accountId);
      if (conversationId) await dropIfEmpty(db, accountId, conversationId);
      return { status: 'failed', reason: reason.slice(0, 500) };
    }
  } catch (err) {
    console.error('[ndr] unexpected failure:', err);
    return { status: 'failed', reason: 'unexpected_error' };
  }
}

/**
 * "1" / "2" (also "1." etc.) or the keywords a quick-reply button may
 * carry. Anything else is `null`: free text for a person.
 */
export function parseNdrAnswer(...candidates: (string | null | undefined)[]): NdrAnswer | null {
  for (const raw of candidates) {
    const v = (raw ?? '').trim().toLowerCase();
    if (!v) continue;
    if (/^1[\s.)!]*$/.test(v) || ['reattempt', 're-attempt', 'ndr_reattempt', 'ndr:reattempt'].includes(v)) {
      return 'reattempt';
    }
    if (
      /^2[\s.)!]*$/.test(v) ||
      ['new_time', 'new time', 'reschedule', 'ndr_new_time', 'ndr:new_time'].includes(v)
    ) {
      return 'new_time';
    }
  }
  return null;
}

async function tagContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  tagName: string
): Promise<void> {
  const userId = await resolveAuditUserId(db, accountId);
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId,
    tagNames: [tagName],
    canCreateTags: true,
  });
  const tagId = tagIdByKey.get(tagName.trim().toLowerCase());
  if (!tagId) return;
  await addContactTagAndDispatch({ db, accountId, contactId, tagId });
}

/**
 * Match an inbound message to the contact's open NDR. Returns true when
 * the message was an NDR reply (the caller then skips the AI auto-reply).
 */
export async function handleNdrReply(
  db: SupabaseClient,
  input: {
    accountId: string;
    contactId: string;
    text: string | null;
    interactiveReplyId: string | null;
  }
): Promise<boolean> {
  try {
    const { accountId, contactId } = input;
    const { data, error } = await db
      .from('ndr_requests')
      .select('id, order_name, sent_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('state', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1);
    if (error) return false;
    const open = ((data as { id: string; order_name: string; sent_at: string }[] | null) ?? [])[0];
    if (!open) return false;

    const now = new Date();
    if (now.getTime() - Date.parse(open.sent_at) > NDR_EXPIRY_MS) {
      await db
        .from('ndr_requests')
        .update({ state: 'expired' })
        .eq('id', open.id)
        .eq('account_id', accountId)
        .eq('state', 'sent');
      return false;
    }

    const parsed = parseNdrAnswer(input.interactiveReplyId, input.text);
    const answer: NdrAnswer = parsed ?? 'other';
    const { data: updated, error: updateError } = await db
      .from('ndr_requests')
      .update({
        answer,
        answer_text: (input.text ?? input.interactiveReplyId ?? '').slice(0, 500) || null,
        replied_at: now.toISOString(),
        // A free-text reply stays open so a later "1" or "2" still counts.
        ...(parsed ? { state: 'answered' } : {}),
      })
      .eq('id', open.id)
      .eq('account_id', accountId)
      .eq('state', 'sent')
      .select('id');
    if (updateError || !updated || (updated as unknown[]).length === 0) return false;

    if (parsed) {
      try {
        await tagContact(
          db,
          accountId,
          contactId,
          parsed === 'reattempt' ? NDR_REATTEMPT_TAG : NDR_RESCHEDULE_TAG
        );
      } catch (err) {
        console.error('[ndr] tagging failed:', err);
      }
    }
    await dispatchWebhookEvent(db, accountId, 'ndr.reply', {
      order_number: open.order_name,
      contact_id: contactId,
      answer,
      text: excerpt(input.text),
    });
    return true;
  } catch (err) {
    console.error('[ndr] reply handling failed:', err);
    return false;
  }
}
