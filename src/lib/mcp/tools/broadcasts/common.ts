// Shared schemas and lookups for the broadcast tools.

import { z } from 'zod';

import { AudienceError, type ServerAudience } from '@/lib/broadcasts/audience';
import {
  buttonsNeedingParams,
  isHttpUrl,
  missingButtonParam,
  type ButtonVariables,
  type VariableMapping,
} from '@/lib/broadcasts/shared';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import type { MessageTemplate } from '@/types';

import { McpToolError } from '../../errors';
import type { McpContext } from '../../types';

const mappingSchema = z.object({
  type: z
    .enum(['static', 'field', 'custom_field'])
    .describe(
      "'static' = the same text for everyone; 'field' = a contact field (name, email, company); 'custom_field' = a custom field id."
    ),
  value: z
    .string()
    .describe("The text, the field name (name|email|company|phone), or the custom field id."),
});

export const variablesSchema = z
  .record(z.string(), mappingSchema)
  .default({})
  .describe(
    'Body placeholder values keyed by placeholder number, e.g. {"1": {"type":"field","value":"name"}}. Every {{n}} in the template body needs one.'
  );

export const buttonVariablesSchema = z
  .record(z.string(), mappingSchema)
  .default({})
  .describe(
    'Values for buttons that take one, keyed by the button index in the template (URL buttons with a {{1}} link, COPY_CODE buttons).'
  );

export const audienceSchema = z
  .object({
    type: z
      .enum(['all', 'tags', 'custom_field', 'contacts', 'phones'])
      .describe(
        "'all' = every customer; 'tags' = contacts with ANY of tag_ids; 'custom_field' = custom_field filter; 'contacts' = explicit contact_ids; 'phones' = a phone list (unknown numbers become new contacts on a real send)."
      ),
    tag_ids: z.array(z.string().uuid()).max(100).optional().describe('Tag ids for type "tags" (list_tags).'),
    exclude_tag_ids: z
      .array(z.string().uuid())
      .max(100)
      .optional()
      .describe('Contacts with any of these tags are removed from the audience.'),
    custom_field: z
      .object({
        field_id: z.string().uuid(),
        operator: z.enum(['is', 'is_not', 'contains']),
        value: z.string().min(1),
      })
      .optional()
      .describe('Filter for type "custom_field".'),
    contact_ids: z.array(z.string().uuid()).max(1000).optional().describe('Contact ids for type "contacts".'),
    phones: z.array(z.string().min(5).max(40)).max(1000).optional().describe('Phone numbers for type "phones".'),
  })
  .describe(
    'Who receives it. Staff contacts (is_staff) are never included, whatever the type.'
  );

export type AudienceInput = z.infer<typeof audienceSchema>;

export function toServerAudience(a: AudienceInput): ServerAudience {
  return {
    type: a.type,
    tagIds: a.tag_ids,
    excludeTagIds: a.exclude_tag_ids,
    customField: a.custom_field
      ? { fieldId: a.custom_field.field_id, operator: a.custom_field.operator, value: a.custom_field.value }
      : undefined,
    contactIds: a.contact_ids,
    phones: a.phones,
  };
}

/** Map the lib-level errors onto the MCP error codes. */
export function mapError(err: unknown): never {
  if (err instanceof McpToolError) throw err;
  if (err instanceof AudienceError) throw new McpToolError(err.code, err.message);
  if (err instanceof BroadcastError) {
    const code =
      err.code === 'not_found'
        ? 'not_found'
        : err.code === 'nothing_to_resume' || err.code === 'bad_request'
          ? 'invalid_input'
          : err.code === 'internal'
            ? 'internal'
            : 'conflict';
    throw new McpToolError(code, err.message);
  }
  throw err;
}

/** Button index keys ("0", "1") from the model into the numeric record the sender uses. */
export function toButtonVariables(raw: Record<string, VariableMapping>): ButtonVariables {
  const out: ButtonVariables = {};
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new McpToolError('invalid_input', `button_variables key '${key}' must be a button index (0, 1, ...)`, 'button_variables');
    }
    out[index] = value;
  }
  return out;
}

export interface LoadedTemplate {
  template: MessageTemplate;
  language: string;
}

