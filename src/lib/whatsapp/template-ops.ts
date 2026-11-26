// ============================================================
// Template lifecycle operations — submit, sync, delete.
//
// Extracted from the /api/whatsapp/templates/* routes so the dashboard
// routes and the MCP tools run the same code. Callers own auth (role
// check / API-key scope) and the response shape; these functions take a
// Supabase client + accountId (every query is account-filtered, so they
// are safe with either an RLS client or the service-role client) and
// throw `TemplateOpError` with the HTTP status the route used to return.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  deleteMessageTemplate,
  describeMetaError,
  submitMessageTemplate,
  templateBelongsToWaba,
} from '@/lib/whatsapp/meta-api';
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureMediaHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import type { TemplateButton, TemplateSampleValues } from '@/types';

export class TemplateOpError extends Error {
  readonly status: number;
  /** Extra fields the route echoes in its JSON error body. */
  readonly extra?: Record<string, unknown>;
  constructor(message: string, status: number, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'TemplateOpError';
    this.status = status;
    this.extra = extra;
  }
}

export function templatesDryRunEnv(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

// ------------------------------------------------------------
// Submit
// ------------------------------------------------------------

function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string;
    metaTemplateId: string | null;
    submissionError: string | null;
  }
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // Original author — kept as audit only.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  };
}

async function upsertTemplateRow(
  db: SupabaseClient,
  row: ReturnType<typeof buildUpsertRow>
) {
  // TODO(account-sharing): conflict target is still scoped to
  // user_id. Once a follow-up migration drops the legacy unique
  // index on (user_id, name, language) and adds (account_id,
  // name, language), switch `onConflict` here so two teammates
  // can't shadow each other's same-named template.
  return db
    .from('message_templates')
    .upsert(row, { onConflict: 'user_id,name,language' })
    .select()
    .single();
}

/**
 * Validate a submission payload without touching Meta or the DB.
 * Throws TemplateOpError(400) — used by the submit path and by MCP dry runs.
 */
export function validateSubmission(payload: TemplatePayload): void {
  if (payload.category === 'Authentication') {
    throw new TemplateOpError(
      'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
      400
    );
  }
  try {
    validateTemplatePayload(payload);
  } catch (e) {
    throw new TemplateOpError(
      e instanceof Error ? e.message : 'Validation failed.',
      400
    );
  }
}

