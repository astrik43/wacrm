import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  resolveConversationByPhone: vi.fn(),
  sendMessageToConversation: vi.fn(),
  resolveTemplateRow: vi.fn(),
}));

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mocks.resolveConversationByPhone,
}));

vi.mock('@/lib/whatsapp/send-message', () => {
  class SendMessageError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    SendMessageError,
    sendMessageToConversation: mocks.sendMessageToConversation,
  };
});

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: mocks.resolveTemplateRow,
}));

import { SendMessageError } from '@/lib/whatsapp/send-message';
import { notifyShopifyEvent, type NotifyInput } from './notify';

const TEMPLATE = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_confirmed',
  category: 'Utility',
  language: 'en',
  body_text: 'Hi {{1}}, order {{2}} is confirmed.',
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
};

const EVENT_ROW = {
  is_enabled: true,
  template_name: 'order_confirmed',
  template_language: 'en',
  variable_mapping: {
    body: [
      { type: 'field', value: 'customer_first_name' },
      { type: 'field', value: 'order_number' },
    ],
  },
};

interface FakeState {
  eventRow: unknown;
  /** Rows the claim upsert returns; [] simulates a duplicate. */
  claimRows: { id: string }[];
  claims: Record<string, unknown>[];
  ledgerUpdates: Record<string, unknown>[];
  contactUpdates: Record<string, unknown>[];
  orderUpdates: Record<string, unknown>[];
}

function fakeDb(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: table === 'shopify_event_templates' ? state.eventRow : null,
          error: null,
        }),
        upsert: (row: Record<string, unknown>) => {
          state.claims.push(row);
          return { select: async () => ({ data: state.claimRows, error: null }) };
        },
        update: (patch: Record<string, unknown>) => {
          if (table === 'shopify_notifications') state.ledgerUpdates.push(patch);
          if (table === 'contacts') state.contactUpdates.push(patch);
          if (table === 'shopify_orders') state.orderUpdates.push(patch);
          return builder;
        },
        then: (resolve: (r: { data: null; error: null }) => unknown) =>
          resolve({ data: null, error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    eventRow: EVENT_ROW,
    claimRows: [{ id: 'ledger-1' }],
    claims: [],
    ledgerUpdates: [],
    contactUpdates: [],
    orderUpdates: [],
    ...overrides,
  };
}

const INPUT: NotifyInput = {
  event: 'order_created',
  dedupeKey: 'order_created:1001',
  orderId: '1001',
  fulfillmentId: null,
  orderName: '#1042',
  phone: '919876543210',
  customerName: 'Priya Nair',
  fields: { customer_first_name: 'Priya', order_number: '#1042' },
  webhookId: 'wh-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTemplateRow.mockResolvedValue({
    row: TEMPLATE,
    malformed: false,
    language: 'en',
  });
  mocks.resolveConversationByPhone.mockResolvedValue({
    conversationId: 'cv-1',
    contactId: 'ct-1',
    contactCreated: false,
  });
  mocks.sendMessageToConversation.mockResolvedValue({
    messageId: 'msg-1',
    whatsappMessageId: 'wamid.1',
  });
});

describe('notifyShopifyEvent', () => {
  it('does nothing and claims nothing when the update is switched off', async () => {
    for (const eventRow of [null, { ...EVENT_ROW, is_enabled: false }]) {
      const state = freshState({ eventRow });
      const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
      expect(outcome).toEqual({ status: 'disabled' });
      expect(state.claims).toEqual([]);
    }
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('sends nothing when another delivery already claimed the update', async () => {
    const state = freshState({ claimRows: [] });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
    expect(outcome).toEqual({ status: 'duplicate' });
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
    expect(state.ledgerUpdates).toEqual([]);
  });

  it('sends the mapped template as a bot and records the result', async () => {
    const state = freshState();
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);

    expect(outcome).toEqual({ status: 'sent', messageId: 'msg-1' });
    expect(state.claims[0]).toMatchObject({
      account_id: 'acct-1',
      event: 'order_created',
      dedupe_key: 'order_created:1001',
      status: 'pending',
    });
    expect(mocks.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_confirmed',
        templateLanguage: 'en',
        templateParams: ['Priya', '#1042'],
        templateMessageParams: { body: ['Priya', '#1042'] },
      },
      { senderType: 'bot', pauseActiveFlows: false }
    );
    expect(state.ledgerUpdates).toEqual([
      { status: 'sent', message_id: 'msg-1', whatsapp_message_id: 'wamid.1' },
    ]);
    expect(state.orderUpdates).toEqual([{ contact_id: 'ct-1' }]);
  });

  it('never passes a name to the resolver, and names only a new contact', async () => {
    const existing = freshState();
    await notifyShopifyEvent(fakeDb(existing), 'acct-1', INPUT);
    expect(mocks.resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      '919876543210'
    );
    expect(existing.contactUpdates).toEqual([]);

    mocks.resolveConversationByPhone.mockResolvedValue({
      conversationId: 'cv-2',
      contactId: 'ct-2',
      contactCreated: true,
    });
    const created = freshState();
    await notifyShopifyEvent(fakeDb(created), 'acct-1', INPUT);
    expect(created.contactUpdates).toEqual([{ name: 'Priya Nair' }]);
  });

  it('skips with a reason when the order has no phone', async () => {
    const state = freshState();
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', {
      ...INPUT,
      phone: null,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_phone' });
    expect(state.ledgerUpdates).toEqual([
      { status: 'skipped', reason: 'no_phone' },
    ]);
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('skips a template that is missing or not approved', async () => {
    mocks.resolveTemplateRow.mockResolvedValueOnce({
      row: null,
      malformed: false,
      language: 'en',
    });
    expect(
      await notifyShopifyEvent(fakeDb(freshState()), 'acct-1', INPUT)
    ).toEqual({ status: 'skipped', reason: 'template_not_found' });

    mocks.resolveTemplateRow.mockResolvedValueOnce({
      row: { ...TEMPLATE, status: 'PAUSED' },
      malformed: false,
      language: 'en',
    });
    expect(
      await notifyShopifyEvent(fakeDb(freshState()), 'acct-1', INPUT)
    ).toEqual({ status: 'skipped', reason: 'template_not_approved' });
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('skips when a mapped value is missing for this order', async () => {
    const outcome = await notifyShopifyEvent(fakeDb(freshState()), 'acct-1', {
      ...INPUT,
      fields: { order_number: '#1042' },
    });
    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'missing_variable:body_1:customer_first_name',
    });
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('records a failed send with its reason', async () => {
    mocks.sendMessageToConversation.mockRejectedValue(
      new SendMessageError('meta_error', 'Recipient not on WhatsApp', 502)
    );
    const state = freshState();
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
    expect(outcome).toEqual({
      status: 'failed',
      reason: 'meta_error: Recipient not on WhatsApp',
    });
    expect(state.ledgerUpdates).toEqual([
      { status: 'failed', reason: 'meta_error: Recipient not on WhatsApp' },
    ]);
  });
});
