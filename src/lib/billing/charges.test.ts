import { describe, expect, it, vi } from 'vitest';

import {
  estimateChargeInr,
  parseStatusPricing,
  recordMessageStatus,
} from './charges';

function fakeDb(result: { error: { message: string } | null } | Error = { error: null }) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { db: { rpc } as never, rpc };
}

describe('parseStatusPricing', () => {
  it("normalises Meta's pricing object", () => {
    expect(
      parseStatusPricing({ billable: true, category: 'MARKETING', type: 'regular' })
    ).toEqual({ category: 'marketing', type: 'regular', billable: true });
  });

  it('gives nulls when pricing is missing or malformed', () => {
    for (const bad of [undefined, null, 'x', [], { billable: 'yes', category: 3 }]) {
      expect(parseStatusPricing(bad)).toEqual({
        category: null,
        type: null,
        billable: null,
      });
    }
  });
});

describe('estimateChargeInr', () => {
  it('charges a delivered or read billable message at its category rate', () => {
    expect(
      estimateChargeInr({ status: 'delivered', pricing_category: 'marketing', billable: true })
    ).toBe(0.8631);
    expect(
      estimateChargeInr({ status: 'read', pricing_category: 'utility', billable: true })
    ).toBe(0.115);
  });

  it('is free when not billable, not delivered, or a service reply', () => {
    expect(
      estimateChargeInr({ status: 'delivered', pricing_category: 'utility', billable: false })
    ).toBe(0);
    expect(
      estimateChargeInr({ status: 'sent', pricing_category: 'utility', billable: true })
    ).toBe(0);
    expect(
      estimateChargeInr({ status: 'failed', pricing_category: 'marketing', billable: true })
    ).toBe(0);
    expect(
      estimateChargeInr({ status: 'delivered', pricing_category: 'service', billable: true })
    ).toBe(0);
    expect(
      estimateChargeInr({ status: 'delivered', pricing_category: null, billable: null })
    ).toBe(0);
  });
});

describe('recordMessageStatus', () => {
  it('passes the status, time, pricing and failure reason to the upsert', async () => {
    const { db, rpc } = fakeDb();
    await recordMessageStatus(db, 'acct-1', {
      id: 'wamid.1',
      status: 'failed',
      timestamp: '1700000000',
      recipient_id: '919029130001',
      errors: [{ code: 131049, title: 'Not delivered' }],
    });
    expect(rpc).toHaveBeenCalledWith('record_message_status', {
      p_account_id: 'acct-1',
      p_message_id: 'wamid.1',
      p_recipient: '919029130001',
      p_status: 'failed',
      p_at: '2023-11-14T22:13:20.000Z',
      p_category: null,
      p_pricing_type: null,
      p_billable: null,
      p_error_code: 131049,
      p_error_title: 'Not delivered',
    });
  });

  it('ignores statuses it does not track and never throws', async () => {
    const { db, rpc } = fakeDb();
    await recordMessageStatus(db, 'acct-1', {
      id: 'wamid.1',
      status: 'deleted',
      timestamp: '1700000000',
    });
    expect(rpc).not.toHaveBeenCalled();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        recordMessageStatus(fakeDb(new Error('down')).db, 'acct-1', {
          id: 'wamid.2',
          status: 'sent',
          timestamp: '1700000000',
        })
      ).resolves.toBeUndefined();
      await expect(
        recordMessageStatus(fakeDb({ error: { message: 'nope' } }).db, 'acct-1', {
          id: 'wamid.3',
          status: 'sent',
          timestamp: '1700000000',
        })
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});
