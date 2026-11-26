// WhatsApp number status, registration check and business profile.
// The access token, app secret and verify token are never returned.

import { z } from 'zod';

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  BUSINESS_PROFILE_LIMITS,
  diffBusinessProfile,
  fetchBusinessProfile,
  fetchPhoneStatus,
  pushBusinessProfile,
  type BusinessProfileUpdate,
} from '@/lib/whatsapp/business-profile';
import { describeMetaError } from '@/lib/whatsapp/meta-api';
import { runRegistrationCheck } from '@/lib/whatsapp/verify-registration';

import { McpToolError } from '../../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../../types';

interface ConfigRow {
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  status: string | null;
  connected_at: string | null;
  registered_at: string | null;
  last_registration_error: string | null;
  subscribed_apps_at: string | null;
}

async function loadConfig(ctx: McpContext): Promise<ConfigRow> {
  const { data, error } = await ctx.supabase
    .from('whatsapp_config')
    .select(
      'phone_number_id, waba_id, access_token, status, connected_at, registered_at, last_registration_error, subscribed_apps_at'
    )
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new McpToolError('internal', 'Failed to load the WhatsApp configuration');
  if (!data) {
    throw new McpToolError('conflict', 'No WhatsApp number is connected yet. Connect one in Settings > WhatsApp.');
  }
  return data as ConfigRow;
}

function token(row: ConfigRow): string {
  try {
    return decrypt(row.access_token);
  } catch {
    throw new McpToolError(
      'conflict',
      'The stored access token cannot be decrypted (ENCRYPTION_KEY changed). Re-enter it in Settings > WhatsApp.'
    );
  }
}

const url = z
  .string()
  .max(256)
  .refine((v) => /^https?:\/\//i.test(v), 'must start with http:// or https://');

export const whatsappSettingsTools: AnyMcpTool[] = [
  defineTool({
    name: 'get_whatsapp_status',
    title: 'WhatsApp number status',
    description:
      'Show the connected WhatsApp number: display number, verified (display) name, quality rating, messaging-limit tier, name status, connection state and registration state. Reads live data from Meta. Credentials are never returned. For a deeper diagnostic of "connected but no messages arrive" use verify_whatsapp_registration.',
    scope: 'settings:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data } = await ctx.supabase
        .from('whatsapp_config')
        .select('phone_number_id')
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!data) return { configured: false };

      const row = await loadConfig(ctx);
      const local = {
        configured: true,
        phone_number_id: row.phone_number_id,
        waba_id: row.waba_id,
        connection_status: row.status,
        connected_at: row.connected_at,
        registered_at: row.registered_at,
        registered: row.registered_at != null,
        last_registration_error: row.last_registration_error,
      };
      try {
        const live = await fetchPhoneStatus({ phoneNumberId: row.phone_number_id, accessToken: token(row) });
        return { ...local, ...live };
      } catch (err) {
        if (err instanceof McpToolError) throw err;
        return { ...local, meta_error: describeMetaError(err, 'Could not reach Meta') };
      }
    },
  }),

  defineTool({
    name: 'verify_whatsapp_registration',
    title: 'Verify WhatsApp registration',
    description:
      'Run the live registration check against Meta: phone metadata reachable, WABA subscribed to this app, and the local registration stamp. Returns { live, checks, errors }. Write-tier because it calls Meta with the stored token (it changes nothing in wacrm). dry_run only lists the checks without calling Meta.',
    scope: 'settings:write',
    tier: 'write',
    input: {},
    handler: async (ctx) => {
      const row = await loadConfig(ctx);
      if (ctx.dryRun) {
        return {
          dry_run: true,
          would_check: ['phone_metadata_ok', 'waba_subscribed_to_app', 'locally_marked_registered'],
        };
      }
      return runRegistrationCheck(row);
    },
  }),

  defineTool({
    name: 'get_business_profile',
    title: 'WhatsApp business profile',
    description:
      'Read the WhatsApp business profile shown to customers: about text, address, description, email, websites and industry. Reads live from Meta.',
    scope: 'settings:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const row = await loadConfig(ctx);
      try {
        return await fetchBusinessProfile({ phoneNumberId: row.phone_number_id, accessToken: token(row) });
      } catch (err) {
        if (err instanceof McpToolError) throw err;
        throw new McpToolError('upstream_error', describeMetaError(err, 'Could not read the business profile from Meta'));
      }
    },
  }),

  defineTool({
    name: 'update_business_profile',
    title: 'Update WhatsApp business profile',
    description:
      'Change the WhatsApp business profile customers see: about (max 139 chars), address, description, email, websites (max 2, replaces the list). Send only the fields to change. Customer-visible, so confirm the wording with the user; dry_run shows the diff against the live profile without changing anything. Call get_business_profile first.',
    scope: 'settings:write',
    tier: 'write',
    input: {
      about: z.string().max(BUSINESS_PROFILE_LIMITS.about).optional(),
      address: z.string().max(BUSINESS_PROFILE_LIMITS.address).optional(),
      description: z.string().max(BUSINESS_PROFILE_LIMITS.description).optional(),
      email: z.string().email().max(BUSINESS_PROFILE_LIMITS.email).optional(),
      websites: z.array(url).max(BUSINESS_PROFILE_LIMITS.websites).optional(),
    },
    handler: async (ctx, args) => {
      const update: BusinessProfileUpdate = {};
      for (const k of ['about', 'address', 'description', 'email', 'websites'] as const) {
        if (args[k] !== undefined) (update as Record<string, unknown>)[k] = args[k];
      }
      if (Object.keys(update).length === 0) {
        throw new McpToolError('invalid_input', 'Provide at least one field to change.');
      }
      const row = await loadConfig(ctx);
      const accessToken = token(row);
      try {
        const current = await fetchBusinessProfile({ phoneNumberId: row.phone_number_id, accessToken });
        const diff = diffBusinessProfile(current, update);
        if (ctx.dryRun) return { dry_run: true, diff };
        if (Object.keys(diff).length === 0) return { ok: true, changed: [], note: 'Already up to date.' };
        await pushBusinessProfile({ phoneNumberId: row.phone_number_id, accessToken, update });
        return { ok: true, changed: Object.keys(diff), diff };
      } catch (err) {
        if (err instanceof McpToolError) throw err;
        throw new McpToolError('upstream_error', describeMetaError(err, 'Meta rejected the business profile update'));
      }
    },
  }),
];
