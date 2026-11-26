import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1' }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

import { createFakeDb } from '@/lib/broadcasts/fake-db.testutil';

import { resolveAudience } from './use-broadcast-sending';

function client() {
  const fx = createFakeDb({
    contacts: [
      { id: 'c1', account_id: 'acc-1', name: 'Asha', phone: '+14155550101', is_staff: false },
      { id: 'c2', account_id: 'acc-1', name: 'Ben', phone: '+14155550102', is_staff: false },
      { id: 's1', account_id: 'acc-1', name: 'Staffer', phone: '+14155550103', is_staff: true },
    ],
    contact_tags: [
      { contact_id: 'c1', tag_id: 't1' },
      { contact_id: 's1', tag_id: 't1' },
    ],
    contact_custom_values: [
      { contact_id: 'c2', custom_field_id: 'f1', value: 'Pune' },
      { contact_id: 's1', custom_field_id: 'f1', value: 'Pune' },
    ],
  });
  const db = {
    ...fx.db,
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
  };
  return db as unknown as Parameters<typeof resolveAudience>[0];
}

const ids = (cs: { id: string }[]) => cs.map((c) => c.id).sort();

describe('dashboard audience resolution keeps staff out', () => {
  it('"All contacts" skips staff', async () => {
    expect(ids(await resolveAudience(client(), 'acc-1', { type: 'all' }))).toEqual(['c1', 'c2']);
  });

  it('a tag audience skips a staff contact that carries the tag', async () => {
    expect(ids(await resolveAudience(client(), 'acc-1', { type: 'tags', tagIds: ['t1'] }))).toEqual(['c1']);
  });

  it('a custom-field audience skips staff', async () => {
    const audience = { type: 'custom_field' as const, customField: { fieldId: 'f1', operator: 'is' as const, value: 'Pune' } };
    expect(ids(await resolveAudience(client(), 'acc-1', audience))).toEqual(['c2']);
  });

  it('a CSV that lists a staff number drops it and still creates new contacts', async () => {
    const audience = {
      type: 'csv' as const,
      csvContacts: [{ phone: '+14155550103' }, { phone: '+14155550101' }, { phone: '+14155550188', name: 'New' }],
    };
    const result = await resolveAudience(client(), 'acc-1', audience);
    expect(result.map((c) => c.name).sort()).toEqual(['Asha', 'New']);
  });
});
