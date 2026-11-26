// MCP 2.0 — "commerce" tools (Shopify / FlexyPe / Shiprocket,
// commerce:read | commerce:write). See ../CONVENTIONS.md.
//
// Wraps the existing src/lib/shopify functions; nothing in there is
// edited. No tool returns a phone number, address, email or secret:
// customers are referred to by order number or contact id.
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { encodeCursor, decodeCursor } from '@/lib/api/v1/pagination';
import { hasApiCredentials } from '@/lib/shopify/admin-api';
import { getShopifyConfigByAccount, type ShopifyConfigRow } from '@/lib/shopify/config';
import { tagDeliveredCustomersPage } from '@/lib/shopify/delivered-backfill';
import {
  FULFILLMENT_EVENTS,
  MAX_DELAY_MINUTES,
  MAX_FOLLOW_UPS,
  MIN_CART_DELAY_MINUTES,
  SHOPIFY_EVENTS,
  SHOPIFY_VARIANTS,
  isCartEvent,
  isShopifyTopic,
  variantsForEvent,
  type ShopifyEvent,
  type ShopifyVariant,
} from '@/lib/shopify/events';
import { sendTestNotification } from '@/lib/shopify/notify';
import {
  SHOPIFY_FIELDS,
  SHOPIFY_FIELD_KEYS,
  type ShopifyFields,
} from '@/lib/shopify/order-fields';
import { normalizeShopifyPhone, pickOrderPhone } from '@/lib/shopify/phone';
import { processShopifyWebhook } from '@/lib/shopify/process';
import { parseVariableMapping, validateVariableMapping } from '@/lib/shopify/variable-mapping';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool } from '../types';

type Db = SupabaseClient;
type Row = Record<string, unknown>;

const MAX_TEST_PHONES = 5;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// ── shared helpers ──────────────────────────────────────────

const eventEnum = z.enum(SHOPIFY_EVENTS);
const variantEnum = z.enum(SHOPIFY_VARIANTS);

const pageInput = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Page size (default 25, max 100).'),
  cursor: z.string().max(500).optional().describe('next_cursor from the previous page.'),
};

/** `••••1234`: enough to recognise a number, not enough to use it. */
function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length <= 4 ? '••••' : `••••${d.slice(-4)}`;
}

function requireConfig(config: ShopifyConfigRow | null): ShopifyConfigRow {
  if (!config) {
    throw new McpToolError('not_found', 'Shopify is not connected for this account. Connect it in Settings → Shopify first.');
  }
  return config;
}

/** Same keyset as the v1 API, on a chosen timestamp column. */
function paginate<T extends { id: string }>(rows: T[], limit: number, col: keyof T & string) {
  if (rows.length <= limit) return { items: rows, next_cursor: null as string | null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: encodeCursor({ created_at: String(last[col]), id: last.id }),
  };
}

function keysetOr(cursor: string | undefined, col: string): string | null {
  const c = decodeCursor(cursor ?? null);
  if (!c) return null;
  return `${col}.lt.${c.createdAt},and(${col}.eq.${c.createdAt},id.lt.${c.id})`;
}

function dbError(error: { message: string } | null, what: string): void {
  if (!error) return;
  console.error(`[mcp commerce] ${what}:`, error.message);
  throw new McpToolError('internal', `Could not load ${what}. Try again.`);
}

/** Order-number search text: digits, letters and `#` only (it goes into a LIKE). */
function orderNumberNeedle(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9#_-]/g, '');
  if (!clean) throw new McpToolError('invalid_input', 'order_number has no usable characters', 'order_number');
  return clean;
}

// ── order updates (shopify_event_templates) ─────────────────

const EVENT_COLUMNS =
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

interface EventItem {
  event: ShopifyEvent;
  variant: ShopifyVariant;
  step: number;
  is_enabled: boolean;
  template_name: string | null;
  template_language: string | null;
  variable_mapping: unknown;
  delay_minutes: number;
  configured: boolean;
  updated_at: string | null;
}

async function loadEventRows(db: Db, accountId: string): Promise<EventRow[]> {
  const { data, error } = await db
    .from('shopify_event_templates')
    .select(EVENT_COLUMNS)
    .eq('account_id', accountId);
  dbError(error, 'order updates');
  return (data ?? []) as EventRow[];
}

