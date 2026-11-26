import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ contact: null as unknown, customValues: [] as unknown[] }));

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acc-1' }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => Promise.resolve({ data: mocks.customValues }),
        limit: () => q,
        maybeSingle: () => Promise.resolve({ data: table === 'contacts' ? mocks.contact : null }),
      };
      return q;
    },
  }),
}));

import type { MessageTemplate } from '@/types';
import { sendTestMessage } from './use-broadcast-sending';

const TEMPLATE = {
  name: 'diwali_offer',
  language: 'en',
  header_type: 'image',
} as MessageTemplate;
const VARIABLES = {
  '1': { type: 'field' as const, value: 'name' },
  '2': { type: 'custom_field' as const, value: 'cf-city' },
  '3': { type: 'static' as const, value: 'DIWALI20' },
};

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.contact = null;
  mocks.customValues = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

function sentBody() {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe('sendTestMessage', () => {
  it("fills variables from the number's contact and sends one message", async () => {
    mocks.contact = { id: 'c-1', name: 'Priya', phone: '+919876543210' };
    mocks.customValues = [{ contact_id: 'c-1', custom_field_id: 'cf-city', value: 'Pune' }];
    reply(200, { results: [{ phone: '919876543210', status: 'sent' }] });

    const result = await sendTestMessage({
      template: TEMPLATE,
      variables: VARIABLES,
      headerMediaUrl: ' https://cdn.example.com/a.jpg ',
      phone: '919876543210',
    });

    expect(result).toEqual({ ok: true, contactFound: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/whatsapp/broadcast');
    expect(sentBody()).toEqual({
      recipients: [
        {
          phone: '919876543210',
          params: ['Priya', 'Pune', 'DIWALI20'],
          messageParams: { headerMediaUrl: 'https://cdn.example.com/a.jpg' },
        },
      ],
      template_name: 'diwali_offer',
      template_language: 'en',
    });
  });

  it('uses "Test" for the name when the number is not a contact', async () => {
    reply(200, { results: [{ phone: '919000000001', status: 'sent' }] });
    const result = await sendTestMessage({
      template: { ...TEMPLATE, header_type: 'text' } as MessageTemplate,
      variables: VARIABLES,
      phone: '919000000001',
    });
    expect(result).toEqual({ ok: true, contactFound: false });
    expect(sentBody().recipients).toEqual([
      { phone: '919000000001', params: ['Test', '', 'DIWALI20'] },
    ]);
  });

  it("reports Meta's error for the number", async () => {
    reply(200, {
      results: [{ phone: '919000000001', status: 'failed', error: 'Invalid parameter' }],
    });
    const result = await sendTestMessage({ template: TEMPLATE, variables: {}, phone: '919000000001' });
    expect(result).toEqual({ ok: false, error: 'Invalid parameter' });
  });

  it('reports a refused request', async () => {
    reply(429, { error: 'Too many requests' });
    const result = await sendTestMessage({ template: TEMPLATE, variables: {}, phone: '919000000001' });
    expect(result).toEqual({ ok: false, error: 'Too many requests' });
  });

  it('sends nothing without a number', async () => {
    const result = await sendTestMessage({ template: TEMPLATE, variables: {}, phone: ' - ' });
    expect(result).toEqual({ ok: false, error: 'Enter a phone number' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
