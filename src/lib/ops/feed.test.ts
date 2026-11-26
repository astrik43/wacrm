import { describe, expect, it } from 'vitest';

import { listEventsSince } from './feed';
import { fakeDb, type Tables } from './testing';

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function world(): Tables {
  const now = Date.now();
  const t = (s: number) => new Date(now - 3600_000 + s * 1000).toISOString();
  return {
    messages: [
      {
        id: uuid(1),
        created_at: t(1),
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'hello '.repeat(100),
        conversation_id: 'conv-1',
        conversations: { account_id: ACCOUNT, contact_id: uuid(100), contacts: { is_staff: false } },
      },
      {
        id: uuid(2),
        created_at: t(2),
        sender_type: 'customer',
        content_type: 'interactive',
        content_text: 'Reattempt',
        interactive_reply_id: '1',
        conversation_id: 'conv-1',
        conversations: { account_id: ACCOUNT, contact_id: uuid(100), contacts: { is_staff: false } },
      },
      {
        id: uuid(3),
        created_at: t(3),
        sender_type: 'agent',
        content_type: 'text',
        content_text: 'our reply',
        conversation_id: 'conv-1',
        conversations: { account_id: ACCOUNT, contact_id: uuid(100), contacts: { is_staff: false } },
      },
      {
        id: uuid(4),
        created_at: t(4),
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'other account',
        conversation_id: 'conv-9',
        conversations: { account_id: OTHER, contact_id: uuid(900), contacts: { is_staff: false } },
      },
    ],
    ndr_requests: [
      {
        id: uuid(10),
        account_id: ACCOUNT,
        order_name: '#EL5',
        contact_id: uuid(100),
        state: 'answered',
        answer: 'new_time',
        answer_text: '2',
        replied_at: t(5),
      },
    ],
    shopify_orders: [
      {
        id: uuid(20),
        account_id: ACCOUNT,
        shopify_order_id: 'so-1',
        order_name: '#EL5',
        contact_id: uuid(100),
        payment_mode: 'cod',
        phone: '910000000001',
        created_at: t(6),
        cod_decided_at: t(7),
        cod_decision: 'confirmed',
      },
    ],
    shopify_fulfillments: [
      {
        id: uuid(30),
        account_id: ACCOUNT,
        shopify_order_id: 'so-1',
        shipment_status: 'attempted_delivery',
        tracking_number: 'AWB123',
        tracking_company: 'Courier',
        updated_at: t(8),
      },
    ],
    contact_tags: [
      {
        id: uuid(40),
        created_at: t(9),
        contact_id: uuid(100),
        tags: { name: 'NDR: reattempt' },
        contacts: { account_id: ACCOUNT, is_staff: false },
      },
    ],
  };
}

describe('listEventsSince', () => {
  it('derives every event type in order, scoped to the account', async () => {
    const { db } = fakeDb(world());
    const page = await listEventsSince(db, ACCOUNT, { limit: 50 });
    expect(page.events.map((e) => e.type)).toEqual([
      'inbound_message',
      'button_reply',
      'ndr_reply',
      'order_event',
      'cod_confirmation',
      'order_event',
      'tag_added',
    ]);
    // Agent messages and other accounts never appear.
    expect(page.events.some((e) => e.text === 'our reply' || e.text === 'other account')).toBe(false);
    const ndr = page.events.find((e) => e.type === 'ndr_reply')!;
    expect(ndr).toMatchObject({ order_number: '#EL5', data: { answer: 'new_time' } });
    const shipment = page.events.find((e) => e.data?.kind === 'shipment_update')!;
    expect(shipment).toMatchObject({
      order_number: '#EL5',
      contact_id: uuid(100),
      data: { shipment_status: 'attempted_delivery', awb: 'AWB123' },
    });
  });

  it('caps text excerpts at 200 chars and never carries a phone number', async () => {
    const { db } = fakeDb(world());
    const page = await listEventsSince(db, ACCOUNT, { limit: 50 });
    expect(page.events[0].text!.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(page)).not.toContain('910000000001');
  });

  it('returns each event exactly once across pages of any size', async () => {
    const { db } = fakeDb(world());
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Awaited<ReturnType<typeof listEventsSince>> = await listEventsSince(db, ACCOUNT, {
        limit: 2,
        cursor,
      });
      seen.push(...page.events.map((e) => `${e.type}:${e.id}`));
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // Polling again with the last cursor finds nothing new.
    const again = await listEventsSince(db, ACCOUNT, { limit: 10, cursor });
    expect(again.events).toEqual([]);
    expect(again.next_cursor).toBe(cursor);
  });

  it('filters by type', async () => {
    const { db } = fakeDb(world());
    const page = await listEventsSince(db, ACCOUNT, { limit: 50, types: ['ndr_reply', 'tag_added'] });
    expect(page.events.map((e) => e.type)).toEqual(['ndr_reply', 'tag_added']);
  });
});
