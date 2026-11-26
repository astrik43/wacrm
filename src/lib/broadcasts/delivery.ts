// ============================================================
// Server-side delivery plumbing for the MCP broadcast tools.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import {
  deliverBroadcast,
  finalizeBroadcastStatus,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';
import { releaseBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import {
  isRecipientNotAllowedError,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import type { MessageTemplate } from '@/types';

/**
 * Fan a claimed, planned broadcast out to Meta and release the delivery
 * lock when done. Runs in `after()` so the tool call returns quickly;
 * outside a request scope (or in tests) `after` is unavailable and the
 * work runs inline instead.
 */
export async function runBroadcastDelivery(
  db: SupabaseClient,
  plan: BroadcastPlan,
): Promise<{ deferred: boolean }> {
  const work = async () => {
    try {
      await deliverBroadcast(db, plan);
    } catch (err) {
      console.error(
        '[mcp-broadcast] delivery threw:',
        err instanceof Error ? err.message : err,
      );
      // Don't leave it mid-flight: settle whatever did land.
      await finalizeBroadcastStatus(db, plan.broadcastId).catch(() => {});
    } finally {
      await releaseBroadcastDelivery(db, plan.broadcastId);
    }
  };
  try {
    after(work);
    return { deferred: true };
  } catch {
    await work();
    return { deferred: false };
  }
}

export interface SingleSendArgs {
  db: SupabaseClient;
  accountId: string;
  phone: string;
  template: MessageTemplate;
  templateName: string;
  language: string;
  params: string[];
  messageParams?: SendTimeParams;
}

/**
 * Send one template message to one (already validated) phone, with the
 * same phone-variant retry the broadcast fan-out uses. Records nothing.
 * Returns the Meta message id or throws the Meta error message.
 */
export async function sendSingleTemplate(args: SingleSendArgs): Promise<string> {
  const { data: config } = await args.db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!config) {
    throw new Error('WhatsApp is not configured for this account.');
  }
  const accessToken = decrypt(config.access_token as string);

  let lastError = 'Unknown error';
  for (const variant of phoneVariants(args.phone)) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id as string,
        accessToken,
        to: variant,
        templateName: args.templateName,
        language: args.language,
        template: args.template,
        params: args.params,
        messageParams: args.messageParams,
      });
      return result.messageId;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
      if (!isRecipientNotAllowedError(lastError)) break;
    }
  }
  throw new Error(lastError);
}
