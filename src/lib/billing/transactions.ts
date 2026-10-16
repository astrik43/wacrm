// ============================================================
// Pure helpers for GET /api/billing/transactions: row shapes, the
// date range a request covers, and the CSV export.
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ChargeRow {
  id: string;
  whatsapp_message_id: string;
  recipient: string | null;
  status: string;
  pricing_category: string | null;
  pricing_type: string | null;
  billable: boolean | null;
  pricing_source: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  error_code: number | null;
  error_title: string | null;
  created_at: string;
}

export interface Transaction extends ChargeRow {
  amount_inr: number;
  contact_name: string | null;
  phone: string | null;
  template_name: string | null;
  content_type: string | null;
  source: 'shopify' | 'broadcast' | 'automation' | 'inbox' | 'other';
  source_detail: string | null;
  order_name: string | null;
  is_test: boolean;
}

/** [from, to) as ISO timestamps (UTC days), defaulting to this month. */
export function dateRange(
  fromParam: string | null,
  toParam: string | null,
  now = new Date()
): { from: string; to: string } {
  const from =
    fromParam && DATE_RE.test(fromParam)
      ? new Date(`${fromParam}T00:00:00Z`)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const toDay =
    toParam && DATE_RE.test(toParam) ? new Date(`${toParam}T00:00:00Z`) : now;
  const to = new Date(
    Date.UTC(toDay.getUTCFullYear(), toDay.getUTCMonth(), toDay.getUTCDate() + 1)
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Transaction[]): string {
  const header = [
    'Sent at (UTC)',
    'Recipient',
    'Phone',
    'Template',
    'Source',
    'Source detail',
    'Order',
    'Status',
    'Delivered at (UTC)',
    'Read at (UTC)',
    'Error',
    'Meta category',
    'Pricing type',
    'Billable',
    'Pricing source',
    'Estimated amount (INR, excl. GST)',
    'WhatsApp message id',
  ];
  const lines = rows.map((r) =>
    [
      r.sent_at ?? r.created_at,
      r.contact_name,
      r.phone,
      r.template_name ?? (r.content_type ? `(${r.content_type})` : ''),
      r.source,
      r.source_detail,
      r.order_name,
      r.status,
      r.delivered_at,
      r.read_at,
      r.error_code ? `${r.error_code} ${r.error_title ?? ''}`.trim() : '',
      r.pricing_category,
      r.pricing_type,
      r.billable === null ? '' : r.billable ? 'yes' : 'no',
      r.pricing_source,
      r.amount_inr.toFixed(4),
      r.whatsapp_message_id,
    ]
      .map(csvCell)
      .join(',')
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

