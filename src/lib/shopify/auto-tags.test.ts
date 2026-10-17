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

import { abandonedCartTags, applyAutoTags, orderPlacedTags } from './auto-tags';

const TAG_IDS = new Map([
  ['order placed(cod)', 't-cod'],
  ['order placed(prepaid)', 't-prepaid'],
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
  it("tags an order with Interakt's payment tag and clears the abandoned cart", () => {
    expect(orderPlacedTags('cod')).toEqual({
      add: ['Order Placed(CoD)'],
      remove: ['Abandoned Cart'],
    });
    expect(orderPlacedTags('prepaid').add).toEqual(['Order Placed(Prepaid)']);
    expect(abandonedCartTags()).toEqual({ add: ['Abandoned Cart'], remove: [] });
  });
});

describe('applyAutoTags', () => {
  it('finds or creates the contact, adds the order tag and removes the abandoned cart', async () => {
    const { db, deletes } = fakeDb(['t-cart']);
    await applyAutoTags(db, 'acct-1', '919029130001', 'Arun', orderPlacedTags('prepaid'));

    expect(mocks.findOrCreate).toHaveBeenCalledWith(db, 'acct-1', 'user-1', {
      phone: '+919029130001',
      name: 'Arun',
    });
    // Only tags it may create are created; removals never create tags.
    expect(mocks.resolveTags).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ tagNames: ['Order Placed(Prepaid)'], canCreateTags: true })
    );
    expect(mocks.resolveTags).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ canCreateTags: false })
    );
    expect(deletes).toEqual([['t-cart']]);
    expect(mocks.addTag).toHaveBeenCalledWith({
      db,
      accountId: 'acct-1',
      contactId: 'ct-1',
      tagId: 't-prepaid',
    });
  });

  it('does not re-add a tag the contact already has', async () => {
    const { db, deletes } = fakeDb(['t-cart']);
    await applyAutoTags(db, 'acct-1', '919029130001', null, abandonedCartTags());
    expect(mocks.addTag).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it('does nothing without a phone and never throws', async () => {
    const { db } = fakeDb([]);
    await applyAutoTags(db, 'acct-1', null, null, orderPlacedTags('cod'));
    expect(mocks.findOrCreate).not.toHaveBeenCalled();

    mocks.findOrCreate.mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        applyAutoTags(db, 'acct-1', '919029130001', null, orderPlacedTags('cod'))
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
