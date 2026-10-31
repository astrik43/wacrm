import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shopify/link-codes', () => ({
  makeLinkCode: (kind: string, _account: string, id: string) => `${kind}${id}.sig`,
}));

import { backfillTemplateButtons } from './backfill-buttons';

type Row = Record<string, unknown>;

/** Minimal query-builder fake: filters are applied, order/limit ignored. */
function fakeDb(tables: Record<string, Row[]>, updates: Row[]) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let patch: Row | null = null;
      const builder = {
        select: () => builder,
        update: (p: Row) => {
          patch = p;
          return builder;
        },
        eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), builder),
        lt: () => builder,
        not: (col: string) => (filters.push((r) => r[col] != null), builder),
        is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), builder),
        in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), builder),
        order: () => builder,
        limit: () => builder,
        rows: () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))),
        maybeSingle: async () => ({ data: builder.rows()[0] ?? null, error: null }),
        then(resolve: (v: { data: Row[]; error: null }) => void) {
          if (patch) {
            for (const r of builder.rows()) {
              Object.assign(r, patch);
              updates.push({ table, id: r.id, ...patch });
            }
          }
          resolve({ data: builder.rows(), error: null });
        },
      };
      return builder;
    },
  } as never;
}

const TEMPLATE = {
  id: 'tpl', user_id: 'u', account_id: 'acct', name: 'order_shipped_v2', language: 'en',
  category: 'Utility', status: 'APPROVED', body_text: 'Hi {{1}}', created_at: 'x',
  buttons: [{ type: 'URL', text: 'Track', url: 'https://crm.test/r/{{1}}' }],
};

describe('backfillTemplateButtons', () => {
  it('rebuilds the tracking link of a sent shipment message, once', async () => {
    const message: Row = { id: 'm1', content_type: 'template', template_name: 'order_shipped_v2', interactive_payload: null };
    const tables = {
      shopify_notifications: [{
        id: 'n1', account_id: 'acct', event: 'tracking_added', step: 0, status: 'sent',
        shopify_order_id: 'o1', shopify_fulfillment_id: 'f9', shopify_checkout_id: null, message_id: 'm1',
      }],
      messages: [message],
      shopify_orders: [{ account_id: 'acct', shopify_order_id: 'o1', fields: { customer_first_name: 'Asha' } }],
      shopify_event_templates: [{
        account_id: 'acct', event: 'tracking_added', step: 0, template_name: 'order_shipped_v2',
        template_language: 'en',
        variable_mapping: {
          body: [{ type: 'field', value: 'customer_first_name' }],
          buttonParams: { 0: { type: 'field', value: 'tracking_link_code' } },
        },
      }],
      message_templates: [TEMPLATE],
    };
    const updates: Row[] = [];
    expect(await backfillTemplateButtons(fakeDb(tables, updates))).toEqual({ filled: 1 });
    expect(message.interactive_payload).toEqual({
      kind: 'template',
      buttons: [{ type: 'url', text: 'Track', value: 'https://crm.test/r/tf9.sig' }],
    });

    // Already filled: nothing more to do.
    expect(await backfillTemplateButtons(fakeDb(tables, updates))).toEqual({ filled: 0 });
    expect(updates).toHaveLength(1);
  });

  it('marks a message it cannot rebuild so it is not retried', async () => {
    const message: Row = { id: 'm2', content_type: 'template', template_name: 'gone', interactive_payload: null };
    const tables = {
      shopify_notifications: [{
        id: 'n2', account_id: 'acct', event: 'delivered', step: 0, status: 'sent',
        shopify_order_id: 'o1', shopify_fulfillment_id: null, shopify_checkout_id: null, message_id: 'm2',
      }],
      messages: [message],
    };
    expect(await backfillTemplateButtons(fakeDb(tables, []))).toEqual({ filled: 0 });
    expect(message.interactive_payload).toEqual({ kind: 'template', buttons: [] });
  });
});
