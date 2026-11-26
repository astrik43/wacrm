// ============================================================
// Turn caller-supplied template values (body variables, header text /
// media, URL-button suffixes, coupon codes) into the structured
// `SendTimeParams` the send core takes, validate them against the
// template row, and render both the human-readable message and the
// exact Meta `template` payload. Used by the MCP `send_template` and
// `preview_template` tools; the actual Meta call still goes through
// `sendTemplateMessage` → `buildSendComponents`, so what is previewed is
// what is sent.
// ============================================================

import type { MessageTemplate } from '@/types';

import { renderTemplateBody } from './template-body';
import {
  buildSendComponents,
  type MetaSendComponent,
  type SendTimeParams,
} from './template-send-builder';
import { extractVariableIndices } from './template-validators';

export class TemplateSendInputError extends Error {
  readonly code: 'button_param_missing' | 'invalid_input';
  readonly field?: string;
  constructor(code: 'button_param_missing' | 'invalid_input', message: string, field?: string) {
    super(message);
    this.name = 'TemplateSendInputError';
    this.code = code;
    this.field = field;
  }
}

export interface TemplateSendInput {
  body_params?: string[];
  header_text?: string;
  header_media_url?: string;
  /** Keyed by the button's index in the template's `buttons` array (as a string). */
  button_params?: Record<string, string>;
}

export interface PreparedTemplateSend {
  messageParams: SendTimeParams;
  components: MetaSendComponent[];
  /** The `template` object of Meta's /messages body (recipient omitted). */
  metaTemplate: {
    name: string;
    language: { code: string };
    components?: MetaSendComponent[];
  };
  rendered: {
    header: string | null;
    body: string;
    footer: string | null;
    buttons: { index: number; type: string; text: string; url?: string; code?: string }[];
  };
}

function substituteContact(value: string, contact?: { name?: string | null }): string {
  if (!contact) return value;
  const name = (contact.name ?? '').trim();
  const first = name.split(/\s+/)[0] ?? '';
  return value
    .replace(/\{\{contact\.name\}\}/g, name)
    .replace(/\{\{contact\.first_name\}\}/g, first);
}

export function prepareTemplateSend(
  template: MessageTemplate,
  input: TemplateSendInput,
  opts: {
    language: string;
    /** Fall back to the template's sample values for anything not supplied (previews). */
    useSamples?: boolean;
    contact?: { name?: string | null };
  }
): PreparedTemplateSend {
  const { contact, useSamples } = opts;
  const buttons = template.buttons ?? [];

  // Button values, keyed by index.
  const buttonParams: Record<number, string> = {};
  for (const [key, raw] of Object.entries(input.button_params ?? {})) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= buttons.length) {
      throw new TemplateSendInputError(
        'invalid_input',
        `button_params key "${key}" does not match a button (this template has ${buttons.length}, indexed from 0).`,
        `button_params.${key}`
      );
    }
    buttonParams[idx] = substituteContact(raw, contact);
  }
  buttons.forEach((b, i) => {
    if (b.type !== 'URL') return;
    const needs = extractVariableIndices(b.url).length > 0;
    if (!needs || buttonParams[i]?.trim()) return;
    if (useSamples && b.example) {
      buttonParams[i] = b.example;
      return;
    }
    throw new TemplateSendInputError(
      'button_param_missing',
      `URL button #${i} ("${b.text}") has a variable in its link and needs a value: pass button_params {"${i}": "<value>"}.`,
      `button_params.${i}`
    );
  });

  // Body.
  const varCount = extractVariableIndices(template.body_text).length;
  let body = (input.body_params ?? []).map((v) => substituteContact(String(v), contact));
  if (body.length === 0 && useSamples) body = template.sample_values?.body ?? [];
  if (body.length < varCount) {
    throw new TemplateSendInputError(
      'invalid_input',
      `The body has ${varCount} variable(s) but ${body.length} value(s) were given: pass body_params with ${varCount} string(s).`,
      'body_params'
    );
  }

  // Header.
  let headerText = input.header_text
    ? substituteContact(input.header_text, contact)
    : undefined;
  if (!headerText && useSamples) headerText = template.sample_values?.header?.[0];

  const messageParams: SendTimeParams = { body };
  if (headerText) messageParams.headerText = headerText;
  if (input.header_media_url) messageParams.headerMediaUrl = input.header_media_url;
  if (Object.keys(buttonParams).length > 0) messageParams.buttonParams = buttonParams;

  let components: MetaSendComponent[];
  try {
    components = buildSendComponents(template, messageParams);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid template values.';
    const field = /header text/i.test(message)
      ? 'header_text'
      : /header requires|media/i.test(message)
        ? 'header_media_url'
        : undefined;
    throw new TemplateSendInputError('invalid_input', message, field);
  }

  const renderedHeader =
    template.header_type === 'text' && template.header_content
      ? renderTemplateBody(template.header_content, headerText ? [headerText] : [])
      : template.header_type
        ? `[${template.header_type} header]`
        : null;

  return {
    messageParams,
    components,
    metaTemplate: {
      name: template.name,
      language: { code: opts.language },
      ...(components.length > 0 ? { components } : {}),
    },
    rendered: {
      header: renderedHeader,
      body: renderTemplateBody(template.body_text, body),
      footer: template.footer_text ?? null,
      buttons: buttons.map((b, i) => ({
        index: i,
        type: b.type,
        text: b.text,
        ...(b.type === 'URL'
          ? { url: b.url.replace(/\{\{1\}\}/g, buttonParams[i] ?? '{{1}}') }
          : {}),
        ...(b.type === 'COPY_CODE' ? { code: buttonParams[i]?.trim() || b.example } : {}),
      })),
    },
  };
}
