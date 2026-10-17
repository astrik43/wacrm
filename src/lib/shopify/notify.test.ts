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
import {
  deliverNotification,
  notifyShopifyEvent,
  type NotifyInput,
} from './notify';

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
  variant: 'all',
  step: 0,
  delay_minutes: 0,
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
  /** One row, several (per payment variant), or null for none. */
  eventRow: unknown;
  /** Rows the claim upsert returns; [] simulates a duplicate. */
  claimRows: { id: string }[];
  claims: Record<string, unknown>[];
  ledgerUpdates: Record<string, unknown>[];
  contactUpdates: Record<string, unknown>[];
  orderUpdates: Record<string, unknown>[];
  /** shopify_configs test-mode row; 'error' simulates a failed read. */
  testConfig?: { test_mode: boolean; test_phones: string[] } | 'error' | null;
  /** Messages already in the conversation (default 1: not empty). */
  messageCount?: number;
  conversationDeletes?: number;
}

function fakeDb(state: FakeState): SupabaseClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () =>
          table === 'shopify_configs' && state.testConfig === 'error'
            ? { data: null, error: { message: 'boom' } }
            : {
                data:
                  table === 'shopify_configs' ? (state.testConfig ?? null) : null,
                error: null,
              },
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
        delete: () => {
          if (table === 'conversations') {
            state.conversationDeletes = (state.conversationDeletes ?? 0) + 1;
          }
          return builder;
        },
        then: (
          resolve: (r: { data: unknown; error: null; count?: number }) => unknown
        ) =>
          resolve({
            data:
              table === 'shopify_event_templates'
                ? ([] as unknown[]).concat(state.eventRow ?? [])
                : null,
            error: null,
            ...(table === 'messages' ? { count: state.messageCount ?? 1 } : {}),
          }),
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
      {
        status: 'sent',
        message_id: 'msg-1',
        whatsapp_message_id: 'wamid.1',
        payload: null,
      },
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
      { status: 'skipped', reason: 'no_phone', payload: null },
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
      {
        status: 'failed',
        reason: 'meta_error: Recipient not on WhatsApp',
        payload: null,
      },
    ]);
    // The conversation already had messages: left alone.
    expect(state.conversationDeletes ?? 0).toBe(0);
  });

  it('removes the empty conversation a failed send left behind', async () => {
    mocks.sendMessageToConversation.mockRejectedValue(
      new SendMessageError(
        'meta_error',
        'WhatsApp provided number needs display name approval',
        502
      )
    );
    const state = freshState({ messageCount: 0 });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
    expect(outcome.status).toBe('failed');
    expect(state.conversationDeletes).toBe(1);
  });
});

describe('notifyShopifyEvent — COD and prepaid templates', () => {
  const COD_ROW = { ...EVENT_ROW, variant: 'cod', template_name: 'cod_confirm' };

  it("uses the payment mode's own template when it is switched on", async () => {
    const state = freshState({ eventRow: [EVENT_ROW, COD_ROW] });
    await notifyShopifyEvent(fakeDb(state), 'acct-1', {
      ...INPUT,
      paymentMode: 'cod',
    });
    expect(mocks.resolveTemplateRow).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'cod_confirm',
      'en'
    );
    expect(state.claims[0]).toMatchObject({ variant: 'cod' });
  });

  it('falls back to the all-orders template', async () => {
    for (const eventRow of [
      [EVENT_ROW, { ...COD_ROW, is_enabled: false }],
      [EVENT_ROW],
    ]) {
      mocks.resolveTemplateRow.mockClear();
      const state = freshState({ eventRow });
      await notifyShopifyEvent(fakeDb(state), 'acct-1', {
        ...INPUT,
        paymentMode: 'cod',
      });
      expect(mocks.resolveTemplateRow).toHaveBeenCalledWith(
        expect.anything(),
        'acct-1',
        'order_confirmed',
        'en'
      );
      expect(state.claims[0]).toMatchObject({ variant: 'all' });
    }
  });

  it('sends nothing to a prepaid order when only COD is set up', async () => {
    const state = freshState({ eventRow: [COD_ROW] });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', {
      ...INPUT,
      paymentMode: 'prepaid',
    });
    expect(outcome).toEqual({ status: 'disabled' });
    expect(state.claims).toEqual([]);
  });
});