/** The approved template row for a send, scoped to the account. */
export async function loadSendableTemplate(
  ctx: McpContext,
  name: string,
  language?: string
): Promise<LoadedTemplate> {
  const resolved = await resolveTemplateRow(ctx.supabase, ctx.accountId, name, language);
  if (resolved.malformed) {
    throw new McpToolError(
      'conflict',
      'Template row is malformed locally. Run sync_templates to repair it before broadcasting.'
    );
  }
  if (!resolved.row) {
    throw new McpToolError('not_found', `Template '${name}' was not found. Run sync_templates, then list_templates.`, 'template_name');
  }
  if (resolved.row.status !== 'APPROVED') {
    throw new McpToolError(
      'template_not_approved',
      `Template '${name}' is ${resolved.row.status ?? 'not approved'}; only APPROVED templates can be broadcast.`,
      'template_name'
    );
  }
  return { template: resolved.row, language: resolved.language };
}

/**
 * The checks the wizard enforces before it lets you send: every body
 * placeholder mapped, every button that needs a value has one, and a
 * valid link for a media header. Throws McpToolError.
 */
export function validateTemplateInputs(
  template: MessageTemplate,
  variables: Record<string, VariableMapping>,
  buttonVariables: ButtonVariables,
  headerMediaUrl: string | undefined
): void {
  for (const n of extractVariableIndices(template.body_text)) {
    if (!variables[String(n)]) {
      throw new McpToolError('invalid_input', `Body placeholder {{${n}}} has no value. Add it to variables.`, 'variables');
    }
  }
  const missing = missingButtonParam(template, buttonVariables);
  if (missing) {
    throw new McpToolError(
      'button_param_missing',
      `The "${missing}" button needs a value. Set button_variables for index ${buttonsNeedingParams(template).join(', ')}.`,
      'button_variables'
    );
  }
  const type = template.header_type;
  if (type === 'image' || type === 'video' || type === 'document') {
    const url = headerMediaUrl?.trim() || template.header_media_url?.trim() || '';
    if (!url) {
      throw new McpToolError('invalid_input', `This template has a ${type} header: pass header_media_url (a public https link).`, 'header_media_url');
    }
    if (!isHttpUrl(url)) {
      throw new McpToolError('invalid_input', 'header_media_url must be an http(s) link.', 'header_media_url');
    }
  } else if (type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0) {
    throw new McpToolError(
      'invalid_input',
      'This template has a variable in its text header, which broadcasts cannot fill. Use a template without one.',
      'template_name'
    );
  }
}

/** Custom field ids named in variable mappings must belong to the account. */
export async function assertCustomFieldsInAccount(
  ctx: McpContext,
  mappings: VariableMapping[]
): Promise<void> {
  const ids = [...new Set(mappings.filter((m) => m.type === 'custom_field').map((m) => m.value))];
  if (ids.length === 0) return;
  const { data } = await ctx.supabase
    .from('custom_fields')
    .select('id')
    .eq('account_id', ctx.accountId)
    .in('id', ids);
  if ((data ?? []).length !== ids.length) {
    throw new McpToolError('not_found', 'A custom_field mapping names a field that does not exist. Call list_custom_fields.', 'variables');
  }
}

/** Fields a model sees for a broadcast. */
export const BROADCAST_COLUMNS =
  'id, name, template_name, template_language, status, scheduled_at, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, delivery_locked_at, created_at, updated_at';

export function presentBroadcast(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    template_name: row.template_name,
    template_language: row.template_language,
    status: row.status,
    total_recipients: row.total_recipients,
    funnel: {
      sent: row.sent_count,
      delivered: row.delivered_count,
      read: row.read_count,
      replied: row.replied_count,
      failed: row.failed_count,
    },
    delivering_now: Boolean(row.delivery_locked_at),
    created_at: row.created_at,
  };
}

/** The broadcast row when it belongs to the account, else not_found. */
export async function loadBroadcast(ctx: McpContext, id: string, columns = BROADCAST_COLUMNS) {
  const { data, error } = await ctx.supabase
    .from('broadcasts')
    .select(columns)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new McpToolError('internal', 'Failed to read broadcast');
  if (!data) throw new McpToolError('not_found', 'Broadcast not found. Call list_broadcasts for ids.', 'broadcast_id');
  return data as unknown as Record<string, unknown>;
}
