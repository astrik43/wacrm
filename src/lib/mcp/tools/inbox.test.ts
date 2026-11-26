import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: send,
}));

import { McpToolError } from '../errors';
import type { AnyMcpTool } from '../types';
import { inboxTools } from './inbox';
import { fakeCtx, type Tables } from './test-support/fake-db';

const tool = (name: string): AnyMcpTool => {
  const t = inboxTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CONV = UUID(1);
const OTHER_CONV = UUID(2);
const CONTACT = UUID(10);

function seed(over: Partial<Tables> = {}): Tables {
  return {
    contacts: [
      { id: CONTACT, account_id: 'acct-1', name: 'Asha Rao' },
      { id: UUID(11), account_id: 'acct-2', name: 'Other' },
    ],
    conversations: [
      {
        id: CONV, account_id: 'acct-1', contact_id: CONTACT, status: 'open',
        assigned_agent_id: null, unread_count: 3, last_message_text: 'hi',
        last_message_at: hoursAgo(1), created_at: hoursAgo(5),
      },
      {
        id: OTHER_CONV, account_id: 'acct-2', contact_id: UUID(11), status: 'open',
        assigned_agent_id: null, unread_count: 1, last_message_text: 'x',
        last_message_at: hoursAgo(1), created_at: hoursAgo(5),
      },
    ],
    messages: [
      { id: UUID(100), conversation_id: CONV, sender_type: 'customer', content_type: 'text', content_text: 'hello', status: 'delivered', created_at: hoursAgo(2), message_id: 'wamid.1' },
      { id: UUID(101), conversation_id: CONV, sender_type: 'agent', content_type: 'image', content_text: null, media_url: 'https://cdn.example.com/a.jpg', media_type: 'image/jpeg', status: 'sent', created_at: hoursAgo(1), message_id: 'wamid.2' },
      { id: UUID(102), conversation_id: OTHER_CONV, sender_type: 'customer', content_type: 'text', content_text: 'secret', status: 'delivered', created_at: hoursAgo(1), message_id: 'wamid.3' },
    ],
    message_reactions: [
      { message_id: UUID(100), conversation_id: CONV, emoji: '👍', actor_type: 'agent' },
    ],
    profiles: [
      { user_id: UUID(50), account_id: 'acct-1' },
      { user_id: UUID(51), account_id: 'acct-2' },
    ],
    quick_replies: [
      { id: UUID(60), account_id: 'acct-1', title: 'Hi', kind: 'text', content_text: 'Hello!', created_at: hoursAgo(1) },
      { id: UUID(61), account_id: 'acct-2', title: 'Theirs', kind: 'text', content_text: 'x', created_at: hoursAgo(1) },
    ],
    message_templates: [
      {
        id: UUID(70), account_id: 'acct-1', user_id: 'u', name: 'order_update', language: 'en_US',
        category: 'Utility', status: 'APPROVED', body_text: 'Hi {{1}}, order {{2}} shipped.',
        buttons: [{ type: 'URL', text: 'Track', url: 'https://shop.example.com/t/{{1}}', example: 'abc' }],
      },
      {
        id: UUID(71), account_id: 'acct-1', user_id: 'u', name: 'pending_one', language: 'en_US',
        category: 'Marketing', status: 'PENDING', body_text: 'Hello',
      },
    ],
    ...over,
  };
}

async function run(name: string, args: Record<string, unknown>, tables: Tables, dryRun = false) {
  const { ctx } = fakeCtx(tables, { dryRun });
  return tool(name).handler(ctx, args);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof McpToolError) return e.code;
    throw e;
  }
  return 'no_error';
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ messageId: 'msg-1', whatsappMessageId: 'wamid.new' });
});

describe('scopes and tiers', () => {
  it('uses :read scopes for reads, :write/:send for the rest', () => {
    for (const t of inboxTools) {
      if (t.tier === 'read') expect(t.scope).toMatch(/:read$/);
      else expect(t.scope).toMatch(/:(write|send)$/);
    }
    expect(tool('send_text').scope).toBe('messages:send');
    expect(tool('delete_quick_reply').tier).toBe('destructive');
  });
});

