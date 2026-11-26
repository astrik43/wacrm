import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  resolveConversation: vi.fn(),
  audit: vi.fn(),
  resolveTags: vi.fn(),
  addTag: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: mocks.send,
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mocks.resolveConversation,
}));
vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId: mocks.audit }));
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: mocks.resolveTags,
}));
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: mocks.addTag }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: mocks.dispatch }));

import { handleNdrReply, maybeSendNdr, parseNdrAnswer } from './ndr';
import { fakeDb, type Tables } from './testing';

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const CONTACT = 'c0000000-0000-4000-8000-000000000001';
const PHONE = '910000000001';

function world(over: Partial<Tables> = {}): Tables {
  return {
    ops_settings: [
      {
        account_id: ACCOUNT,
        ndr_enabled: true,
        ndr_template_name: 'ndr_notice',
        ndr_template_language: 'en',
      },
    ],
    message_templates: [
      {
        id: 't1',
        user_id: 'u1',
        account_id: ACCOUNT,
        name: 'ndr_notice',
        language: 'en',
        status: 'APPROVED',
        body_text: 'We could not deliver order {{1}}.',
      },
    ],
    shopify_configs: [{ account_id: ACCOUNT, test_mode: false, test_phones: [] }],
    contacts: [],
    ndr_requests: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConversation.mockResolvedValue({
    conversationId: 'conv-1',
    contactId: CONTACT,
    contactCreated: false,
  });
  mocks.send.mockResolvedValue({ messageId: 'm-1', whatsappMessageId: 'w-1' });
  mocks.audit.mockResolvedValue('u1');
  mocks.resolveTags.mockResolvedValue({
    tagIdByKey: new Map([
      ['ndr: reattempt', 'tag-re'],
      ['ndr: reschedule', 'tag-rs'],
    ]),
    skippedNames: [],
  });
  mocks.addTag.mockResolvedValue({ added: true, dispatched: true });
});

describe('parseNdrAnswer', () => {
  it('reads 1 and 2, and button keywords', () => {
    expect(parseNdrAnswer('1')).toBe('reattempt');
    expect(parseNdrAnswer(' 2. ')).toBe('new_time');
    expect(parseNdrAnswer('ndr_reattempt')).toBe('reattempt');
    expect(parseNdrAnswer(null, 'Reschedule')).toBe('new_time');
  });
  it('leaves free text for a person', () => {
    expect(parseNdrAnswer('please call me')).toBeNull();
    expect(parseNdrAnswer('12')).toBeNull();
  });
});

