// ============================================================
// /api/shopify/events
//
//   GET    — every update with its switch, template, delay and
//            variable mapping (defaults for ones never configured).
//            Order and shipment updates come once per payment variant
//            (all orders, COD, prepaid); cart reminders only as "all".
//            Each variant has its first message (step 0) and any
//            follow-up messages saved for it (steps 1..4).
//   PUT    — save one message of one update and variant (admin+).
//   DELETE — remove a follow-up message (admin+). Sends already
//            waiting for it are cancelled by the cron.
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
import {
  MAX_DELAY_MINUTES,
  MIN_CART_DELAY_MINUTES,
  MAX_FOLLOW_UPS,
  SHOPIFY_EVENTS,
  isCartEvent,
  isShopifyEvent,
  isStep,
  isShopifyVariant,
  variantsForEvent,
} from '@/lib/shopify/events';
import {
  parseVariableMapping,
  validateVariableMapping,
} from '@/lib/shopify/variable-mapping';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

const COLUMNS =
  'event, variant, step, is_enabled, template_name, template_language, variable_mapping, delay_minutes, updated_at';

interface EventRow {
  event: string;
  variant: string;
  step: number | null;
  delay_minutes: number | null;
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

    const rows = (data as EventRow[] | null) ?? [];
    const events = SHOPIFY_EVENTS.flatMap((event) =>
      variantsForEvent(event).flatMap((variant) => {
        const saved = rows.filter(
          (r) => r.event === event && r.variant === variant
        );
        // The first message always shows, configured or not; follow-ups
        // only once saved.
        const steps = new Set([0, ...saved.map((r) => r.step ?? 0)]);
        return [...steps]
          .sort((a, b) => a - b)
          .map((step) => {
            const row = saved.find((r) => (r.step ?? 0) === step);
            return {
              event,
              variant,
              step,
              is_enabled: row?.is_enabled ?? false,
              template_name: row?.template_name ?? null,
              template_language: row?.template_language ?? null,
              variable_mapping: parseVariableMapping(row?.variable_mapping) ?? {
                body: [],
              },
              delay_minutes: row?.delay_minutes ?? 0,
              updated_at: row?.updated_at ?? null,
            };
          });
      })
    );

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
      variant?: unknown;
      step?: unknown;
      delay_minutes?: unknown;
      is_enabled?: unknown;
      template_name?: unknown;
      template_language?: unknown;
      variable_mapping?: unknown;
    } | null;

    if (!isShopifyEvent(body?.event)) {
      return NextResponse.json(
        { error: "'event' must be one of the Shopify updates" },
        { status: 400 }
      );
    }
    const event = body.event;

    const variant = body.variant === undefined ? 'all' : body.variant;
    if (!isShopifyVariant(variant) || !variantsForEvent(event).includes(variant)) {
      return NextResponse.json(
        { error: "'variant' is not available for this update" },
        { status: 400 }
      );
    }

    const step = body.step === undefined ? 0 : body.step;
    if (!isStep(step)) {
      return NextResponse.json(
        { error: `'step' must be a whole number from 0 to ${MAX_FOLLOW_UPS}` },
        { status: 400 }
      );
    }

    const delayMinutes =
      body.delay_minutes === undefined ? 0 : body.delay_minutes;
    if (
      typeof delayMinutes !== 'number' ||
      !Number.isInteger(delayMinutes) ||
      delayMinutes < 0 ||
      delayMinutes > MAX_DELAY_MINUTES
    ) {
      return NextResponse.json(
        {
          error: `'delay_minutes' must be a whole number from 0 to ${MAX_DELAY_MINUTES}`,
        },
        { status: 400 }
      );
    }
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

    if (isEnabled && isCartEvent(event) && delayMinutes < MIN_CART_DELAY_MINUTES) {
      return NextResponse.json(
        {
          error: `A cart reminder needs a delay of at least ${MIN_CART_DELAY_MINUTES} minutes`,
        },
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
          variant,
          step,
          delay_minutes: delayMinutes,
          is_enabled: isEnabled,
          template_name: templateName,
          template_language: templateLanguage,
          // Dense array: JSON would turn holes into nulls anyway.
          variable_mapping: {
            ...mapping,
            body: Array.from(mapping.body, (s) => s ?? null),
          },
        },
        { onConflict: 'account_id,event,variant,step' }
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

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyEvent:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const params = new URL(request.url).searchParams;
    const event = params.get('event');
    const variant = params.get('variant') ?? 'all';
    const step = Number(params.get('step'));
    if (
      !isShopifyEvent(event) ||
      !isShopifyVariant(variant) ||
      !variantsForEvent(event).includes(variant)
    ) {
      return NextResponse.json(
        { error: "'event' and 'variant' must name a Shopify update" },
        { status: 400 }
      );
    }
    // The first message is switched off, not removed.
    if (!isStep(step) || step === 0) {
      return NextResponse.json(
        { error: 'Only a follow-up message can be removed' },
        { status: 400 }
      );
    }

    const { error } = await ctx.supabase
      .from('shopify_event_templates')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('event', event)
      .eq('variant', variant)
      .eq('step', step);
    if (error) {
      console.error('[DELETE /api/shopify/events] delete error:', error);
      return NextResponse.json(
        { error: 'Failed to remove this message' },
        { status: 500 }
      );
    }
    return NextResponse.json({ removed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