describe('reads', () => {
  it('lists only this account\'s conversations, filtered, without phone numbers', async () => {
    const r = (await run('list_conversations_filtered', { unread_only: true }, seed())) as {
      items: Record<string, unknown>[];
    };
    expect(r.items.map((i) => i.conversation_id)).toEqual([CONV]);
    expect(r.items[0].contact_name).toBe('Asha Rao');
    expect(JSON.stringify(r)).not.toMatch(/phone/);
  });

  it('reads a thread with media and reactions, and refuses another account\'s conversation', async () => {
    const r = (await run('get_conversation_thread', { conversation_id: CONV }, seed())) as {
      messages: { message_id: string; media: { url: string } | null; reactions: unknown[]; direction: string }[];
      reply_window: { open: boolean };
    };
    expect(r.messages.map((m) => m.message_id)).toEqual([UUID(100), UUID(101)]);
    expect(r.messages[1].media?.url).toBe('https://cdn.example.com/a.jpg');
    expect(r.messages[0].reactions).toHaveLength(1);
    expect(r.messages[0].direction).toBe('inbound');
    expect(r.reply_window.open).toBe(true);
    expect(await code(run('get_conversation_thread', { conversation_id: OTHER_CONV }, seed()))).toBe('not_found');
  });

  it('reports the 24h window deadline', async () => {
    const r = (await run('check_reply_window', { conversation_id: CONV }, seed())) as Record<string, unknown>;
    expect(r.can_send_free_text).toBe(true);
    expect(typeof r.expires_at).toBe('string');
    const closed = seed();
    closed.messages[0].created_at = hoursAgo(30);
    const c = (await run('check_reply_window', { conversation_id: CONV }, closed)) as Record<string, unknown>;
    expect(c.must_use_template).toBe(true);
  });

  it('returns media info for a public url and refuses another account\'s message', async () => {
    const r = (await run('get_media_info', { message_id: UUID(101) }, seed())) as Record<string, unknown>;
    expect(r).toMatchObject({ fetchable: true, mime_type: 'image/jpeg', url: 'https://cdn.example.com/a.jpg' });
    expect(await code(run('get_media_info', { message_id: UUID(102) }, seed()))).toBe('not_found');
  });
});

describe('conversation management', () => {
  it('assigns to a member of the account only', async () => {
    const t = seed();
    await run('assign_conversation', { conversation_id: CONV, agent_id: UUID(50) }, t);
    expect(t.conversations[0].assigned_agent_id).toBe(UUID(50));
    expect(await code(run('assign_conversation', { conversation_id: CONV, agent_id: UUID(51) }, seed()))).toBe('not_found');
    expect(await code(run('assign_conversation', { conversation_id: OTHER_CONV, agent_id: UUID(50) }, seed()))).toBe('not_found');
  });

  it('dry run changes nothing', async () => {
    const t = seed();
    const r = (await run('set_conversation_status', { conversation_id: CONV, status: 'closed' }, t, true)) as Record<string, unknown>;
    expect(r.would_change).toBe(true);
    expect(t.conversations[0].status).toBe('open');
    await run('set_conversation_status', { conversation_id: CONV, status: 'closed' }, t);
    expect(t.conversations[0].status).toBe('closed');
  });

  it('marks read', async () => {
    const t = seed();
    await run('mark_conversation_read', { conversation_id: CONV }, t);
    expect(t.conversations[0].unread_count).toBe(0);
  });
});

describe('quick replies', () => {
  it('lists, validates, creates and refuses another account\'s row', async () => {
    const list = (await run('list_quick_replies', {}, seed())) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    expect(await code(run('create_quick_reply', { title: 'x', kind: 'text' }, seed()))).toBe('invalid_input');
    const t = seed();
    await run('create_quick_reply', { title: 'New', kind: 'text', content_text: 'yo' }, t);
    expect(t.quick_replies).toHaveLength(3);
    expect(await code(run('update_quick_reply', { quick_reply_id: UUID(61), title: 'z' }, seed()))).toBe('not_found');
    expect(await code(run('delete_quick_reply', { quick_reply_id: UUID(61) }, seed()))).toBe('not_found');
    const t2 = seed();
    await run('delete_quick_reply', { quick_reply_id: UUID(60) }, t2);
    expect(t2.quick_replies).toHaveLength(1);
  });
});

