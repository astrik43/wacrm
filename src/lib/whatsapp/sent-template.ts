// ============================================================
// What a sent template looked like on the customer's phone, beyond
// its body: the header picture and the buttons, with every link as it
// was actually sent (the URL's {{1}} replaced by the send's value).
// Stored on the message row so the inbox can show the buttons and an
// agent can open the exact link the customer got.
//
// Kept in messages.interactive_payload (JSONB, already there for
// interactive messages): a template row never has an interactive
// payload of its own, and `kind: 'template'` tells the two apart.
// Pure — no server-only imports.
// ============================================================

import type { MessageTemplate, TemplateButton } from '@/types';

export interface SentTemplateButton {
  type: 'url' | 'phone' | 'quick_reply' | 'copy_code';
  text: string;
  /** url: the full link sent · phone: the number · copy_code: the code. */
  value?: string;
}

export interface SentTemplatePayload {
  kind: 'template';
  /** Public https picture/video/document of the header, when it had one. */
  header_media_url?: string;
  header_type?: 'image' | 'video' | 'document';
  buttons: SentTemplateButton[];
}

function sentButton(
  button: TemplateButton,
  override: string | undefined
): SentTemplateButton {
  switch (button.type) {
    case 'URL': {
      const url = button.url.includes('{{1}}')
        ? button.url.replace('{{1}}', override?.trim() ?? '')
        : button.url;
      return { type: 'url', text: button.text, value: url };
    }
    case 'PHONE_NUMBER':
      return { type: 'phone', text: button.text, value: button.phone_number };
    case 'COPY_CODE':
      return {
        type: 'copy_code',
        text: button.text,
        value: override?.trim() || button.example,
      };
    case 'QUICK_REPLY':
      return { type: 'quick_reply', text: button.text };
  }
}

/**
 * The header and buttons of a template send, or null when there is
 * nothing beyond the body worth keeping (or no local copy of the
 * template to read them from).
 */
export function sentTemplatePayload(
  row: MessageTemplate | null,
  messageParams: unknown
): SentTemplatePayload | null {
  if (!row) return null;
  const params =
    messageParams && typeof messageParams === 'object'
      ? (messageParams as {
          buttonParams?: Record<number, string>;
          headerMediaUrl?: string;
        })
      : {};

  const buttons = (row.buttons ?? []).map((button, i) =>
    sentButton(button, params.buttonParams?.[i])
  );

  const mediaType =
    row.header_type === 'image' ||
    row.header_type === 'video' ||
    row.header_type === 'document'
      ? row.header_type
      : undefined;
  const mediaUrl = mediaType
    ? params.headerMediaUrl || row.header_media_url || undefined
    : undefined;
  const header =
    mediaType && mediaUrl && /^https:\/\//i.test(mediaUrl)
      ? { header_type: mediaType, header_media_url: mediaUrl }
      : {};

  if (buttons.length === 0 && !header.header_media_url) return null;
  return { kind: 'template', ...header, buttons };
}

/** The stored payload of a template message, if it has one. */
export function readSentTemplatePayload(
  value: unknown
): SentTemplatePayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<SentTemplatePayload>;
  if (payload.kind !== 'template' || !Array.isArray(payload.buttons)) {
    return null;
  }
  return payload as SentTemplatePayload;
}