/** Every update with defaults for the ones never configured, like the settings page. */
function describeEvents(rows: EventRow[]): EventItem[] {
  return SHOPIFY_EVENTS.flatMap((event) =>
    variantsForEvent(event).flatMap((variant) => {
      const saved = rows.filter((r) => r.event === event && r.variant === variant);
      const steps = new Set([0, ...saved.map((r) => r.step ?? 0)]);
      return [...steps]
        .sort((a, b) => a - b)
        .map((step): EventItem => {
          const row = saved.find((r) => (r.step ?? 0) === step);
          return {
            event,
            variant,
            step,
            is_enabled: row?.is_enabled ?? false,
            template_name: row?.template_name ?? null,
            template_language: row?.template_language ?? null,
            variable_mapping: parseVariableMapping(row?.variable_mapping) ?? { body: [] },
            delay_minutes: row?.delay_minutes ?? 0,
            configured: Boolean(row),
            updated_at: row?.updated_at ?? null,
          };
        });
    })
  );
}

function checkVariantStep(event: ShopifyEvent, variant: ShopifyVariant, step: number) {
  if (!variantsForEvent(event).includes(variant)) {
    throw new McpToolError(
      'invalid_input',
      `'variant' ${variant} is not available for ${event}${isCartEvent(event) ? ' (cart reminders only use "all")' : ''}`,
      'variant'
    );
  }
  if (step > MAX_FOLLOW_UPS) {
    throw new McpToolError('invalid_input', `'step' must be 0 to ${MAX_FOLLOW_UPS}`, 'step');
  }
}

/** The template must exist, be approved by Meta, and have every placeholder mapped. */
async function checkTemplate(
  db: Db,
  accountId: string,
  event: ShopifyEvent,
  name: string,
  language: string | null,
  mapping: NonNullable<ReturnType<typeof parseVariableMapping>>
) {
  const resolved = await resolveTemplateRow(db, accountId, name, language);
  if (!resolved.row) {
    throw new McpToolError('not_found', 'Template not found. Run sync_templates, then retry.', 'template_name');
  }
  if (resolved.row.status !== 'APPROVED') {
    throw new McpToolError('template_not_approved', 'Only templates approved by Meta can be used', 'template_name');
  }
  const problems = validateVariableMapping(resolved.row, mapping, event);
  if (problems.length > 0) {
    throw new McpToolError(
      'invalid_input',
      `Every placeholder in the template needs a value. Problems: ${problems.join(', ')}`,
      'variable_mapping'
    );
  }
  return resolved;
}

// ── tools ───────────────────────────────────────────────────