describe('send_text', () => {
  it('sends inside the window through the shared send core', async () => {
    const r = (await run('send_text', { conversation_id: CONV, text: 'hello there' }, seed())) as Record<string, unknown>;
    expect(r).toMatchObject({ sent: true, message_id: 'msg-1' });
    expect(send).toHaveBeenCalledWith(expect.anything(), 'acct-1', expect.objectContaining({
      conversationId: CONV, messageType: 'text', contentText: 'hello there',
    }));
  });

  it('refuses outside the 24h window', async () => {
    const t = seed();
    t.messages[0].created_at = hoursAgo(25);
    expect(await code(run('send_text', { conversation_id: CONV, text: 'hi' }, t))).toBe('outside_24h_window');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses another account\'s conversation', async () => {
    expect(await code(run('send_text', { conversation_id: OTHER_CONV, text: 'hi' }, seed()))).toBe('not_found');
    expect(send).not.toHaveBeenCalled();
  });

  it('dry run returns the Meta payload and sends nothing', async () => {
    const r = (await run('send_text', { conversation_id: CONV, text: 'hi' }, seed(), true)) as {
      meta_payload: Record<string, unknown>;
    };
    expect(r.meta_payload).toMatchObject({ type: 'text', text: { body: 'hi' } });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('send_template', () => {
  const base = { conversation_id: CONV, template_name: 'order_update', body_params: ['Asha', 'A12'] };

  it('refuses a template that is not APPROVED', async () => {
    expect(await code(run('send_template', { conversation_id: CONV, template_name: 'pending_one' }, seed()))).toBe('template_not_approved');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a missing URL-button value', async () => {
    expect(await code(run('send_template', base, seed()))).toBe('button_param_missing');
  });

  it('dry run returns the exact components, including the URL button value', async () => {
    const r = (await run('send_template', { ...base, button_params: { '0': 'trk-9' } }, seed(), true)) as {
      meta_payload: { template: { name: string; components: unknown[] } };
      rendered: { body: string };
    };
    expect(r.rendered.body).toBe('Hi Asha, order A12 shipped.');
    expect(r.meta_payload.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'A12' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'trk-9' }] },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends with structured params outside the 24h window (templates are allowed)', async () => {
    const t = seed();
    t.messages[0].created_at = hoursAgo(80);
    await run('send_template', { ...base, button_params: { '0': 'trk-9' } }, t);
    expect(send).toHaveBeenCalledWith(expect.anything(), 'acct-1', expect.objectContaining({
      conversationId: CONV,
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['Asha', 'A12'], buttonParams: { 0: 'trk-9' } },
    }));
  });

  it('opens a conversation for a contact that has none', async () => {
    const t = seed();
    t.conversations = t.conversations.filter((c) => c.account_id !== 'acct-1');
    await run('send_template', { contact_id: CONTACT, template_name: 'order_update', body_params: ['A', 'B'], button_params: { '0': 'z' } }, t);
    expect(t.conversations.some((c) => c.contact_id === CONTACT && c.account_id === 'acct-1')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects another account\'s contact or conversation, and ambiguous targets', async () => {
    expect(await code(run('send_template', { ...base, conversation_id: undefined, contact_id: UUID(11) }, seed()))).toBe('not_found');
    expect(await code(run('send_template', { ...base, conversation_id: OTHER_CONV }, seed()))).toBe('not_found');
    expect(await code(run('send_template', { template_name: 'order_update' }, seed()))).toBe('invalid_input');
  });
});

describe('send_media and send_reaction', () => {
  it('send_media follows the 24h rule and passes the url through', async () => {
    await run('send_media', { conversation_id: CONV, kind: 'image', media_url: 'https://x.example.com/a.png', caption: 'c' }, seed());
    expect(send).toHaveBeenCalledWith(expect.anything(), 'acct-1', expect.objectContaining({ messageType: 'image', mediaUrl: 'https://x.example.com/a.png' }));
    const t = seed();
    t.messages[0].created_at = hoursAgo(48);
    expect(await code(run('send_media', { conversation_id: CONV, kind: 'image', media_url: 'https://x.example.com/a.png' }, t))).toBe('outside_24h_window');
  });

  it('send_reaction refuses another account\'s message and previews on dry run', async () => {
    expect(await code(run('send_reaction', { message_id: UUID(102), emoji: '👍' }, seed()))).toBe('not_found');
    const r = (await run('send_reaction', { message_id: UUID(100), emoji: '👍' }, seed(), true)) as Record<string, unknown>;
    expect(r.would_send).toBe(true);
  });
});
