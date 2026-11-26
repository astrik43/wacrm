import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { prepareTemplateSend } from '@/lib/whatsapp/template-send-params';
import type { MessageTemplate } from '@/types';

import { McpToolError } from '../errors';
import type { AnyMcpTool } from '../types';
import { fakeCtx, type Tables } from './test-support/fake-db';
import { templatesTools } from './templates';

const tool = (name: string): AnyMcpTool => templatesTools.find((t) => t.name === name)!;
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function seed(): Tables {
  return {
    message_templates: [
      {
        id: UUID(1), account_id: 'acct-1', user_id: 'u', name: 'promo', language: 'en_US',
        category: 'Marketing', status: 'APPROVED', quality_score: 'GREEN',
        header_type: 'image', header_media_url: 'https://cdn.example.com/h.jpg',
        body_text: 'Hi {{1}}, use the code below.', sample_values: { body: ['Sam'] },
        created_at: '2026-01-02T00:00:00Z',
        buttons: [
          { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE10' },
          { type: 'URL', text: 'Shop', url: 'https://shop.example.com/{{1}}', example: 'sale' },
        ],
      },
      {
        id: UUID(2), account_id: 'acct-1', user_id: 'u', name: 'plain', language: 'en_US',
        category: 'Utility', status: 'REJECTED', body_text: 'Plain', created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: UUID(3), account_id: 'acct-2', user_id: 'u2', name: 'theirs', language: 'en_US',
        category: 'Utility', status: 'APPROVED', body_text: 'x', created_at: '2026-01-03T00:00:00Z',
      },
    ],
    contacts: [{ id: UUID(20), account_id: 'acct-1', name: 'Asha Rao' }],
  };
}

async function run(name: string, args: Record<string, unknown>, tables = seed(), dryRun = false) {
  const { ctx } = fakeCtx(tables, { dryRun });
  return tool(name).handler(ctx, args);
}
async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof McpToolError) return e.code;
    throw e;
  }
  return 'no_error';
}

afterEach(() => vi.unstubAllGlobals());

describe('templates tools', () => {
  it('uses the right scopes and tiers', () => {
    for (const t of templatesTools) {
      if (t.tier === 'read') expect(t.scope).toBe('templates:read');
      else expect(t.scope).toBe('templates:write');
    }
    expect(tool('delete_template').tier).toBe('destructive');
    expect(tool('preview_template').tier).toBe('read');
  });

  it('lists only this account\'s templates, with variable counts and button needs', async () => {
    const r = (await run('list_templates', { status: 'approved' })) as {
      items: { name: string; variable_count: number; buttons: { index: number; needs_value: unknown }[] }[];
    };
    expect(r.items.map((i) => i.name)).toEqual(['promo']);
    expect(r.items[0].variable_count).toBe(1);
    expect(r.items[0].buttons.map((b) => b.needs_value)).toEqual(['optional (defaults to the example code)', true]);
  });

  it('get_template refuses another account\'s id', async () => {
    expect(await code(run('get_template', { template_id: UUID(3) }))).toBe('not_found');
    const r = (await run('get_template', { template_id: UUID(1) })) as Record<string, unknown>;
    expect(r.sendable).toBe(true);
  });

  it('preview_template falls back to samples and returns the Meta components', async () => {
    const r = (await run('preview_template', { template_id: UUID(1) })) as {
      rendered: { body: string; buttons: { code?: string; url?: string }[] };
      meta_payload: { template: { components: unknown[] } };
    };
    expect(r.rendered.body).toBe('Hi Sam, use the code below.');
    expect(r.meta_payload.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/h.jpg' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Sam' }] },
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'SAVE10' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'sale' }] },
    ]);
  });

  it('preview_template fills the contact name and overrides the coupon', async () => {
    const r = (await run('preview_template', {
      template_id: UUID(1),
      contact_id: UUID(20),
      body_params: ['{{contact.first_name}}'],
      button_params: { '0': 'VIP20', '1': 'new' },
    })) as { rendered: { body: string; buttons: { code?: string }[] } };
    expect(r.rendered.body).toBe('Hi Asha, use the code below.');
    expect(r.rendered.buttons[0].code).toBe('VIP20');
    expect(await code(run('preview_template', { template_id: UUID(1), contact_id: UUID(99) }))).toBe('not_found');
  });

  it('the previewed components are exactly what sendTemplateMessage posts to Meta', async () => {
    const row = seed().message_templates[0] as unknown as MessageTemplate;
    const prepared = prepareTemplateSend(
      row,
      { body_params: ['Asha'], button_params: { '0': 'VIP20', '1': 'new' } },
      { language: 'en_US' }
    );
    const fetchMock = vi.fn(async () => Response.json({ messages: [{ id: 'wamid.x' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await sendTemplateMessage({
      phoneNumberId: 'pn',
      accessToken: 'token',
      to: '15550001111',
      templateName: row.name,
      language: 'en_US',
      template: row,
      messageParams: prepared.messageParams,
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.template).toEqual(prepared.metaTemplate);
  });

  it('submit_template validates, and dry run submits nothing', async () => {
    const t = seed();
    const bad = { name: 'Bad Name', category: 'Marketing', language: 'en_US', body_text: 'x' };
    expect(await code(run('submit_template', bad, t, true))).toBe('invalid_input');
    const ok = (await run('submit_template', { name: 'hello_there', category: 'Utility', language: 'en_US', body_text: 'Hello' }, t, true)) as Record<string, unknown>;
    expect(ok).toMatchObject({ valid: true, would_submit: true });
    expect(t.message_templates).toHaveLength(3);
    expect(await code(run('submit_template', { ...bad, name: 'fine', category: 'Marketing' } as never, t, true))).toBe('no_error');
  });

  it('delete_template is account-scoped and previews on dry run', async () => {
    expect(await code(run('delete_template', { template_id: UUID(3) }))).toBe('not_found');
    const t = seed();
    const r = (await run('delete_template', { template_id: UUID(2) }, t, true)) as { would_delete: { name: string } };
    expect(r.would_delete.name).toBe('plain');
    expect(t.message_templates).toHaveLength(3);
  });

  it('sync_templates dry run does not call Meta', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await run('sync_templates', {}, seed(), true)).toEqual({ would_sync: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