export const commerceTools: AnyMcpTool[] = [
  // ── status ────────────────────────────────────────────────
  defineTool({
    name: 'get_shopify_status',
    title: 'Shopify connection status',
    description:
      'Is Shopify connected, is test mode on (and which numbers are allowed, masked), are Admin API credentials saved and what scopes they have, and when each integration (Shopify, FlexyPe, Shiprocket) last delivered a webhook. Call this first before any order tool. Never returns secrets or webhook URLs.',
    scope: 'commerce:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const config = await getShopifyConfigByAccount(ctx.supabase, ctx.accountId);
      if (!config) return { connected: false, hint: 'Connect Shopify in Settings → Shopify.' };
      const scopes = (config.api_scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const phones = config.test_phones ?? [];
      return {
        connected: config.is_active,
        shop_domain: config.shop_domain,
        default_country_code: config.default_country_code,
        last_webhook_at: config.last_webhook_at,
        test_mode: config.test_mode,
        test_numbers: phones.map(maskPhone),
        test_numbers_count: phones.length,
        api_credentials: {
          saved: hasApiCredentials(config),
          scopes,
          token_valid_until: config.api_token_expires_at,
        },
        flexype: { enabled: Boolean(config.flexype_secret), last_webhook_at: config.flexype_last_webhook_at },
        shiprocket: { enabled: Boolean(config.shiprocket_secret), last_webhook_at: config.shiprocket_last_webhook_at },
        warning: config.test_mode
          ? 'Test mode is ON: only the listed test numbers receive order updates.'
          : undefined,
      };
    },
  }),

  // ── orders ────────────────────────────────────────────────
  defineTool({
    name: 'search_orders',
    title: 'Search orders',
    description:
      'Search Shopify orders stored in the CRM, newest first. Filter by order_number (e.g. "1042" or "#1042"), status (active / cancelled), payment_mode (cod / prepaid) and a created date range. Returns order numbers, totals and contact ids (no phones or addresses). Use get_order for one order\'s timeline.',
    scope: 'commerce:read',
    tier: 'read',
    input: {
      order_number: z.string().max(40).optional(),
      status: z.enum(['active', 'cancelled']).optional(),
      payment_mode: z.enum(['cod', 'prepaid']).optional(),
      from: z.string().optional().describe('Created on or after, ISO date.'),
      to: z.string().optional().describe('Created before, ISO date.'),
      ...pageInput,
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      for (const key of ['from', 'to'] as const) {
        if (args[key] && Number.isNaN(Date.parse(args[key]!))) {
          throw new McpToolError('invalid_input', `'${key}' is not a valid date`, key);
        }
      }
      let q = ctx.supabase
        .from('shopify_orders')
        .select('id, shopify_order_id, order_name, contact_id, payment_mode, cancelled_at, cod_decision, fields, created_at')
        .eq('account_id', ctx.accountId);
      if (args.order_number) q = q.ilike('order_name', `%${orderNumberNeedle(args.order_number)}%`);
      if (args.status === 'cancelled') q = q.not('cancelled_at', 'is', null);
      if (args.status === 'active') q = q.is('cancelled_at', null);
      if (args.payment_mode) q = q.eq('payment_mode', args.payment_mode);
      if (args.from) q = q.gte('created_at', new Date(args.from).toISOString());
      if (args.to) q = q.lt('created_at', new Date(args.to).toISOString());
      const keyset = keysetOr(args.cursor, 'created_at');
      if (keyset) q = q.or(keyset);
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      dbError(error, 'orders');
      const page = paginate((data ?? []) as (Row & { id: string; created_at: string })[], limit, 'created_at');
      return {
        items: page.items.map(orderSummary),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineTool({
    name: 'get_order',
    title: 'Get an order',
    description:
      'One order with its shipments (tracking and shipment status), the order-update messages sent or scheduled for it, and the tags on its contact. Pass order_id (uuid from search_orders) or order_number. The customer is referenced by contact_id only.',
    scope: 'commerce:read',
    tier: 'read',
    input: {
      order_id: z.string().uuid().optional(),
      order_number: z.string().max(40).optional(),
    },
    handler: async (ctx, args) => {
      if (!args.order_id && !args.order_number) {
        throw new McpToolError('invalid_input', 'Pass order_id or order_number', 'order_id');
      }
      let q = ctx.supabase
        .from('shopify_orders')
        .select('id, shopify_order_id, order_name, contact_id, payment_mode, cancelled_at, cod_decision, cod_decided_at, fields, created_at')
        .eq('account_id', ctx.accountId);
      if (args.order_id) {
        q = q.eq('id', args.order_id);
      } else {
        const n = orderNumberNeedle(args.order_number!);
        const bare = n.replace(/^#/, '');
        q = q.in('order_name', [n, `#${bare}`, bare]);
      }
      const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
      dbError(error, 'the order');
      const order = data as (Row & { shopify_order_id: string; contact_id: string | null }) | null;
      if (!order) throw new McpToolError('not_found', 'Order not found. Use search_orders to find it.');

      const [shipments, notifications] = await Promise.all([
        ctx.supabase
          .from('shopify_fulfillments')
          .select('shopify_fulfillment_id, tracking_number, tracking_company, shipment_status, created_at, updated_at')
          .eq('account_id', ctx.accountId)
          .eq('shopify_order_id', order.shopify_order_id)
          .order('created_at', { ascending: true }),
        ctx.supabase
          .from('shopify_notifications')
          .select('id, event, step, variant, status, reason, send_at, is_test, created_at')
          .eq('account_id', ctx.accountId)
          .eq('shopify_order_id', order.shopify_order_id)
          .order('created_at', { ascending: true }),
      ]);
      dbError(shipments.error, 'shipments');
      dbError(notifications.error, 'notifications');

      let tags: string[] = [];
      if (order.contact_id) {
        const links = await ctx.supabase.from('contact_tags').select('tag_id').eq('contact_id', order.contact_id);
        const ids = ((links.data ?? []) as { tag_id: string }[]).map((l) => l.tag_id);
        if (ids.length > 0) {
          const t = await ctx.supabase.from('tags').select('name').eq('account_id', ctx.accountId).in('id', ids);
          tags = ((t.data ?? []) as { name: string }[]).map((x) => x.name);
        }
      }

      return {
        order: orderSummary(order),
        cod_decision: order.cod_decision ?? null,
        cod_decided_at: order.cod_decided_at ?? null,
        shipments: shipments.data ?? [],
        notifications: notifications.data ?? [],
        contact_tags: tags,
      };
    },
  }),

  defineTool({
    name: 'list_contact_orders',
    title: 'List a contact\'s orders',
    description:
      'The Shopify orders placed by one contact, newest first. contact_id is a CRM contact uuid (from the contacts tools).',
    scope: 'commerce:read',
    tier: 'read',
    input: { contact_id: z.string().uuid(), ...pageInput },
    handler: async (ctx, args) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('id', args.contact_id)
        .maybeSingle();
      if (!contact) throw new McpToolError('not_found', 'Contact not found in this account.', 'contact_id');
      let q = ctx.supabase
        .from('shopify_orders')
        .select('id, shopify_order_id, order_name, contact_id, payment_mode, cancelled_at, cod_decision, fields, created_at')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', args.contact_id);
      const keyset = keysetOr(args.cursor, 'created_at');
      if (keyset) q = q.or(keyset);
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      dbError(error, 'orders');
      const page = paginate((data ?? []) as (Row & { id: string; created_at: string })[], limit, 'created_at');
      return { items: page.items.map(orderSummary), next_cursor: page.next_cursor };
    },
  }),

  // ── order-update events ───────────────────────────────────
  defineTool({
    name: 'list_order_update_events',
    title: 'List order update events',
    description:
      'Every WhatsApp order update (order created, tracking added, out for delivery, delivered, cancelled, cart reminders) with its on/off switch, template, delay in minutes and variable mapping, once per payment variant (all / cod / prepaid) and follow-up step. Never-configured ones show configured: false. Use update_order_update_event to change one.',
    scope: 'commerce:read',
    tier: 'read',
    input: {
      event: eventEnum.optional().describe('Only this event.'),
      only_enabled: z.boolean().optional().describe('Only switched-on messages.'),
    },
    handler: async (ctx, args) => {
      let items = describeEvents(await loadEventRows(ctx.supabase, ctx.accountId));
      if (args.event) items = items.filter((i) => i.event === args.event);
      if (args.only_enabled) items = items.filter((i) => i.is_enabled);
      return { items };
    },
  }),

  defineTool({
    name: 'get_order_update_event',
    title: 'Get an order update event',
    description:
      'One order update for a payment variant: its first message (step 0) and any follow-up steps, with template mapping, delays and on/off. Pass step to get only that message.',
    scope: 'commerce:read',
    tier: 'read',
    input: {
      event: eventEnum,
      variant: variantEnum.optional().describe('Default "all".'),
      step: z.number().int().min(0).max(MAX_FOLLOW_UPS).optional(),
    },
    handler: async (ctx, args) => {
      const variant = args.variant ?? 'all';
      checkVariantStep(args.event, variant, args.step ?? 0);
      let items = describeEvents(await loadEventRows(ctx.supabase, ctx.accountId)).filter(
        (i) => i.event === args.event && i.variant === variant
      );
      if (args.step !== undefined) items = items.filter((i) => i.step === args.step);
      if (items.length === 0) throw new McpToolError('not_found', 'No such message. Follow-up steps exist only once saved.', 'step');
      return { items };
    },
  }),

  defineTool({
    name: 'update_order_update_event',
    title: 'Update an order update event',
    description:
      'Change one order-update message: switch on/off, template, language, delay_minutes and variable_mapping. Only the fields you pass change. Validated like the settings page: the template must be Meta-approved with every placeholder mapped, and cart reminders need a delay of at least 10 minutes. Switching it on makes real customers receive WhatsApp messages, so use dry_run first to see the diff.',
    scope: 'commerce:write',
    tier: 'write',
    input: {
      event: eventEnum,
      variant: variantEnum.optional().describe('Default "all".'),
      step: z.number().int().min(0).max(MAX_FOLLOW_UPS).optional().describe('0 = first message, 1-4 = follow-ups. Default 0.'),
      is_enabled: z.boolean().optional(),
      template_name: z.string().max(200).nullable().optional(),
      template_language: z.string().max(20).nullable().optional(),
      delay_minutes: z.number().int().min(0).max(MAX_DELAY_MINUTES).optional(),
      variable_mapping: z.unknown().optional().describe('{ body: [{type:"field",value:"order_number"} | {type:"static",value:"text"}], headerText?, headerImage?, buttonParams? }. See list_order_update_events for examples.'),
    },
    handler: async (ctx, args) => {
      const variant = args.variant ?? 'all';
      const step = args.step ?? 0;
      checkVariantStep(args.event, variant, step);

      const rows = await loadEventRows(ctx.supabase, ctx.accountId);
      const current = describeEvents(rows).find(
        (i) => i.event === args.event && i.variant === variant && i.step === step
      ) ?? {
        // A follow-up step that does not exist yet starts from blank.
        event: args.event, variant, step, is_enabled: false, template_name: null,
        template_language: null, variable_mapping: { body: [] }, delay_minutes: 0,
        configured: false, updated_at: null,
      };

      const next = {
        is_enabled: args.is_enabled ?? current.is_enabled,
        template_name:
          args.template_name === undefined ? current.template_name : args.template_name?.trim() || null,
        template_language:
          args.template_language === undefined ? current.template_language : args.template_language?.trim() || null,
        delay_minutes: args.delay_minutes ?? current.delay_minutes,
        variable_mapping: current.variable_mapping as unknown,
      };
      if (args.variable_mapping !== undefined) {
        const parsed = parseVariableMapping(args.variable_mapping);
        if (!parsed) throw new McpToolError('invalid_input', "'variable_mapping' has an invalid shape", 'variable_mapping');
        next.variable_mapping = { ...parsed, body: Array.from(parsed.body, (s) => s ?? null) };
      }

      if (next.is_enabled && isCartEvent(args.event) && next.delay_minutes < MIN_CART_DELAY_MINUTES) {
        throw new McpToolError('invalid_input', `A cart reminder needs a delay of at least ${MIN_CART_DELAY_MINUTES} minutes`, 'delay_minutes');
      }
      if (next.is_enabled && !next.template_name) {
        throw new McpToolError('invalid_input', 'Choose a template before switching this update on', 'template_name');
      }
      if (next.template_name) {
        const mapping = parseVariableMapping(next.variable_mapping);
        if (!mapping) throw new McpToolError('invalid_input', "'variable_mapping' has an invalid shape", 'variable_mapping');
        await checkTemplate(ctx.supabase, ctx.accountId, args.event, next.template_name, next.template_language, mapping);
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of ['is_enabled', 'template_name', 'template_language', 'delay_minutes', 'variable_mapping'] as const) {
        if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
          changes[key] = { from: current[key], to: next[key] };
        }
      }
      const target = { event: args.event, variant, step };

      if (ctx.dryRun) {
        return { dry_run: true, target, changes, effect: next.is_enabled ? 'Matching orders will message customers.' : 'This message is off.' };
      }
      if (Object.keys(changes).length === 0 && current.configured) {
        return { target, changes, saved: false, note: 'Nothing to change.' };
      }

      const { error } = await ctx.supabase.from('shopify_event_templates').upsert(
        {
          account_id: ctx.accountId,
          event: args.event,
          variant,
          step,
          delay_minutes: next.delay_minutes,
          is_enabled: next.is_enabled,
          template_name: next.template_name,
          template_language: next.template_language,
          variable_mapping: next.variable_mapping,
        },
        { onConflict: 'account_id,event,variant,step' }
      );
      dbError(error, 'the update (save failed)');
      return { target, changes, saved: true };
    },
  }),

  defineTool({
    name: 'set_shopify_test_mode',
    title: 'Set Shopify test mode',
    description:
      'Turn Shopify test mode on or off and optionally replace the list of test numbers (max 5, include the country code or the store default is used). While test mode is ON only the test numbers get order updates, so keep it on while trying templates out. Turning it OFF lets real customers be messaged. Use dry_run to preview. The result shows numbers masked.',
    scope: 'commerce:write',
    tier: 'write',
    input: {
      enabled: z.boolean().describe('true = only test numbers are messaged.'),
      test_numbers: z.array(z.string().max(40)).max(MAX_TEST_PHONES).optional().describe('Replaces the whole list when given.'),
    },
    handler: async (ctx, args) => {
      const config = requireConfig(await getShopifyConfigByAccount(ctx.supabase, ctx.accountId));

      let phones = config.test_phones ?? [];
      if (args.test_numbers !== undefined) {
        phones = [];
        for (const entry of args.test_numbers) {
          if (!entry.trim()) continue;
          const phone = pickOrderPhone([entry], config.default_country_code);
          if (!phone) {
            throw new McpToolError('invalid_input', 'A test number is not usable. Include the country code, e.g. +91 98765 43210.', 'test_numbers');
          }
          if (!phones.includes(phone)) phones.push(phone);
        }
      }

      const result = {
        test_mode: { from: config.test_mode, to: args.enabled },
        test_numbers: phones.map(maskPhone),
        warning:
          args.enabled && phones.length === 0
            ? 'Test mode is on with no test numbers: nobody will receive order updates.'
            : !args.enabled
              ? 'Test mode is off: real customers receive order updates.'
              : undefined,
      };
      if (ctx.dryRun) return { dry_run: true, ...result };

      const { error } = await ctx.supabase
        .from('shopify_configs')
        .update({ test_mode: args.enabled, test_phones: phones })
        .eq('account_id', ctx.accountId);
      dbError(error, 'test mode (save failed)');
      return { saved: true, ...result };
    },
  }),

  defineTool({
    name: 'send_order_update_test',
    title: 'Send an order update test',
    description:
      'Send one order-update message right now to a number you choose, using the saved template of that event / variant / step and values from your latest order (or sample values). It ignores the on/off switch, the delay and test mode, and shows in the activity log as a test. Use dry_run to see what would be sent. Configure the message first with update_order_update_event.',
    scope: 'commerce:write',
    tier: 'write',
    input: {
      event: eventEnum,
      variant: variantEnum.optional().describe('Default "all".'),
      step: z.number().int().min(0).max(MAX_FOLLOW_UPS).optional(),
      phone: z.string().min(5).max(40).describe('Where to send the test, with country code.'),
      source: z.enum(['latest', 'sample']).optional().describe('latest = values from your newest order or cart; sample = built-in sample values. Default latest.'),
    },
    handler: async (ctx, args) => {
      const variant = args.variant ?? 'all';
      const step = args.step ?? 0;
      checkVariantStep(args.event, variant, step);
      const config = requireConfig(await getShopifyConfigByAccount(ctx.supabase, ctx.accountId));
      const phone = normalizeShopifyPhone(args.phone, config.default_country_code);
      if (!phone) throw new McpToolError('invalid_input', 'Enter a phone number with its country code', 'phone');

      const saved = describeEvents(await loadEventRows(ctx.supabase, ctx.accountId)).find(
        (i) => i.event === args.event && i.variant === variant && i.step === step
      );
      if (!saved?.template_name) {
        throw new McpToolError('invalid_input', 'No template is set for this message. Use update_order_update_event first.', 'event');
      }
      const mapping = parseVariableMapping(saved.variable_mapping);
      if (!mapping) throw new McpToolError('invalid_input', 'The saved variable mapping is invalid', 'event');
      const resolved = await checkTemplate(ctx.supabase, ctx.accountId, args.event, saved.template_name, saved.template_language, mapping);

      const fields: ShopifyFields = {};
      for (const key of SHOPIFY_FIELD_KEYS) {
        if (key !== 'product_image_url') fields[key] = SHOPIFY_FIELDS[key].sample;
      }
      let orderName: string = SHOPIFY_FIELDS.order_number.sample;
      if ((args.source ?? 'latest') === 'latest') {
        const table = isCartEvent(args.event) ? 'shopify_checkouts' : 'shopify_orders';
        const { data } = await ctx.supabase
          .from(table)
          .select(isCartEvent(args.event) ? 'customer_name, fields' : 'order_name, fields')
          .eq('account_id', ctx.accountId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const row = data as { order_name?: string | null; customer_name?: string | null; fields?: ShopifyFields | null } | null;
        if (row?.fields) Object.assign(fields, row.fields);
        orderName = row?.order_name ?? row?.customer_name ?? orderName;
      }

      const plan = {
        event: args.event,
        variant,
        step,
        template_name: resolved.row!.name,
        template_language: resolved.language,
        recipient: maskPhone(phone),
        shipment_event: FULFILLMENT_EVENTS.includes(args.event),
      };
      if (ctx.dryRun) return { dry_run: true, would_send: plan };

      const outcome = await sendTestNotification(ctx.supabase, ctx.accountId, {
        event: args.event,
        variant,
        step,
        templateName: resolved.row!.name,
        templateLanguage: resolved.language,
        variableMapping: mapping,
        phone,
        orderName: `Test · ${orderName}`,
        fields,
      });
      return { sent: outcome.status === 'sent', outcome, ...plan };
    },
  }),

  // ── logs ──────────────────────────────────────────────────
  defineTool({
    name: 'list_notification_log',
    title: 'Order update notification log',
    description:
      'Recent Shopify-triggered WhatsApp sends, newest first: sent, scheduled, skipped, failed or cancelled with the reason why. Filter by status, event or order_number. Test sends are hidden unless include_tests is true. Use this to answer "why did this customer not get a message".',
    scope: 'commerce:read',
    tier: 'read',
    input: {
      status: z.enum(['pending', 'scheduled', 'sent', 'skipped', 'failed', 'cancelled']).optional(),
      event: eventEnum.optional(),
      order_number: z.string().max(40).optional(),
      include_tests: z.boolean().optional(),
      ...pageInput,
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      let q = ctx.supabase
        .from('shopify_notifications')
        .select('id, event, order_name, status, reason, variant, step, send_at, is_test, created_at')
        .eq('account_id', ctx.accountId);
      if (args.status) q = q.eq('status', args.status);
      if (args.event) q = q.eq('event', args.event);
      if (args.order_number) q = q.ilike('order_name', `%${orderNumberNeedle(args.order_number)}%`);
      if (!args.include_tests) q = q.eq('is_test', false);
      const keyset = keysetOr(args.cursor, 'created_at');
      if (keyset) q = q.or(keyset);
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      dbError(error, 'the notification log');
      const page = paginate((data ?? []) as (Row & { id: string; created_at: string })[], limit, 'created_at');
      return {
        items: page.items.map(({ order_name, ...rest }) => ({ ...rest, order_number: order_name })),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineTool({
    name: 'list_webhook_events',
    title: 'List Shopify webhook events',
    description:
      'Recent webhook deliveries from Shopify (kept 30 days), newest first, with topic, status (received / processed / ignored / rejected / error), the reason and what each produced. Payloads are not returned. Pass an id to replay_webhook_event to re-run one.',
    scope: 'commerce:read',
    tier: 'read',
    input: {
      status: z.enum(['received', 'processed', 'ignored', 'rejected', 'error']).optional(),
      topic: z.string().max(60).optional().describe('e.g. orders/create, fulfillments/update.'),
      order_number: z.string().max(40).optional(),
      ...pageInput,
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? DEFAULT_LIMIT;
      let q = ctx.supabase
        .from('shopify_webhook_events')
        .select('id, received_at, topic, order_ref, status, detail, outcome')
        .eq('account_id', ctx.accountId);
      if (args.status) q = q.eq('status', args.status);
      if (args.topic) q = q.eq('topic', args.topic);
      if (args.order_number) q = q.ilike('order_ref', `%${orderNumberNeedle(args.order_number)}%`);
      const keyset = keysetOr(args.cursor, 'received_at');
      if (keyset) q = q.or(keyset);
      const { data, error } = await q
        .order('received_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      dbError(error, 'webhook events');
      const page = paginate((data ?? []) as (Row & { id: string; received_at: string })[], limit, 'received_at');
      return {
        items: page.items.map(({ order_ref, ...rest }) => ({ ...rest, order_number: order_ref })),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineTool({
    name: 'replay_webhook_event',
    title: 'Replay a webhook event',
    description:
      'Re-run one logged Shopify webhook through the order-update engine, as if Shopify had just sent it. It can message a customer (a new order or tracking update), although updates already sent for the same order are not repeated. Honours test mode: while it is on, deliveries for anyone but a test number are dropped. Use list_webhook_events for the id, and dry_run first to see what would run.',
    scope: 'commerce:write',
    tier: 'destructive',
    input: { event_id: z.string().uuid().describe('id from list_webhook_events') },
    handler: async (ctx, args) => {
      const { data, error } = await ctx.supabase
        .from('shopify_webhook_events')
        .select('id, topic, order_ref, status, shopify_webhook_id, payload')
        .eq('account_id', ctx.accountId)
        .eq('id', args.event_id)
        .maybeSingle();
      dbError(error, 'the webhook event');
      const event = data as { id: string; topic: string | null; order_ref: string | null; status: string; shopify_webhook_id: string | null; payload: unknown } | null;
      if (!event) throw new McpToolError('not_found', 'Webhook event not found. Use list_webhook_events.', 'event_id');
      if (!isShopifyTopic(event.topic)) {
        throw new McpToolError('invalid_input', 'This event has no replayable Shopify topic.', 'event_id');
      }
      if (!event.payload) {
        throw new McpToolError('invalid_input', 'This event kept no payload (too large or rejected), so it cannot be replayed.', 'event_id');
      }
      const config = requireConfig(await getShopifyConfigByAccount(ctx.supabase, ctx.accountId));

      const plan = {
        event_id: event.id,
        topic: event.topic,
        order_number: event.order_ref,
        previous_status: event.status,
        test_mode: config.test_mode,
        effect: config.test_mode
          ? 'Test mode is ON: only a delivery for a test number would be processed.'
          : 'Will run the update engine; enabled order updates for this order may be sent to the customer.',
      };
      if (ctx.dryRun) return { dry_run: true, would_replay: plan };

      const result = await processShopifyWebhook(ctx.supabase, config, event.topic, event.payload, event.shopify_webhook_id);
      return {
        replayed: true,
        ...plan,
        note: result.note ?? null,
        outcomes: result.outcomes,
      };
    },
  }),

  // ── delivered / RTO tagging ───────────────────────────────
  defineTool({
    name: 'tag_delivered_customers',
    title: 'Tag delivered / RTO customers',
    description:
      'Tag the customers of past Shopify orders: "Order Delivered" for delivered ones and "Order RTO" for returned ones. Reads ONE page of orders (oldest first) from Shopify per call. Start without a cursor, then call again with the returned next_cursor until it is null. Needs Admin API credentials (see get_shopify_status). Honours test mode. Returns counts only, never phone numbers. Use dry_run to check the prerequisites without calling Shopify.',
    scope: 'commerce:write',
    tier: 'write',
    input: { cursor: z.string().max(1000).optional().describe('next_cursor from the previous call; omit for the first page.') },
    handler: async (ctx, args) => {
      const config = requireConfig(await getShopifyConfigByAccount(ctx.supabase, ctx.accountId));
      if (!hasApiCredentials(config)) {
        throw new McpToolError('invalid_input', 'Add your Shopify app credentials (Settings → Shopify → Product images & order tags) first.');
      }
      if (ctx.dryRun) {
        return {
          dry_run: true,
          would_do: 'Read one page of orders from Shopify and tag the delivered / returned customers.',
          from_cursor: args.cursor ?? null,
          test_mode: config.test_mode,
        };
      }
      const result = await tagDeliveredCustomersPage(ctx.supabase, config, args.cursor ?? null);
      if (!result.ok) {
        throw new McpToolError('upstream_error', `Shopify refused: ${result.error}`);
      }
      return {
        scanned: result.scanned,
        delivered: result.delivered,
        returned: result.returned,
        noPhone: result.noPhone,
        oldestOrderAt: result.oldestOrderAt,
        next_cursor: result.nextCursor,
      };
    },
  }),
];

/** An order without its customer details: number, totals, payment and cancellation. */
function orderSummary(row: Row) {
  const fields = (row.fields ?? {}) as ShopifyFields;
  return {
    id: row.id,
    order_number: row.order_name ?? null,
    contact_id: row.contact_id ?? null,
    payment_mode: row.payment_mode ?? null,
    cancelled: Boolean(row.cancelled_at),
    cancelled_at: row.cancelled_at ?? null,
    order_total: fields.order_total ?? null,
    currency: fields.currency ?? null,
    item_summary: fields.item_summary ?? null,
    created_at: row.created_at,
  };
}
