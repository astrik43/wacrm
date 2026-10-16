import { describe, expect, it } from 'vitest';

import { dateRange, toCsv, type Transaction } from './transactions';

const ROW: Transaction = {
  id: 'c-1',
  whatsapp_message_id: 'wamid.1',
  recipient: '919029130001',
  status: 'delivered',
  pricing_category: 'utility',
  pricing_type: 'regular',
  billable: true,
  pricing_source: 'meta',
  sent_at: '2026-10-16T10:00:00.000Z',
  delivered_at: '2026-10-16T10:00:05.000Z',
  read_at: null,
  failed_at: null,
  error_code: null,
  error_title: null,
  created_at: '2026-10-16T10:00:00.000Z',
  amount_inr: 0.115,
  contact_name: 'Arun, "AS"',
  phone: '919029130001',
  template_name: 'order_delivered_utility',
  content_type: 'template',
  source: 'shopify',
  source_detail: 'delivered',
  order_name: '#EL1700',
  is_test: false,
};

describe('dateRange', () => {
  it('defaults to this month up to the end of today (UTC)', () => {
    expect(dateRange(null, null, new Date('2026-10-16T15:00:00Z'))).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-17T00:00:00.000Z',
    });
  });

  it('takes inclusive days and ignores malformed dates', () => {
    expect(dateRange('2026-09-01', '2026-09-30')).toEqual({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
    expect(
      dateRange('01/09/2026', 'x', new Date('2026-10-16T15:00:00Z')).from
    ).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('toCsv', () => {
  it('writes a header and one quoted, spreadsheet-safe line per row', () => {
    const csv = toCsv([
      ROW,
      { ...ROW, id: 'c-2', contact_name: '=HYPERLINK("x")', amount_inr: 0 },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Sent at \(UTC\),Recipient,Phone,Template/);
    expect(lines[1]).toContain('"Arun, ""AS"""');
    expect(lines[1]).toContain(',#EL1700,delivered,');
    expect(lines[1]).toContain(',0.1150,wamid.1');
    // A formula is neutralised, not executed by the spreadsheet.
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