describe('notifyShopifyEvent — delay', () => {
  it('parks a delayed update with what is needed to send it later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    try {
      const state = freshState({ eventRow: { ...EVENT_ROW, delay_minutes: 30 } });
      const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', {
        ...INPUT,
        paymentMode: 'cod',
      });

      expect(outcome).toEqual({
        status: 'scheduled',
        sendAt: '2026-10-13T10:30:00.000Z',
      });
      expect(state.claims[0]).toMatchObject({
        status: 'scheduled',
        send_at: '2026-10-13T10:30:00.000Z',
        payload: {
          phone: '919876543210',
          customerName: 'Priya Nair',
          fields: INPUT.fields,
          paymentMode: 'cod',
        },
      });
      expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
      expect(state.ledgerUpdates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait when there is nobody to send to', async () => {
    const state = freshState({ eventRow: { ...EVENT_ROW, delay_minutes: 30 } });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', {
      ...INPUT,
      phone: null,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_phone' });
    expect(state.claims[0]).toMatchObject({ status: 'pending', send_at: null });
  });

  it('a duplicate of a delayed update schedules nothing', async () => {
    const state = freshState({
      eventRow: { ...EVENT_ROW, delay_minutes: 30 },
      claimRows: [],
    });
    expect(await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT)).toEqual({
      status: 'duplicate',
    });
  });
});

describe('notifyShopifyEvent — follow-up messages', () => {
  const FEEDBACK_ROW = {
    ...EVENT_ROW,
    step: 1,
    delay_minutes: 15 * 1440,
    template_name: 'feedback_request',
  };

  it('sends the first message now and schedules the follow-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'));
    try {
      // Saved out of order on purpose: steps go first to last.
      const state = freshState({ eventRow: [FEEDBACK_ROW, EVENT_ROW] });
      const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
      expect(outcome).toEqual({ status: 'sent', messageId: 'msg-1' });
      expect(state.claims).toHaveLength(2);
      expect(state.claims[0]).toMatchObject({
        step: 0,
        dedupe_key: 'order_created:1001',
        status: 'pending',
      });
      expect(state.claims[1]).toMatchObject({
        step: 1,
        dedupe_key: 'order_created:1001#1',
        status: 'scheduled',
        send_at: '2026-10-28T10:00:00.000Z',
      });
      expect(mocks.sendMessageToConversation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a follow-up even when the first message is off', async () => {
    const state = freshState({
      eventRow: [{ ...EVENT_ROW, is_enabled: false }, FEEDBACK_ROW],
    });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
    expect(outcome).toMatchObject({ status: 'scheduled' });
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]).toMatchObject({ step: 1 });
  });

  it("uses only the payment mode's own messages when it has any", async () => {
    const state = freshState({
      eventRow: [
        EVENT_ROW,
        FEEDBACK_ROW,
        { ...EVENT_ROW, variant: 'cod', template_name: 'cod_confirm' },
      ],
    });
    await notifyShopifyEvent(fakeDb(state), 'acct-1', {
      ...INPUT,
      paymentMode: 'cod',
    });
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]).toMatchObject({ variant: 'cod', step: 0 });
  });
});

describe('notifyShopifyEvent — testing mode', () => {
  const TEST_ON = { test_mode: true, test_phones: ['919029130001'] };

  it('holds back a customer who is not a test number', async () => {
    const state = freshState({
      testConfig: TEST_ON,
      eventRow: [EVENT_ROW, { ...EVENT_ROW, step: 1, delay_minutes: 60 }],
    });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
    expect(outcome).toEqual({ status: 'skipped', reason: 'test_mode' });
    // The follow-up is not scheduled either.
    expect(state.claims.map((c) => c.status)).toEqual(['pending', 'pending']);
    expect(state.ledgerUpdates.map((u) => u.reason)).toEqual([
      'test_mode',
      'test_mode',
    ]);
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
  });

  it('sends to a test number as usual', async () => {
    const state = freshState({ testConfig: TEST_ON });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', {
      ...INPUT,
      phone: '919029130001',
    });
    expect(outcome.status).toBe('sent');
  });

  it('sends nothing when testing mode cannot be read', async () => {
    const state = freshState({ testConfig: 'error' });
    const outcome = await notifyShopifyEvent(fakeDb(state), 'acct-1', INPUT);
    expect(outcome).toEqual({ status: 'failed', reason: 'db_error' });
    expect(state.claims).toEqual([]);
  });

  it('holds back a message scheduled before testing mode was switched on', async () => {
    const state = freshState({ testConfig: TEST_ON });
    const outcome = await deliverNotification(
      fakeDb(state),
      'acct-1',
      'ledger-9',
      EVENT_ROW as never,
      { ...INPUT, orderId: '1001' }
    );
    expect(outcome).toEqual({ status: 'skipped', reason: 'test_mode' });
    expect(mocks.sendMessageToConversation).not.toHaveBeenCalled();
  });
});