describe('maybeSendNdr', () => {
  it('is OFF by default (no settings row): nothing is sent or claimed', async () => {
    const { db, tables } = fakeDb(world({ ops_settings: [] }));
    const out = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(out).toEqual({ status: 'disabled' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(tables.ndr_requests).toHaveLength(0);
  });

  it('sends the template with the order number, once per order', async () => {
    const { db, tables } = fakeDb(world());
    const first = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(first.status).toBe('sent');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][2]).toMatchObject({
      conversationId: 'conv-1',
      messageType: 'template',
      templateName: 'ndr_notice',
      templateParams: ['#EL1'],
      templateMessageParams: { body: ['#EL1'] },
    });
    expect(tables.ndr_requests[0]).toMatchObject({
      order_name: '#EL1',
      contact_id: CONTACT,
      state: 'sent',
    });

    const second = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(second).toEqual({ status: 'duplicate' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(tables.ndr_requests).toHaveLength(1);
  });

  it('skips staff contacts', async () => {
    const { db } = fakeDb(
      world({ contacts: [{ id: CONTACT, account_id: ACCOUNT, phone: `+${PHONE}`, is_staff: true }] })
    );
    const out = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(out).toEqual({ status: 'skipped', reason: 'staff_contact' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('honours Shopify test mode', async () => {
    const { db } = fakeDb(
      world({ shopify_configs: [{ account_id: ACCOUNT, test_mode: true, test_phones: ['919999999999'] }] })
    );
    const blocked = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(blocked).toEqual({ status: 'skipped', reason: 'test_mode' });
    const allowed = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL2', phone: '919999999999' });
    expect(allowed.status).toBe('sent');
  });

  it('does not send with an unapproved template', async () => {
    const t = world();
    (t.message_templates[0] as Record<string, unknown>).status = 'PENDING';
    const { db, tables } = fakeDb(t);
    const out = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(out).toEqual({ status: 'skipped', reason: 'template_not_approved' });
    expect(tables.ndr_requests).toHaveLength(0);
  });

  it('releases the claim when the send fails so a later NDR can retry', async () => {
    mocks.send.mockRejectedValueOnce(new Error('meta down'));
    const { db, tables } = fakeDb(world({ messages: [], conversations: [] }));
    const out = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(out.status).toBe('failed');
    expect(tables.ndr_requests).toHaveLength(0);
    const retry = await maybeSendNdr(db, ACCOUNT, { orderName: '#EL1', phone: PHONE });
    expect(retry.status).toBe('sent');
  });
});

describe('handleNdrReply', () => {
  const open = (extra: Record<string, unknown> = {}) => ({
    id: 'n1',
    account_id: ACCOUNT,
    contact_id: CONTACT,
    order_name: '#EL1',
    state: 'sent',
    sent_at: new Date().toISOString(),
    ...extra,
  });

  it('records "1", tags the contact and emits ndr.reply with the order number', async () => {
    const { db, tables } = fakeDb(world({ ndr_requests: [open()] }));
    const handled = await handleNdrReply(db, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      text: '1',
      interactiveReplyId: null,
    });
    expect(handled).toBe(true);
    expect(tables.ndr_requests[0]).toMatchObject({ state: 'answered', answer: 'reattempt' });
    expect(mocks.addTag).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, contactId: CONTACT, tagId: 'tag-re' })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith(
      db,
      ACCOUNT,
      'ndr.reply',
      expect.objectContaining({ order_number: '#EL1', answer: 'reattempt' })
    );
  });

  it('matches a button reply for "2" and tags NDR: reschedule', async () => {
    const { db, tables } = fakeDb(world({ ndr_requests: [open()] }));
    await handleNdrReply(db, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      text: 'New time',
      interactiveReplyId: '2',
    });
    expect(tables.ndr_requests[0]).toMatchObject({ state: 'answered', answer: 'new_time' });
    expect(mocks.addTag).toHaveBeenCalledWith(expect.objectContaining({ tagId: 'tag-rs' }));
  });

  it('keeps a free-text reply open for a person and does not tag', async () => {
    const { db, tables } = fakeDb(world({ ndr_requests: [open()] }));
    const handled = await handleNdrReply(db, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      text: 'please leave it with the neighbour',
      interactiveReplyId: null,
    });
    expect(handled).toBe(true);
    expect(tables.ndr_requests[0]).toMatchObject({ state: 'sent', answer: 'other' });
    expect(mocks.addTag).not.toHaveBeenCalled();
  });

  it('ignores contacts with no open NDR and expires stale ones', async () => {
    const { db, tables } = fakeDb(
      world({
        ndr_requests: [open({ sent_at: new Date(Date.now() - 8 * 86400_000).toISOString() })],
      })
    );
    const call = { accountId: ACCOUNT, contactId: CONTACT, text: '1', interactiveReplyId: null };
    expect(await handleNdrReply(db, call)).toBe(false);
    expect(tables.ndr_requests[0].state).toBe('expired');
    expect(await handleNdrReply(db, { ...call, contactId: 'other' })).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not touch another account's NDR", async () => {
    const { db } = fakeDb(world({ ndr_requests: [open({ account_id: 'someone-else' })] }));
    const handled = await handleNdrReply(db, {
      accountId: ACCOUNT,
      contactId: CONTACT,
      text: '1',
      interactiveReplyId: null,
    });
    expect(handled).toBe(false);
  });
});
