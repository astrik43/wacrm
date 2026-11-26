import { describe, expect, it } from 'vitest';

import { AudienceError, resolveServerAudience } from './audience';
import { createFakeDb } from './fake-db.testutil';

const ACC = 'acc-1';
const OTHER = 'acc-2';

function seed() {
  return createFakeDb({
    contacts: [
      { id: 'c1', account_id: ACC, name: 'Asha', phone: '+14155550101', is_staff: false },
      { id: 'c2', account_id: ACC, name: 'Ben', phone: '+14155550102', is_staff: false },
      { id: 's1', account_id: ACC, name: 'Staffer', phone: '+14155550103', is_staff: true },
      { id: 'x1', account_id: OTHER, name: 'Outsider', phone: '+14155550104', is_staff: false },
    ],
    tags: [
      { id: 't1', account_id: ACC, name: 'vip' },
      { id: 't2', account_id: ACC, name: 'late' },
      { id: 'tx', account_id: OTHER, name: 'other' },
    ],
    contact_tags: [
      { contact_id: 'c1', tag_id: 't1' },
      { contact_id: 'c2', tag_id: 't1' },
      { contact_id: 's1', tag_id: 't1' },
      { contact_id: 'c2', tag_id: 't2' },
      { contact_id: 'x1', tag_id: 'tx' },
    ],
    custom_fields: [
      { id: 'f1', account_id: ACC, field_name: 'city' },
      { id: 'fx', account_id: OTHER, field_name: 'city' },
    ],
    contact_custom_values: [
      { contact_id: 'c1', custom_field_id: 'f1', value: 'Pune' },
      { contact_id: 's1', custom_field_id: 'f1', value: 'Pune' },
      { contact_id: 'c2', custom_field_id: 'f1', value: 'Delhi' },
    ],
  });
}

const ids = (r: { contacts: { id: string }[] }) => r.contacts.map((c) => c.id).sort();

describe('resolveServerAudience', () => {
  it('"all" is this account\'s customers only, never staff', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(db, ACC, { type: 'all' }, { cap: 100 });
    expect(ids(r)).toEqual(['c1', 'c2']);
  });

  it('tags: any-of, staff dropped and counted, other accounts never seen', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(db, ACC, { type: 'tags', tagIds: ['t1'] }, { cap: 100 });
    expect(ids(r)).toEqual(['c1', 'c2']);
    expect(r.staffExcluded).toBe(1);
  });

  it('exclude tags subtract from the audience', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(
      db,
      ACC,
      { type: 'tags', tagIds: ['t1'], excludeTagIds: ['t2'] },
      { cap: 100 }
    );
    expect(ids(r)).toEqual(['c1']);
  });

  it("rejects another account's tag", async () => {
    const { db } = seed();
    await expect(
      resolveServerAudience(db, ACC, { type: 'tags', tagIds: ['tx'] }, { cap: 100 })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      resolveServerAudience(db, ACC, { type: 'all', excludeTagIds: ['tx'] }, { cap: 100 })
    ).rejects.toBeInstanceOf(AudienceError);
  });

  it('custom field filters, drops staff, and rejects a foreign field', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(
      db,
      ACC,
      { type: 'custom_field', customField: { fieldId: 'f1', operator: 'is', value: 'Pune' } },
      { cap: 100 }
    );
    expect(ids(r)).toEqual(['c1']);
    expect(r.staffExcluded).toBe(1);
    await expect(
      resolveServerAudience(
        db,
        ACC,
        { type: 'custom_field', customField: { fieldId: 'fx', operator: 'is', value: 'Pune' } },
        { cap: 100 }
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('explicit contact ids: staff dropped, foreign id is not_found', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(db, ACC, { type: 'contacts', contactIds: ['c1', 's1'] }, { cap: 100 });
    expect(ids(r)).toEqual(['c1']);
    expect(r.staffExcluded).toBe(1);
    await expect(
      resolveServerAudience(db, ACC, { type: 'contacts', contactIds: ['c1', 'x1'] }, { cap: 100 })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('phone list: matches by number, skips staff, counts unknown and invalid numbers', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(
      db,
      ACC,
      { type: 'phones', phones: ['+1 415 555 0101', '+14155550103', '+14155550199', 'abc12'] },
      { cap: 100 }
    );
    expect(ids(r)).toEqual(['c1']);
    expect(r.staffExcluded).toBe(1);
    expect(r.unmatchedPhones).toBe(1);
    expect(r.invalidPhones).toBe(1);
  });

  it('reports when the audience exceeds the cap', async () => {
    const { db } = seed();
    const r = await resolveServerAudience(db, ACC, { type: 'all' }, { cap: 1 });
    expect(r.contacts).toHaveLength(1);
    expect(r.capped).toBe(true);
  });
});
