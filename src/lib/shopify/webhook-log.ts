// ============================================================
// Shopify webhook log (server-only).
//
// Records each delivery in `shopify_webhook_events` for the debugging
// table in Settings → Shopify. Logging is strictly best-effort: a
// failure to write the log is reported to the server log and never
// affects how the delivery is handled.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ProcessOutcome } from './process';

export type WebhookEventStatus =
  | 'received'
  | 'processed'
  | 'ignored'
  | 'rejected'
  | 'error';

export interface WebhookEventInput {
  account_id: string;
  topic: string | null;
  shopify_webhook_id: string | null;
  shop_domain: string | null;
  status: WebhookEventStatus;
  detail?: string | null;
  order_ref?: string | null;
  payload?: unknown;
}

export interface WebhookEventPatch {
  status: WebhookEventStatus;
  detail?: string | null;
  order_ref?: string | null;
  outcome?: ProcessOutcome[];
}

export const WEBHOOK_LOG_RETENTION_DAYS = 30;
// Order payloads are a few KB; anything this large is not worth
// keeping verbatim in a debugging table.
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_DETAIL_LEN = 500;

function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > MAX_DETAIL_LEN ? value.slice(0, MAX_DETAIL_LEN) : value;
}

/** Best-effort order label from an order or fulfillment payload. */
export function orderRefOf(payload: unknown): string | null {
  const name = (payload as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * Insert a log row and prune this account's expired ones. Returns the
 * row id (to update once processing finishes), or `null` if the write
 * failed.
 */
export async function recordWebhookEvent(
  db: SupabaseClient,
  input: WebhookEventInput
): Promise<string | null> {
  try {
    let payload: unknown = input.payload ?? null;
    let detail = input.detail ?? null;
    if (payload !== null && JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
      payload = null;
      detail = detail ?? 'payload_too_large_to_store';
    }

    const { data, error } = await db
      .from('shopify_webhook_events')
      .insert({
        account_id: input.account_id,
        topic: clip(input.topic),
        shopify_webhook_id: clip(input.shopify_webhook_id),
        shop_domain: clip(input.shop_domain),
        status: input.status,
        detail: clip(detail),
        order_ref: clip(input.order_ref),
        payload,
      })
      .select('id')
      .single();
    if (error) {
      console.error('[shopify] webhook log insert failed:', error.message);
      return null;
    }

    const cutoff = new Date(
      Date.now() - WEBHOOK_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const { error: pruneErr } = await db
      .from('shopify_webhook_events')
      .delete()
      .eq('account_id', input.account_id)
      .lt('received_at', cutoff);
    if (pruneErr) {
      console.error('[shopify] webhook log prune failed:', pruneErr.message);
    }

    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.error('[shopify] webhook log insert threw:', err);
    return null;
  }
}

/** Record how a logged delivery ended. No-op when the insert failed. */
export async function finishWebhookEvent(
  db: SupabaseClient,
  id: string | null,
  patch: WebhookEventPatch
): Promise<void> {
  if (!id) return;
  try {
    const update: Record<string, unknown> = {
      status: patch.status,
      detail: clip(patch.detail),
    };
    if (patch.order_ref) update.order_ref = clip(patch.order_ref);
    if (patch.outcome) update.outcome = patch.outcome;
    const { error } = await db
      .from('shopify_webhook_events')
      .update(update)
      .eq('id', id);
    if (error) {
      console.error('[shopify] webhook log update failed:', error.message);
    }
  } catch (err) {
    console.error('[shopify] webhook log update threw:', err);
  }
}
