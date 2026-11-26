// Team members (contacts.is_staff) get no order updates, cart reminders
// or customer tags.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  resolveConversation: vi.fn(),
  resolveTemplate: vi.fn(),
  findOrCreate: vi.fn(),
  audit: vi.fn(),
  resolveTags: vi.fn(),
  addTag: vi.fn(),
}));

vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: mocks.send,
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mocks.resolveConversation,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({ resolveTemplateRow: mocks.resolveTemplate }));
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: mocks.audit,
  findOrCreateContact: mocks.findOrCreate,
}));
vi.mock('@/lib/contacts/resolve-import-tags', () => ({ resolveImportTagIds: mocks.resolveTags }));
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: mocks.addTag }));

import { fakeDb } from '@/lib/ops/testing';

import { abandonedCartTags, applyAutoTags, orderRtoTags } from './auto-tags';
import { deliverNotification } from './notify';

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const STAFF_PHONE = '910000000001';
const CUSTOMER_PHONE = '910000000002';

const eventRow = {
  variant: 'all' as const,
  step: 0,
  is_enabled: true,
  template_name: 'order_confirmed',
  template_language: 'en',
  variable_mapping: { body: [] },
  delay_minutes: 0,
};

function world() {
  return fakeDb({
    contacts: [
      { id: 'c1', account_id: ACCOUNT, phone: `+${STAFF_PHONE}`, is_staff: true },
      { id: 'c2', account_id: ACCOUNT, phone: `+${CUSTOMER_PHONE}`, is_staff: false },
    ],
    shopify_notifications: [{ id: 'ledger-1' }],
    shopify_configs: [{ account_id: ACCOUNT, test_mode: false, test_phones: [] }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue('u1');
  mocks.findOrCreate.mockResolvedValue({ id: 'c2' });
  mocks.resolveTags.mockResolvedValue({ tagIdByKey: new Map([['order rto', 't']]), skippedNames: [] });
});

describe('deliverNotification', () => {
  it('skips a staff contact and records why', async () => {
    const { db, tables } = world();
    const out = await deliverNotification(db, ACCOUNT, 'ledger-1', eventRow, {
      event: 'order_confirmed' as never,
      orderId: null,
      phone: STAFF_PHONE,
      customerName: null,
      fields: {} as never,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'staff_contact' });
    expect(tables.shopify_notifications[0]).toMatchObject({ status: 'skipped', reason: 'staff_contact' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.resolveConversation).not.toHaveBeenCalled();
  });

  it('lets a customer through to the normal checks', async () => {
    const { db } = world();
    mocks.resolveTemplate.mockResolvedValue({ row: null, malformed: false, language: 'en' });
    const out = await deliverNotification(db, ACCOUNT, 'ledger-1', eventRow, {
      event: 'order_confirmed' as never,
      orderId: null,
      phone: CUSTOMER_PHONE,
      customerName: null,
      fields: {} as never,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'template_not_found' });
  });
});

describe('applyAutoTags', () => {
  it('adds no customer tags to a staff contact and does not create one', async () => {
    const { db } = world();
    await applyAutoTags(db, ACCOUNT, STAFF_PHONE, null, orderRtoTags());
    await applyAutoTags(db, ACCOUNT, STAFF_PHONE, null, abandonedCartTags());
    expect(mocks.findOrCreate).not.toHaveBeenCalled();
    expect(mocks.addTag).not.toHaveBeenCalled();
  });
});
