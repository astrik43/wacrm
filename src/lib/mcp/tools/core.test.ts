import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: vi.fn(async () => ({ added: true, dispatched: true })),
}));

import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';

import { hasScope } from '@/lib/api-keys/scopes';

import { runTool } from '../executor';
import { coreTools } from './core';
import { ctxFor, fakeDb, hasEq } from './core/fake-db';

const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

function tool(name: string) {
  const t = coreTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
function call(name: string, db: ReturnType<typeof fakeDb>['db'], args: Record<string, unknown>, scopes: string[]) {
  const { createdBy, ...rest } = ctxFor(db, scopes);
  void rest;
  return runTool(tool(name), { supabase: db, accountId: 'acc-1', keyId: 'key-1', scopes, createdBy }, args);
}

describe('registry shape', () => {
  it('has unique names and matching scope tiers', () => {
    const names = coreTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of coreTools) {
      expect(t.scope).toBeTruthy();
      if (t.tier === 'read') expect(t.scope).toMatch(/:read$/);
      else expect(t.scope).toMatch(/:(write|send)$/);
    }
  });
});

describe('account isolation', () => {
  it('get_contact: another account contact is not_found', async () => {
    const { db, log } = fakeDb({ contacts: { data: null } });
    await expect(call('get_contact', db, { contact_id: A }, ['contacts:read'])).rejects.toMatchObject({ code: 'not_found' });
    expect(hasEq(log[0], 'account_id', 'acc-1')).toBe(true);
  });

  it('add_contact_note: unknown contact is not_found', async () => {
    const { db } = fakeDb({ contacts: { data: null } });
    await expect(call('add_contact_note', db, { contact_id: A, text: 'hi' }, ['notes:write'])).rejects.toMatchObject({ code: 'not_found' });
  });

  it('delete_contact_note: scoped by account', async () => {
    const { db, log } = fakeDb({ contact_notes: { data: null } });
    await expect(call('delete_contact_note', db, { note_id: A, confirm: true }, ['notes:write'])).rejects.toMatchObject({ code: 'not_found' });
    expect(hasEq(log[0], 'account_id', 'acc-1')).toBe(true);
  });

  it('add_tag_to_contacts: a contact from another account is not_found', async () => {
    const { db } = fakeDb({ contacts: { data: [{ id: A }] } });
    await expect(
      call('add_tag_to_contacts', db, { contact_ids: [A, B], tag_id: A }, ['tags:write'])
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(addContactTagAndDispatch).not.toHaveBeenCalled();
  });

  it('revoke_api_key: other account key is not_found', async () => {
    const { db } = fakeDb({ api_keys: { data: null } });
    await expect(call('revoke_api_key', db, { key_id: A, confirm: true }, ['team:write'])).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tags', () => {
  it('add_tag_to_contacts dry run reports counts and writes nothing', async () => {
    const { db, log } = fakeDb({
      contacts: { data: [{ id: A }, { id: B }] },
      tags: { data: { id: A, name: 'vip', color: '#fff' } },
      contact_tags: { data: [{ contact_id: B }] },
    });
    const res = (await call('add_tag_to_contacts', db, { contact_ids: [A, B], tag_id: A, dry_run: true }, ['tags:write'])) as Record<string, unknown>;
    expect(res).toMatchObject({ dry_run: true, would_add: 1, already_tagged: 1 });
    expect(log.some((c) => c.op !== 'select' && c.table !== 'mcp_audit_log')).toBe(false);
    expect(addContactTagAndDispatch).not.toHaveBeenCalled();
  });

  it('add_tag_to_contacts goes through addContactTagAndDispatch', async () => {
    const { db } = fakeDb({
      contacts: { data: [{ id: A }, { id: B }] },
      tags: { data: { id: A, name: 'vip', color: '#fff' } },
      contact_tags: { data: [] },
    });
    const res = (await call('add_tag_to_contacts', db, { contact_ids: [A, B], tag_id: A }, ['tags:write'])) as Record<string, unknown>;
    expect(res).toMatchObject({ added: 2, failed: 0 });
    expect(addContactTagAndDispatch).toHaveBeenCalledTimes(2);
  });

  it('requires exactly one of tag_id / tag_name', async () => {
    const { db } = fakeDb({ contacts: { data: [{ id: A }] } });
    await expect(call('add_tag_to_contacts', db, { contact_ids: [A] }, ['tags:write'])).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('delete_tag needs confirm but dry run reports contacts affected', async () => {
    const { db } = fakeDb({ tags: { data: { id: A, name: 'x', color: '#fff' } }, contact_tags: { count: 7, data: null } });
    await expect(call('delete_tag', db, { tag_id: A }, ['tags:write'])).rejects.toMatchObject({ code: 'confirm_required' });
    const res = await call('delete_tag', db, { tag_id: A, dry_run: true }, ['tags:write']);
    expect(res).toMatchObject({ dry_run: true, contacts_affected: 7 });
  });
});

describe('api keys', () => {
  it('refuses scopes the calling key does not hold', async () => {
    const { db, log } = fakeDb();
    await expect(
      call('create_api_key', db, { name: 'k', scopes: ['contacts:read', 'team:write'], confirm: true }, ['team:write'])
    ).rejects.toMatchObject({ code: 'missing_scope' });
    expect(log.some((c) => c.op === 'insert' && c.table !== 'mcp_audit_log')).toBe(false);
  });

  it('returns the plaintext once and never the hash', async () => {
    const { db } = fakeDb({
      api_keys: { data: { id: A, name: 'k', key_prefix: 'wacrm_live_abcd', scopes: ['contacts:read'] } },
    });
    const res = (await call('create_api_key', db, { name: 'k', scopes: ['contacts:read'], confirm: true }, ['team:write', 'contacts:read'])) as Record<string, unknown>;
    expect(String(res.api_key)).toMatch(/^wacrm_live_/);
    expect(JSON.stringify(res)).not.toMatch(/key_hash/);
  });

  it('dry run does not insert', async () => {
    const { db, log } = fakeDb();
    const res = await call('create_api_key', db, { name: 'k', scopes: ['contacts:read'], dry_run: true }, ['team:write', 'contacts:read']);
    expect(res).toMatchObject({ dry_run: true });
    expect(log.some((c) => c.op === 'insert' && c.table !== 'mcp_audit_log')).toBe(false);
  });
});

describe('team', () => {
  it('cannot change the owner role', async () => {
    const { db } = fakeDb({ profiles: { data: { user_id: A, full_name: 'O', account_role: 'owner', created_at: 'x' } } });
    await expect(call('change_member_role', db, { user_id: A, role: 'agent' }, ['team:write'])).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('list_team_members does not return emails', async () => {
    const { db } = fakeDb({ profiles: { data: [{ user_id: A, full_name: 'N', account_role: 'agent', created_at: 'x', email: 'a@b.c' }] } });
    const res = await call('list_team_members', db, {}, ['team:read']);
    expect(JSON.stringify(res)).not.toContain('a@b.c');
  });

  it('invite_member returns the token once and stores only the hash', async () => {
    const { db, log } = fakeDb({ account_invitations: { data: { id: A, role: 'agent', label: null, expires_at: 'x' } } });
    const res = (await call('invite_member', db, { role: 'agent' }, ['team:write'])) as Record<string, unknown>;
    expect(typeof res.invite_token).toBe('string');
    const ins = log.find((c) => c.op === 'insert')!;
    const row = ins.calls.find((c) => c.m === 'insert')!.args[0] as Record<string, unknown>;
    expect(row.token_hash).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(res.invite_token as string);
  });
});

describe('import_contacts', () => {
  it('dry run counts without writing', async () => {
    const { db, log } = fakeDb({ contacts: { data: [] } });
    const res = (await call(
      'import_contacts',
      db,
      { rows: [{ phone: '+14155550101' }, { phone: '+14155550101' }, { phone: 'abc' }], dry_run: true },
      ['contacts:write']
    )) as Record<string, number>;
    expect(res.would_create).toBe(1);
    expect(res.skipped_duplicate_in_batch + res.skipped_invalid_phone).toBe(2);
    expect(log.some((c) => c.op !== 'select' && c.table !== 'mcp_audit_log')).toBe(false);
  });
});

describe('scopes', () => {
  it('all tool scopes are known', () => {
    for (const t of coreTools) expect(hasScope([t.scope as string], t.scope as never)).toBe(true);
  });
});
