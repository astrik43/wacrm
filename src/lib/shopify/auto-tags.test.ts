import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  findOrCreate: vi.fn(),
  resolveTags: vi.fn(),
  addTag: vi.fn(),
}));

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: mocks.audit,
  findOrCreateContact: mocks.findOrCreate,
}));
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: mocks.resolveTags,
}));
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: mocks.addTag,
}));

import {
  applyAutoTags,
  orderPlacedTags,
  shipmentStatusTag,
  statusTagChange,
} from './auto-tags';

const TAG_IDS = new Map([
  ['shipped', 't-shipped'],
  ['delivered', 't-delivered'],
  ['rto', 't-rto'],
  ['order placed cod', 't-cod'],
  ['abandoned cart', 't-cart'],
]);

function fakeDb(current: string[]) {
  const deletes: unknown[][] = [];
  const db = {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        delete: () => ({
          eq: () => ({
            in: async (_col: string, ids: string[]) => {
              deletes.push(ids);
              return { error: null };
            },
          }),
        }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: current.map((tag_id) => ({ tag_id })), error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, deletes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue('user-1');
  mocks.findOrCreate.mockResolvedValue({ id: 'ct-1', created: false });
  mocks.resolveTags.mockResolvedValue({ tagIdByKey: TAG_IDS, skippedNames: [] });
  mocks.addTag.mockResolvedValue({ added: true });
});

describe('tag rules', () => {
  it('keeps exactly one shipment-status tag', () => {
    const change = statusTagChange('delivered');
    expect(change.add).toEqual(['Delivered']);
    expect(change.remove).toHaveLength(5);
    expect(change.remove).not.toContain('Delivered');
  });

  it('marks a placed order with its lasting payment tag and clears old status and cart', () => {
    expect(orderPlacedTags('prepaid').add).toEqual(['Order placed Prepaid']);
    expect(orderPlacedTags('cod').add).toEqual(['Order placed COD']);
    const remove = orderPlacedTags('cod').remove;
    expect(remove).toEqual(expect.arrayContaining(['Delivered', 'RTO', 'Cancelled', 'Abandoned cart']));
    // The payment tags are never removed.
    expect(remove).not.toContain('Order placed COD');
    expect(remove).not.toContain('Order placed Prepaid');
  });

  it("maps Shopify's shipment statuses", () => {
    expect(shipmentStatusTag(null)).toBe('shipped');
    expect(shipmentStatusTag('in_transit')).toBe('shipped');
    expect(shipmentStatusTag('out_for_delivery')).toBe('out_for_delivery');
    expect(shipmentStatusTag('attempted_delivery')).toBe('attempted');
    expect(shipmentStatusTag('delivered')).toBe('delivered');
    expect(shipmentStatusTag('failure')).toBe('rto');
    expect(shipmentStatusTag('something_new')).toBeNull();
  });
});

describe('applyAutoTags', () => {
  it('finds or creates the contact, removes stale status tags and adds the new one', async () => {
    const { db, deletes } = fakeDb(['t-shipped', 't-cod']);
    await applyAutoTags(db, 'acct-1', '919029130001', 'Arun', statusTagChange('delivered'));

    expect(mocks.findOrCreate).toHaveBeenCalledWith(db, 'acct-1', 'user-1', {
      phone: '+919029130001',
      name: 'Arun',
    });
    // Only tags it may create are created; removals never create tags.
    expect(mocks.resolveTags).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ tagNames: ['Delivered'], canCreateTags: true })
    );
    expect(mocks.resolveTags).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ canCreateTags: false })
    );
    expect(deletes).toEqual([['t-shipped']]);
    expect(mocks.addTag).toHaveBeenCalledWith({
      db,
      accountId: 'acct-1',
      contactId: 'ct-1',
      tagId: 't-delivered',
    });
  });

  it('does not re-add a tag the contact already has', async () => {
    const { db, deletes } = fakeDb(['t-cart']);
    await applyAutoTags(db, 'acct-1', '919029130001', null, {
      add: ['Abandoned cart'],
      remove: [],
    });
    expect(mocks.addTag).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it('does nothing without a phone and never throws', async () => {
    const { db } = fakeDb([]);
    await applyAutoTags(db, 'acct-1', null, null, statusTagChange('rto'));
    expect(mocks.findOrCreate).not.toHaveBeenCalled();

    mocks.findOrCreate.mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        applyAutoTags(db, 'acct-1', '919029130001', null, statusTagChange('rto'))
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
