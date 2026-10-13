// ============================================================
// /api/shopify/events
//
//   GET — the six order updates with their switch, template and
//         variable mapping (defaults for ones never configured).
//   PUT — save one update's settings (admin+).
//
// An update can only be switched ON with an APPROVED template whose
// every placeholder is mapped — otherwise each order would be logged
// as skipped and the merchant would find out from a customer.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { SHOPIFY_EVENTS, isShopifyEvent } from '@/lib/shopify/events';
import {
  parseVariableMapping,
  validateVariableMapping,
} from '@/lib/shopify/variable-mapping';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

const COLUMNS =
  'event, is_enabled, template_name, template_language, variable_mapping, updated_at';

interface EventRow {
  event: string;
  is_enabled: boolean;
  template_name: string | null;
  template_language: string | null;
  variable_mapping: unknown;
  updated_at: string | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('shopify_event_templates')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId);
    if (error) {
      console.error('[GET /api/shopify/events] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load order updates' },
        { status: 500 }
      );
    }

    const byEvent = new Map(
      ((data as EventRow[] | null) ?? []).map((row) => [row.event, row])
    );
    const events = SHOPIFY_EVENTS.map((event) => {
      const row = byEvent.get(event);
      return {
        event,
        is_enabled: row?.is_enabled ?? false,
        template_name: row?.template_name ?? null,
        template_language: row?.template_language ?? null,
        variable_mapping: parseVariableMapping(row?.variable_mapping) ?? {
          body: [],
        },
        updated_at: row?.updated_at ?? null,
      };
    });

    return NextResponse.json({ events });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyEvent:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      event?: unknown;
      is_enabled?: unknown;
      template_name?: unknown;
      template_language?: unknown;
      variable_mapping?: unknown;
    } | null;

    if (!isShopifyEvent(body?.event)) {
      return NextResponse.json(
        { error: "'event' must be one of the six order updates" },
        { status: 400 }
      );
    }
    const event = body.event;
    const isEnabled = body.is_enabled === true;
    const templateName =
      typeof body.template_name === 'string' && body.template_name.trim()
        ? body.template_name.trim()
        : null;
    const templateLanguage =
      typeof body.template_language === 'string' && body.template_language.trim()
        ? body.template_language.trim()
        : null;

    const mapping = parseVariableMapping(body.variable_mapping);
    if (!mapping) {
      return NextResponse.json(
        { error: "'variable_mapping' has an invalid shape" },
        { status: 400 }
      );
    }

    if (isEnabled && !templateName) {
      return NextResponse.json(
        { error: 'Choose a template before switching this update on' },
        { status: 400 }
      );
    }

    if (templateName) {
      const resolved = await resolveTemplateRow(
        ctx.supabase,
        ctx.accountId,
        templateName,
        templateLanguage
      );
      if (!resolved.row) {
        return NextResponse.json(
          { error: 'Template not found. Sync templates from Meta and retry.' },
          { status: 400 }
        );
      }
      if (resolved.row.status !== 'APPROVED') {
        return NextResponse.json(
          { error: 'Only templates approved by Meta can be used' },
          { status: 400 }
        );
      }
      const problems = validateVariableMapping(resolved.row, mapping, event);
      if (problems.length > 0) {
        return NextResponse.json(
          {
            error: 'Every placeholder in the template needs a value',
            problems,
          },
          { status: 400 }
        );
      }
    }

    const { data, error } = await ctx.supabase
      .from('shopify_event_templates')
      .upsert(
        {
          account_id: ctx.accountId,
          event,
          is_enabled: isEnabled,
          template_name: templateName,
          template_language: templateLanguage,
          // Dense array: JSON would turn holes into nulls anyway.
          variable_mapping: {
            ...mapping,
            body: Array.from(mapping.body, (s) => s ?? null),
          },
        },
        { onConflict: 'account_id,event' }
      )
      .select(COLUMNS)
      .single();
    if (error || !data) {
      console.error('[PUT /api/shopify/events] upsert error:', error);
      return NextResponse.json(
        { error: 'Failed to save this update' },
        { status: 500 }
      );
    }

    return NextResponse.json({ event: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