/** The exact payload POSTed to Meta's /message_templates for this submission. */
export function previewMetaSubmission(payload: TemplatePayload) {
  return buildMetaTemplatePayload(payload);
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 * Validate → (WHATSAPP_TEMPLATES_DRY_RUN short-circuit) → POST to Meta →
 * upsert local row by (user_id, name, language).
 */
export async function submitTemplate(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  payload: TemplatePayload
): Promise<{ template: unknown; dry_run: boolean }> {
  validateSubmission(payload);

  const dryRun = templatesDryRunEnv();
  let metaTemplateId: string;
  let metaStatus: string;

  if (dryRun) {
    metaTemplateId = `dry-run-${crypto.randomUUID()}`;
    metaStatus = 'PENDING';
  } else {
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();
    if (configError || !config) {
      throw new TemplateOpError(
        'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        400
      );
    }
    if (!config.waba_id) {
      throw new TemplateOpError(
        'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        400
      );
    }

    const accessToken = decrypt(config.access_token);

    // Media headers need a Resumable-Upload handle (Meta rejects a plain
    // URL at creation); derive it from header_media_url.
    try {
      await ensureMediaHeaderHandle(payload, accessToken);
    } catch (e) {
      throw new TemplateOpError(
        e instanceof Error ? e.message : 'Header media upload failed.',
        400
      );
    }

    const metaPayload = buildMetaTemplatePayload(payload);
    try {
      const meta = await submitMessageTemplate({
        wabaId: config.waba_id,
        accessToken,
        payload: metaPayload,
      });
      metaTemplateId = meta.id;
      metaStatus = meta.status;
    } catch (e) {
      const message = describeMetaError(e, 'Meta submit failed.');
      // Persist the failure so the user can retry; row stays DRAFT.
      await upsertTemplateRow(
        db,
        buildUpsertRow(accountId, userId, payload, {
          status: 'DRAFT',
          metaTemplateId: null,
          submissionError: message,
        })
      );
      const isRateLimit = /\b429\b/.test(message);
      throw new TemplateOpError(
        isRateLimit
          ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
          : message,
        isRateLimit ? 429 : 502
      );
    }
  }

  const { data: row, error: upsertErr } = await upsertTemplateRow(
    db,
    buildUpsertRow(accountId, userId, payload, {
      status: normalizeStatus(metaStatus),
      metaTemplateId,
      submissionError: null,
    })
  );

  if (upsertErr) {
    // The submit succeeded on Meta's side but we failed to persist
    // locally — surface the meta_template_id so the user can recover.
    throw new TemplateOpError(
      `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
      500,
      { meta_template_id: metaTemplateId }
    );
  }

  return { template: row, dry_run: dryRun };
}

// ------------------------------------------------------------
// Sync
// ------------------------------------------------------------

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaButton {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaButton[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponent[];
  quality_score?: { score?: string } | string;
}

function normalizeCategory(
  meta: string
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase();
  if (upper === 'UTILITY') return 'Utility';
  if (upper === 'AUTHENTICATION') return 'Authentication';
  return 'Marketing';
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score']
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null;
  if (!score) return null;
  const upper = score.toUpperCase();
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null;
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return [];
  const out: TemplateButton[] = [];
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text });
        break;
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        });
        break;
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        });
        break;
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? (b.example[0] ?? '') : (b.example ?? ''),
        });
        break;
      // OTP, FLOW, etc — out of scope for v1; drop silently.
    }
  }
  return out;
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  // We take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0];
  const headerSample = header?.example?.header_text;
  if (!bodySample?.length && !headerSample?.length) return null;
  const sv: TemplateSampleValues = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

export interface SyncTemplatesResult {
  success: boolean;
  total: number;
  inserted: number;
  updated: number;
  removed: number;
  errors: { name: string; language: string; message: string }[];
  truncated: boolean;
}

/**
 * Sync message templates from Meta → local message_templates table.
 * Rows whose Meta template is no longer on the connected WABA are
 * removed; locally-created drafts (no meta_template_id) are kept.
 */
export async function syncTemplatesFromMeta(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<SyncTemplatesResult> {
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new TemplateOpError(
      'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
      400
    );
  }
  if (!config.waba_id) {
    throw new TemplateOpError(
      'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
      400
    );
  }

  const accessToken = decrypt(config.access_token);

  const metaTemplates: MetaTemplate[] = [];
  let nextUrl: string | null = `${META_API_BASE}/${config.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`;
  const PAGE_CAP = 20;
  let pageCount = 0;

  while (nextUrl && pageCount < PAGE_CAP) {
    pageCount++;
    const metaRes: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metaRes.ok) {
      let metaErr = `Meta API error: ${metaRes.status}`;
      try {
        const body = await metaRes.json();
        if (body?.error?.message) metaErr = body.error.message;
      } catch {
        // response wasn't JSON — keep the fallback
      }
      throw new TemplateOpError(metaErr, 502);
    }

    const metaBody: {
      data?: MetaTemplate[];
      paging?: { next?: string };
    } = await metaRes.json();
    if (metaBody.data) metaTemplates.push(...metaBody.data);
    nextUrl = metaBody.paging?.next ?? null;
  }

  let inserted = 0;
  let updated = 0;
  const errors: SyncTemplatesResult['errors'] = [];

  for (const t of metaTemplates) {
    const body = (t.components ?? []).find((c) => c.type === 'BODY');
    const header = (t.components ?? []).find((c) => c.type === 'HEADER');
    const footer = (t.components ?? []).find((c) => c.type === 'FOOTER');
    const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS');

    const parsedButtons = parseButtons(buttons?.buttons);
    const sampleValues = extractSampleValues(body, header);

    const headerFormat = header?.format?.toUpperCase();
    const headerType =
      headerFormat === 'TEXT' ||
      headerFormat === 'IMAGE' ||
      headerFormat === 'VIDEO' ||
      headerFormat === 'DOCUMENT'
        ? headerFormat.toLowerCase()
        : null;

    const row = {
      account_id: accountId,
      user_id: userId,
      name: t.name,
      category: normalizeCategory(t.category),
      language: t.language,
      header_type: headerType,
      header_content: header?.text ?? null,
      header_handle: header?.example?.header_handle?.[0] ?? null,
      body_text: body?.text ?? '',
      footer_text: footer?.text ?? null,
      buttons: parsedButtons.length ? parsedButtons : null,
      sample_values: sampleValues,
      status: normalizeStatus(t.status),
      meta_template_id: t.id,
      quality_score: normalizeQualityScore(t.quality_score),
      updated_at: new Date().toISOString(),
    };

    const { data: existing, error: lookupErr } = await db
      .from('message_templates')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', t.name)
      .eq('language', t.language)
      .maybeSingle();

    if (lookupErr) {
      errors.push({ name: t.name, language: t.language, message: lookupErr.message });
      continue;
    }

    if (existing?.id) {
      const { error: updErr } = await db
        .from('message_templates')
        .update(row)
        .eq('id', existing.id);
      if (updErr) {
        errors.push({ name: t.name, language: t.language, message: updErr.message });
      } else {
        updated++;
      }
    } else {
      const { error: insErr } = await db.from('message_templates').insert(row);
      if (insErr) {
        errors.push({ name: t.name, language: t.language, message: insErr.message });
      } else {
        inserted++;
      }
    }
  }

  // Rows whose Meta template isn't on the connected WABA any more.
  // Only prune off a complete listing; a truncated one would make
  // every template past the cap look stale.
  const truncated = pageCount >= PAGE_CAP && nextUrl !== null;
  let removed = 0;
  if (!truncated) {
    const onMeta = new Set(metaTemplates.map((t) => t.id));
    const { data: local, error: localErr } = await db
      .from('message_templates')
      .select('id, meta_template_id')
      .eq('account_id', accountId)
      .not('meta_template_id', 'is', null);
    if (localErr) {
      errors.push({ name: '*', language: '*', message: localErr.message });
    } else {
      const stale = ((local ?? []) as { id: string; meta_template_id: string }[])
        .filter((r) => !onMeta.has(r.meta_template_id))
        .map((r) => r.id);
      for (let i = 0; i < stale.length; i += 100) {
        const chunk = stale.slice(i, i + 100);
        const { error: delErr } = await db
          .from('message_templates')
          .delete()
          .in('id', chunk);
        if (delErr) {
          errors.push({ name: '*', language: '*', message: delErr.message });
          break;
        }
        removed += chunk.length;
      }
    }
  }

  return {
    success: errors.length === 0,
    total: metaTemplates.length,
    inserted,
    updated,
    removed,
    errors,
    truncated,
  };
}

// ------------------------------------------------------------
// Delete
// ------------------------------------------------------------

/**
 * Remove a template on Meta (when it was submitted, scoped to one
 * language variant) AND drop the local row. Local-only rows, and rows
 * from a previously connected WABA, skip the Meta call.
 */
export async function deleteTemplate(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<{ dry_run: boolean }> {
  const { data: existing, error: lookupErr } = await db
    .from('message_templates')
    .select('id, name, meta_template_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (lookupErr || !existing) {
    throw new TemplateOpError('Template not found.', 404);
  }

  const dryRun = templatesDryRunEnv();
  if (existing.meta_template_id && !dryRun) {
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();
    if (configError || !config || !config.waba_id) {
      throw new TemplateOpError(
        'WhatsApp not configured — cannot delete on Meta.',
        400
      );
    }
    const accessToken = decrypt(config.access_token);
    // A row left over from a previously connected WABA isn't on this
    // one, and Meta rejects deleting it here — just drop it locally.
    const onThisWaba = await templateBelongsToWaba({
      wabaId: config.waba_id,
      accessToken,
      name: existing.name,
      metaTemplateId: existing.meta_template_id,
    });
    if (onThisWaba !== false) {
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        });
      } catch (e) {
        throw new TemplateOpError(
          e instanceof Error ? e.message : 'Meta delete failed.',
          502
        );
      }
    }
  }

  const { error: delErr } = await db
    .from('message_templates')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId);
  if (delErr) {
    throw new TemplateOpError(
      `Deleted on Meta but failed to delete locally: ${delErr.message}.`,
      500
    );
  }
  return { dry_run: dryRun };
}
