// ============================================================
// POST /api/shopify/events/test — "Send test" (admin+)
//
// Sends the message being edited in the update dialog right now to the
// number the admin chose: whatever its delay, whether or not it is
// saved or switched on, and whatever test mode says. Values come from
// the latest real order (or cart) laid over sample values, or from the
// samples alone. A shipment update uses the latest shipment that has
// tracking, and its order, so the tracking link is a real one. The COD
// confirmation code is never a real order's. Logged in Activity as a
// test.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  FULFILLMENT_EVENTS,
  isCartEvent,
  isShopifyEvent,
  isShopifyVariant,
  isStep,
  variantsForEvent,
} from '@/lib/shopify/events';
import { sendTestNotification } from '@/lib/shopify/notify';
import {
  SHOPIFY_FIELDS,
  SHOPIFY_FIELD_KEYS,
  type ShopifyFields,
} from '@/lib/shopify/order-fields';
import { makeLinkCode } from '@/lib/shopify/link-codes';
import { normalizeShopifyPhone } from '@/lib/shopify/phone';
import {
  parseVariableMapping,
  validateVariableMapping,
} from '@/lib/shopify/variable-mapping';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

/**
 * Every field's sample value, except the product picture: Meta fetches
 * header images itself, and the sample URL doesn't exist.
 */
function sampleFields(): ShopifyFields {
  const fields: ShopifyFields = {};
  for (const key of SHOPIFY_FIELD_KEYS) {
    if (key !== 'product_image_url') fields[key] = SHOPIFY_FIELDS[key].sample;
  }
  return fields;
}

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * The newest shipment with tracking, with its order's values (when the
 * order is known) — what a real shipment update would carry.
 */
async function latestShipment(
  db: Db,
  accountId: string
): Promise<{ fields: ShopifyFields; orderName: string | null } | null> {
  const { data } = await db
    .from('shopify_fulfillments')
    .select(
      'shopify_fulfillment_id, shopify_order_id, tracking_number, tracking_url, tracking_company'
    )
    .eq('account_id', accountId)
    .not('tracking_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as {
    shopify_fulfillment_id: string;
    shopify_order_id: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    tracking_company: string | null;
  } | null;
  if (!row) return null;

  type StoredOrder = { order_name: string | null; fields: ShopifyFields | null };
  let order: StoredOrder | null = null;
  if (row.shopify_order_id) {
    const { data: orderRow } = await db
      .from('shopify_orders')
      .select('order_name, fields')
      .eq('account_id', accountId)
      .eq('shopify_order_id', row.shopify_order_id)
      .maybeSingle();
    order = (orderRow as StoredOrder | null) ?? null;
  }

  const tracking: ShopifyFields = {};
  if (row.tracking_number) tracking.tracking_number = row.tracking_number;
  if (row.tracking_url) tracking.tracking_url = row.tracking_url;
  if (row.tracking_company) tracking.tracking_company = row.tracking_company;
  // Real codes, so the test's /r/ button opens this shipment's page.
  const trackingLink = makeLinkCode('t', accountId, row.shopify_fulfillment_id);
  if (trackingLink) tracking.tracking_link_code = trackingLink;
  const orderLink = makeLinkCode('s', accountId, row.shopify_order_id);
  if (orderLink) tracking.order_link_code = orderLink;
  return {
    fields: { ...(order?.fields ?? {}), ...tracking },
    orderName: order?.order_name ?? null,
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:shopifyTest:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      event?: unknown;
      variant?: unknown;
      step?: unknown;
      template_name?: unknown;
      template_language?: unknown;
      variable_mapping?: unknown;
      phone?: unknown;
      source?: unknown;
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
      return NextResponse.json({ error: "'step' is invalid" }, { status: 400 });
    }
    const source = body.source === 'sample' ? 'sample' : 'latest';

    const templateName =
      typeof body.template_name === 'string' ? body.template_name.trim() : '';
    if (!templateName) {
      return NextResponse.json({ error: 'Choose a template first' }, { status: 400 });
    }
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

    const db = supabaseAdmin();
    const { data: config } = await db
      .from('shopify_configs')
      .select('default_country_code')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const phone = normalizeShopifyPhone(
      typeof body.phone === 'string' ? body.phone : null,
      (config as { default_country_code: string | null } | null)
        ?.default_country_code ?? null
    );
    if (!phone) {
      return NextResponse.json(
        { error: 'Enter a phone number with its country code' },
        { status: 400 }
      );
    }

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
        { error: 'Every placeholder in the template needs a value', problems },
        { status: 400 }
      );
    }

    let fields = sampleFields();
    let orderName = SHOPIFY_FIELDS.order_number.sample;
    const shipment =
      source === 'latest' && FULFILLMENT_EVENTS.includes(event)
        ? await latestShipment(db, ctx.accountId)
        : null;
    if (shipment) {
      fields = { ...fields, ...shipment.fields };
      orderName = shipment.orderName ?? orderName;
    } else if (source === 'latest') {
      const { data: latest } = await db
        .from(isCartEvent(event) ? 'shopify_checkouts' : 'shopify_orders')
        .select(
          isCartEvent(event)
            ? 'customer_name, fields'
            : 'shopify_order_id, order_name, fields'
        )
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = latest as {
        shopify_order_id?: string | null;
        order_name?: string | null;
        customer_name?: string | null;
        fields?: ShopifyFields | null;
      } | null;
      if (row?.fields) fields = { ...fields, ...row.fields };
      // Orders stored before link codes existed.
      const orderLink = makeLinkCode('s', ctx.accountId, row?.shopify_order_id);
      if (orderLink && !row?.fields?.order_link_code) {
        fields.order_link_code = orderLink;
      }
      orderName = row?.order_name ?? row?.customer_name ?? orderName;
    }

    // A real order's COD confirmation code would let the tester confirm
    // or cancel that customer's order from the test message. Tests get
    // the sample code, whose page simply doesn't exist.
    fields.cod_confirm_token = SHOPIFY_FIELDS.cod_confirm_token.sample;
    fields.cod_confirm_url = SHOPIFY_FIELDS.cod_confirm_url.sample;

    const outcome = await sendTestNotification(db, ctx.accountId, {
      event,
      variant,
      step,
      templateName: resolved.row.name,
      templateLanguage: resolved.language,
      variableMapping: mapping,
      phone,
      orderName: `Test · ${orderName}`,
      fields,
    });

    return NextResponse.json(
      { outcome, phone },
      { status: outcome.status === 'sent' ? 200 : 502 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
