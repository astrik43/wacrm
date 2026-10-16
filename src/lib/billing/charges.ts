// ============================================================
// WhatsApp message charges — what Meta bills per message, for the
// Transaction Details page.
//
// Meta's status webhooks (sent / delivered / read / failed) carry a
// `pricing` object per message:
//
//   { billable: true, pricing_model: "PMP",
//     category: "utility", type: "regular" }
//
// recordMessageStatus() folds each status into message_charges
// (migration 050). The amount shown is an estimate from Meta's India
// rate card below: Meta bills the account in its own currency and
// publishes the official totals in WhatsApp Manager.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** Meta's India per-message rates (INR, before 18% GST). */
export const INR_RATES: Readonly<Record<string, number>> = {
  marketing: 0.8631,
  marketing_lite: 0.8631,
  utility: 0.115,
  authentication: 0.115,
  authentication_international: 0.115,
  service: 0,
  referral_conversion: 0,
};

export const GST_RATE = 0.18;

export const CHARGE_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export function isChargeStatus(value: unknown): value is ChargeStatus {
  return (
    typeof value === 'string' &&
    (CHARGE_STATUSES as readonly string[]).includes(value)
  );
}

export interface StatusPricing {
  category: string | null;
  type: string | null;
  billable: boolean | null;
}

function lowerOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

/** The pricing a status webhook carries, normalised; nulls when absent. */
export function parseStatusPricing(pricing: unknown): StatusPricing {
  const p =
    pricing && typeof pricing === 'object' && !Array.isArray(pricing)
      ? (pricing as Record<string, unknown>)
      : {};
  return {
    category: lowerOrNull(p.category),
    type: lowerOrNull(p.type),
    billable: typeof p.billable === 'boolean' ? p.billable : null,
  };
}

/**
 * Estimated cost of one message in INR, before GST. Meta only charges
 * a billable message once it is delivered; failed and free messages
 * (service replies, free entry points) cost nothing.
 */
export function estimateChargeInr(row: {
  status: string;
  pricing_category: string | null;
  billable: boolean | null;
}): number {
  if (!row.billable) return 0;
  if (row.status !== 'delivered' && row.status !== 'read') return 0;
  return INR_RATES[row.pricing_category ?? ''] ?? 0;
}

export interface StatusUpdate {
  id: string;
  status: string;
  timestamp: string;
  recipient_id?: string;
  pricing?: unknown;
  errors?: { code: number; title: string }[];
}

/**
 * Record one status webhook for an account's message. Never throws:
 * the ledger must not break status handling for the inbox.
 */
export async function recordMessageStatus(
  db: SupabaseClient,
  accountId: string,
  status: StatusUpdate
): Promise<void> {
  if (!isChargeStatus(status.status)) return;
  const seconds = Number(status.timestamp);
  const at = Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
  const pricing = parseStatusPricing(status.pricing);
  const error = status.status === 'failed' ? status.errors?.[0] : undefined;
  try {
    const { error: rpcError } = await db.rpc('record_message_status', {
      p_account_id: accountId,
      p_message_id: status.id,
      p_recipient: status.recipient_id ?? null,
      p_status: status.status,
      p_at: at,
      p_category: pricing.category,
      p_pricing_type: pricing.type,
      p_billable: pricing.billable,
      p_error_code: error?.code ?? null,
      p_error_title: error?.title ?? null,
    });
    if (rpcError) {
      console.error('[billing] record_message_status failed:', rpcError.message);
    }
  } catch (err) {
    console.error('[billing] record_message_status threw:', err);
  }
}
