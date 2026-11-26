/**
 * The per-recipient send values a dashboard broadcast freezes on each
 * `broadcast_recipients.template_params` row (migration 038), so the
 * browser pass and any later server-side resume send the same message.
 *
 * Two shapes live in that JSONB column:
 *
 *   - `string[]` — body values only. Every row written before button
 *     parameters were supported.
 *   - `{ body, buttonParams?, headerMediaUrl? }` — rows for templates
 *     that also need a URL-button suffix, a coupon code or a header
 *     media link at send time.
 *
 * Readers go through {@link parseRecipientParams} so both keep working.
 */

import type { SendTimeParams } from './template-send-builder';

export interface StoredRecipientParams {
  body: string[];
  /** Keyed by the button's index in the template's `buttons` array. */
  buttonParams?: Record<number, string>;
  headerMediaUrl?: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/** What to store: the plain array when only body values are needed. */
export function toStoredRecipientParams(
  stored: StoredRecipientParams
): string[] | StoredRecipientParams {
  const hasButtons =
    stored.buttonParams && Object.keys(stored.buttonParams).length > 0;
  if (!hasButtons && !stored.headerMediaUrl) return stored.body;
  return stored;
}

/**
 * Read a stored row back into the `params` / `messageParams` pair
 * `sendTemplateMessage` takes. `messageParams` is only set for the
 * structured shape.
 */
export function parseRecipientParams(raw: unknown): {
  params: string[];
  messageParams?: SendTimeParams;
} {
  if (Array.isArray(raw)) return { params: strings(raw) };
  if (!raw || typeof raw !== 'object') return { params: [] };

  const obj = raw as Record<string, unknown>;
  const body = strings(obj.body);
  const messageParams: SendTimeParams = { body };

  if (obj.buttonParams && typeof obj.buttonParams === 'object') {
    const buttonParams: Record<number, string> = {};
    for (const [key, value] of Object.entries(obj.buttonParams)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && typeof value === 'string') {
        buttonParams[index] = value;
      }
    }
    if (Object.keys(buttonParams).length > 0) {
      messageParams.buttonParams = buttonParams;
    }
  }
  if (typeof obj.headerMediaUrl === 'string' && obj.headerMediaUrl) {
    messageParams.headerMediaUrl = obj.headerMediaUrl;
  }
  return { params: body, messageParams };
}
