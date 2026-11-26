// Team + API-key tools. Members' emails are not returned (PII stays in contact tools).
import { z } from 'zod';

import { generateApiKey } from '@/lib/api-keys/keys';
import { API_SCOPES, normalizeScopes } from '@/lib/api-keys/scopes';
import { clampExpiryDays, generateInviteToken, inviteExpiresAt } from '@/lib/auth/invitations';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool } from '../../types';
import { auditUserId, fail, uuid } from './helpers';

const ASSIGNABLE_ROLES = ['admin', 'agent', 'viewer'] as const;
const KEY_COLUMNS = 'id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at';
const MAX_KEY_EXPIRY_DAYS = 365;

interface MemberRow {
  user_id: string;
  full_name: string | null;
  account_role: string;
  created_at: string;
}

async function requireMember(
  ctx: Parameters<AnyMcpTool['handler']>[0],
  userId: string
): Promise<MemberRow> {
  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('user_id, full_name, account_role, created_at')
    .eq('user_id', userId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) fail('Could not look up the member', error);
  if (!data) {
    throw new McpToolError('not_found', 'Member not found in this account. Use list_team_members for user ids.', 'user_id');
  }
  return data as MemberRow;
}

export const teamTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_team_members',
    description:
      'List the people in this account with their role (owner, admin, agent, viewer) and join date. Returns user ids used by change_member_role and remove_member. Emails are not returned.',
    scope: 'team:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('profiles')
        .select('user_id, full_name, account_role, created_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: true });
      if (error) fail('Could not load members', error);
      const items = ((data ?? []) as MemberRow[]).map((m) => ({
        user_id: m.user_id,
        name: m.full_name ?? '',
        role: m.account_role,
        joined_at: m.created_at,
      }));
      return { items, next_cursor: null };
    },
  }),

  defineTool({
    name: 'list_pending_invitations',
    description: 'List outstanding (not accepted, not expired) team invitations. The invite links themselves are never shown again.',
    scope: 'team:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('account_invitations')
        .select('id, role, label, created_at, expires_at')
        .eq('account_id', ctx.accountId)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      if (error) fail('Could not load invitations', error);
      return { items: data ?? [], next_cursor: null };
    },
  }),

  defineTool({
    name: 'invite_member',
    description:
      'Create a team invite link for a role (admin, agent or viewer; never owner). Returns invite_token ONCE: the join link is <app url>/join/<invite_token>. Share it with the person; it cannot be shown again.',
    scope: 'team:write',
    tier: 'write',
    input: {
      role: z.enum(ASSIGNABLE_ROLES),
      label: z.string().max(80).optional().describe('Who the invite is for, e.g. "Priya (support)".'),
      expires_in_days: z.number().int().min(1).max(30).optional().describe('Default 7.'),
    },
    handler: async (ctx, args) => {
      const expiryDays = clampExpiryDays(args.expires_in_days);
      const expiresAt = inviteExpiresAt(expiryDays);
      const label = args.label?.trim() || null;
      if (ctx.dryRun) {
        return { would_create: { role: args.role, label, expires_at: expiresAt.toISOString() } };
      }
      const { token, hash } = generateInviteToken();
      const { data, error } = await ctx.supabase
        .from('account_invitations')
        .insert({
          account_id: ctx.accountId,
          token_hash: hash,
          role: args.role,
          created_by_user_id: await auditUserId(ctx),
          label,
          expires_at: expiresAt.toISOString(),
        })
        .select('id, role, label, expires_at')
        .single();
      if (error || !data) fail('Could not create the invitation', error);
      return { invitation: data, invite_token: token, shown_once: true };
    },
  }),

  defineTool({
    name: 'change_member_role',
    description:
      'Change a team member to admin, agent or viewer. The owner cannot be changed (ownership transfer is dashboard-only). Use list_team_members for user ids.',
    scope: 'team:write',
    tier: 'write',
    input: { user_id: uuid, role: z.enum(ASSIGNABLE_ROLES) },
    handler: async (ctx, args) => {
      const member = await requireMember(ctx, args.user_id);
      if (member.account_role === 'owner') {
        throw new McpToolError('invalid_input', 'The account owner role cannot be changed here.', 'user_id');
      }
      if (ctx.dryRun) {
        return { would_change: { user_id: member.user_id, from: member.account_role, to: args.role } };
      }
      const { error } = await ctx.supabase
        .from('profiles')
        .update({ account_role: args.role })
        .eq('user_id', args.user_id)
        .eq('account_id', ctx.accountId);
      if (error) fail('Could not change the role', error);
      return { user_id: member.user_id, previous_role: member.account_role, role: args.role };
    },
  }),

  defineTool({
    name: 'remove_member',
    description:
      'Remove a member from the account. They keep their login and are moved to a fresh personal account. The owner and the key creator cannot be removed.',
    scope: 'team:write',
    tier: 'destructive',
    input: { user_id: uuid },
    handler: async (ctx, args) => {
      const member = await requireMember(ctx, args.user_id);
      if (member.account_role === 'owner') {
        throw new McpToolError('invalid_input', 'The account owner cannot be removed; transfer ownership first.', 'user_id');
      }
      if (ctx.createdBy && member.user_id === ctx.createdBy) {
        throw new McpToolError('invalid_input', 'You cannot remove the person who owns this API key.', 'user_id');
      }
      if (ctx.dryRun) {
        return { would_remove: { user_id: member.user_id, name: member.full_name ?? '', role: member.account_role } };
      }
      // Mirrors the remove_account_member RPC (which needs a browser session).
      const { data: created, error: createErr } = await ctx.supabase
        .from('accounts')
        .insert({ name: member.full_name?.trim() || 'My account', owner_user_id: member.user_id })
        .select('id')
        .single();
      if (createErr || !created) fail('Could not create the personal account', createErr);
      const newId = (created as { id: string }).id;
      const { error: moveErr } = await ctx.supabase
        .from('profiles')
        .update({ account_id: newId, account_role: 'owner' })
        .eq('user_id', member.user_id)
        .eq('account_id', ctx.accountId);
      if (moveErr) {
        await ctx.supabase.from('accounts').delete().eq('id', newId);
        fail('Could not remove the member', moveErr);
      }
      return { removed: true, user_id: member.user_id };
    },
  }),

  defineTool({
    name: 'list_api_keys',
    description: 'List this account\'s API keys: name, prefix, scopes, last used, expiry, revoked state. Key secrets and hashes are never returned.',
    scope: 'account:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('api_keys')
        .select(KEY_COLUMNS)
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false });
      if (error) fail('Could not load API keys', error);
      return { items: data ?? [], next_cursor: null };
    },
  }),

  defineTool({
    name: 'create_api_key',
    description:
      'Mint a new API key. Its scopes must be a subset of the scopes of the key making this call (no privilege escalation). Returns api_key ONCE; it cannot be shown again. Valid scopes: ' +
      API_SCOPES.join(', ') +
      '.',
    scope: 'team:write',
    tier: 'destructive',
    input: {
      name: z.string().min(1).max(80),
      scopes: z.array(z.string()).describe('Scopes for the new key, each one must also be held by the calling key.'),
      expires_in_days: z.number().int().min(1).max(MAX_KEY_EXPIRY_DAYS).optional().describe('Omit for a key that never expires.'),
    },
    handler: async (ctx, args) => {
      const scopes = normalizeScopes(args.scopes);
      if (scopes === null) {
        throw new McpToolError('invalid_input', 'scopes must all be known scope names (see the tool description).', 'scopes');
      }
      const missing = scopes.filter((s) => !ctx.scopes.includes(s));
      if (missing.length > 0) {
        throw new McpToolError(
          'missing_scope',
          `This key cannot grant scopes it does not hold: ${missing.join(', ')}.`,
          'scopes'
        );
      }
      const expiresAt = args.expires_in_days
        ? new Date(Date.now() + args.expires_in_days * 86_400_000).toISOString()
        : null;
      if (ctx.dryRun) {
        return { would_create: { name: args.name.trim(), scopes, expires_at: expiresAt } };
      }
      const { plaintext, hash, prefix } = generateApiKey();
      const { data, error } = await ctx.supabase
        .from('api_keys')
        .insert({
          account_id: ctx.accountId,
          created_by: await auditUserId(ctx),
          name: args.name.trim(),
          key_prefix: prefix,
          key_hash: hash,
          scopes,
          expires_at: expiresAt,
        })
        .select(KEY_COLUMNS)
        .single();
      if (error || !data) fail('Could not create the API key', error);
      return { key: data, api_key: plaintext, shown_once: true };
    },
  }),

  defineTool({
    name: 'revoke_api_key',
    description: 'Revoke an API key immediately (it stops working on its next request). Use list_api_keys for ids. Revoking the key you are calling with locks you out.',
    scope: 'team:write',
    tier: 'destructive',
    input: { key_id: uuid },
    handler: async (ctx, args) => {
      const { data: key, error: readErr } = await ctx.supabase
        .from('api_keys')
        .select('id, name, revoked_at')
        .eq('id', args.key_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (readErr) fail('Could not look up the API key', readErr);
      if (!key) throw new McpToolError('not_found', 'API key not found in this account. Use list_api_keys.', 'key_id');
      if ((key as { revoked_at: string | null }).revoked_at) {
        throw new McpToolError('conflict', 'That API key is already revoked.', 'key_id');
      }
      if (ctx.dryRun) {
        return { would_revoke: { id: args.key_id, name: (key as { name: string }).name, is_current_key: args.key_id === ctx.keyId } };
      }
      const { error } = await ctx.supabase
        .from('api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', args.key_id)
        .eq('account_id', ctx.accountId)
        .is('revoked_at', null);
      if (error) fail('Could not revoke the API key', error);
      return { revoked: true, id: args.key_id };
    },
  }),
];
