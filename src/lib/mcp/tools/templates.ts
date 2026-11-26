// MCP 2.0 — "templates" tools (templates:read / templates:write).
// Submit / sync / delete call src/lib/whatsapp/template-ops.ts, the same
// code the dashboard's /api/whatsapp/templates/* routes run.
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '@/lib/api/v1/pagination';
import {
  deleteTemplate,
  previewMetaSubmission,
  submitTemplate,
  syncTemplatesFromMeta,
  TemplateOpError,
  validateSubmission,
} from '@/lib/whatsapp/template-ops';
import {
  prepareTemplateSend,
  TemplateSendInputError,
} from '@/lib/whatsapp/template-send-params';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { extractVariableIndices, type TemplatePayload } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../types';

const LIST_COLUMNS =
  'id, name, language, category, status, quality_score, header_type, body_text, buttons, meta_template_id, rejection_reason, submission_error, last_submitted_at, created_at';

type Row = MessageTemplate & { id: string };

function buttonSummary(t: MessageTemplate) {
  return (t.buttons ?? []).map((b, index) => ({
    index,
    type: b.type,
    text: b.text,
    // Which buttons need a value at send time (button_params[index]).
    needs_value:
      b.type === 'URL'
        ? extractVariableIndices(b.url).length > 0
        : b.type === 'COPY_CODE'
          ? 'optional (defaults to the example code)'
          : false,
    ...(b.type === 'URL' ? { url: b.url } : {}),
    ...(b.type === 'COPY_CODE' ? { example: b.example } : {}),
  }));
}

function summary(t: Row) {
  return {
    template_id: t.id,
    name: t.name,
    language: t.language ?? null,
    category: t.category,
    status: t.status ?? null,
    quality: t.quality_score ?? null,
    header_type: t.header_type ?? null,
    variable_count: extractVariableIndices(t.body_text).length,
    buttons: buttonSummary(t),
  };
}

async function loadTemplate(ctx: McpContext, id: string): Promise<Row> {
  const { data } = await ctx.supabase
    .from('message_templates')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!data) {
    throw new McpToolError(
      'not_found',
      'Template not found. Use list_templates for valid ids (run sync_templates if it is new on Meta).',
      'template_id'
    );
  }
  return data as Row;
}

function opError(err: unknown): never {
  if (err instanceof TemplateOpError) {
    const code =
      err.status === 404
        ? 'not_found'
        : err.status === 429
          ? 'rate_limited'
          : err.status >= 500 || err.status === 502
            ? 'upstream_error'
            : 'invalid_input';
    throw new McpToolError(code, err.message);
  }
  throw err;
}

const buttonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string() }),
  z.object({
    type: z.literal('URL'),
    text: z.string(),
    url: z.string().describe('Link; end with {{1}} for a per-send suffix.'),
    example: z.string().optional().describe('Sample suffix, required when url has {{1}}.'),
  }),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string(), phone_number: z.string() }),
  z.object({ type: z.literal('COPY_CODE'), text: z.string(), example: z.string() }),
]);

const sendValuesShape = {
  body_params: z.array(z.string()).optional().describe('Values for {{1}}, {{2}}, ... in order. Defaults to the template\'s sample values.'),
  header_text: z.string().optional(),
  header_media_url: z.string().url().startsWith('https://').optional(),
  button_params: z.record(z.string(), z.string()).optional().describe('Button values keyed by button index ("0", ...).'),
};

export const templatesTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_templates',
    title: 'List message templates',
    description:
      'List the account\'s WhatsApp templates with status (APPROVED, PENDING, REJECTED, PAUSED, ...), category, quality rating, number of body variables and buttons (with which ones need a value to send). Filter by status, category, quality or name text. Only APPROVED templates can be sent. If a template is missing, run sync_templates. Page with next_cursor.',
    scope: 'templates:read',
    tier: 'read',
    input: {
      status: z.string().optional().describe('e.g. APPROVED, PENDING, REJECTED, PAUSED, DRAFT.'),
      category: z.enum(['Marketing', 'Utility', 'Authentication']).optional(),
      quality: z.enum(['GREEN', 'YELLOW', 'RED']).optional(),
      search: z.string().max(100).optional().describe('Substring of the template name.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100).'),
      cursor: z.string().optional(),
    },
    handler: async (ctx, args) => {
      const limit = args.limit ?? 25;
      let q = ctx.supabase
        .from('message_templates')
        .select(LIST_COLUMNS)
        .eq('account_id', ctx.accountId);
      if (args.status) q = q.eq('status', args.status.toUpperCase());
      if (args.category) q = q.eq('category', args.category);
      if (args.quality) q = q.eq('quality_score', args.quality);
      if (args.search) q = q.ilike('name', `%${args.search.replace(/[%,()]/g, '')}%`);
      const cursor = args.cursor ? decodeCursor(args.cursor) : null;
      if (cursor) {
        q = q.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
        );
      }
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (error) throw new McpToolError('internal', 'Failed to list templates.');
      const rows = (data ?? []) as Row[];
      const page = rows.slice(0, limit);
      return {
        items: page.map(summary),
        next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      };
    },
  }),

  defineTool({
    name: 'get_template',
    title: 'Get a template',
    description:
      'Get one template in full (template_id from list_templates): header, body, footer, buttons, sample values, status, rejection reason, and which values you must pass to send it.',
    scope: 'templates:read',
    tier: 'read',
    input: { template_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const t = await loadTemplate(ctx, args.template_id);
      return {
        ...summary(t),
        header_content: t.header_content ?? null,
        header_media_url: t.header_media_url ?? null,
        body_text: t.body_text,
        footer_text: t.footer_text ?? null,
        sample_values: t.sample_values ?? null,
        rejection_reason: t.rejection_reason ?? null,
        submission_error: t.submission_error ?? null,
        last_submitted_at: t.last_submitted_at ?? null,
        header_variable: t.header_type === 'text' && extractVariableIndices(t.header_content ?? '').length > 0,
        sendable: t.status === 'APPROVED',
      };
    },
  }),

  defineTool({
    name: 'preview_template',
    title: 'Preview a template send',
    description:
      'Render a template without sending: returns the readable message and the exact Meta components payload send_template would post. Give template_id plus the values (body_params, header_text, header_media_url, button_params); anything omitted falls back to the template\'s sample values. Optional contact_id lets values use {{contact.name}} / {{contact.first_name}}. Use it to check button_params before send_template.',
    scope: 'templates:read',
    tier: 'read',
    input: {
      template_id: z.string().uuid(),
      contact_id: z.string().uuid().optional(),
      ...sendValuesShape,
    },
    handler: async (ctx, args) => {
      const t = await loadTemplate(ctx, args.template_id);
      if (!isMessageTemplate(t)) {
        throw new McpToolError('conflict', 'The local template row is malformed. Run sync_templates to repair it.');
      }
      let contact: { name: string | null } | undefined;
      if (args.contact_id) {
        const { data } = await ctx.supabase
          .from('contacts')
          .select('name')
          .eq('id', args.contact_id)
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        if (!data) throw new McpToolError('not_found', 'Contact not found.', 'contact_id');
        contact = data as { name: string | null };
      }
      try {
        const p = prepareTemplateSend(t, args, {
          language: t.language ?? 'en_US',
          useSamples: true,
          contact,
        });
        return {
          template_id: t.id,
          sendable: t.status === 'APPROVED',
          status: t.status ?? null,
          rendered: p.rendered,
          meta_payload: { type: 'template', template: p.metaTemplate },
        };
      } catch (err) {
        if (err instanceof TemplateSendInputError) {
          throw new McpToolError(err.code, err.message, err.field);
        }
        throw err;
      }
    },
  }),

  defineTool({
    name: 'submit_template',
    title: 'Submit a template to Meta',
    description:
      'Create a new message template and submit it to Meta for approval (review usually takes minutes to 24 hours; check status with list_templates or sync_templates). Marketing and Utility only; Authentication templates must be created in Meta WhatsApp Manager. Name: lowercase letters, digits, underscores. Variables are {{1}}, {{2}}... and each needs a sample in sample_values. Validated before submission; dry_run validates and returns the Meta payload without submitting. Re-submitting an existing name+language replaces the local row.',
    scope: 'templates:write',
    tier: 'write',
    input: {
      name: z.string().min(1).max(512),
      category: z.enum(['Marketing', 'Utility']),
      language: z.string().default('en_US'),
      header_type: z.enum(['text', 'image', 'video', 'document']).optional(),
      header_content: z.string().optional().describe('Header text (for header_type text).'),
      header_media_url: z.string().url().optional().describe('Public sample URL for image/video/document headers.'),
      body_text: z.string().min(1).max(1024),
      footer_text: z.string().max(60).optional(),
      buttons: z.array(buttonSchema).max(10).optional(),
      sample_values: z
        .object({ body: z.array(z.string()).optional(), header: z.array(z.string()).optional() })
        .optional(),
    },
    handler: async (ctx, args) => {
      const payload = args as unknown as TemplatePayload;
      try {
        validateSubmission(payload);
      } catch (err) {
        return opError(err);
      }
      if (ctx.dryRun) {
        let metaPayload: unknown = null;
        try {
          metaPayload = previewMetaSubmission(payload);
        } catch {
          // Media headers need an upload handle that only exists at submit time.
        }
        return { valid: true, would_submit: true, meta_payload: metaPayload };
      }
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no owning user to author the template.');
      }
      try {
        const { template, dry_run } = await submitTemplate(ctx.supabase, ctx.accountId, ctx.createdBy, payload);
        const t = template as Row;
        return {
          submitted: true,
          template_id: t.id,
          name: t.name,
          language: t.language ?? null,
          status: t.status ?? null,
          simulated: dry_run,
        };
      } catch (err) {
        return opError(err);
      }
    },
  }),

  defineTool({
    name: 'sync_templates',
    title: 'Sync templates from Meta',
    description:
      'Pull the latest templates and their approval status from Meta into the CRM. Run it after submitting a template, when a template looks missing, or when its status may have changed. Rows no longer on Meta are removed; local drafts are kept. dry_run only reports what the sync would call.',
    scope: 'templates:write',
    tier: 'write',
    input: {},
    handler: async (ctx) => {
      if (ctx.dryRun) return { would_sync: true };
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no owning user to attribute the sync to.');
      }
      try {
        return await syncTemplatesFromMeta(ctx.supabase, ctx.accountId, ctx.createdBy);
      } catch (err) {
        return opError(err);
      }
    },
  }),

  defineTool({
    name: 'delete_template',
    title: 'Delete a template',
    description:
      'Delete a template on Meta (that language variant) and in the CRM. Cannot be undone and any broadcast or automation using it will stop working. template_id from list_templates. Requires confirm: true.',
    scope: 'templates:write',
    tier: 'destructive',
    input: { template_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const t = await loadTemplate(ctx, args.template_id);
      if (ctx.dryRun) {
        return {
          would_delete: {
            template_id: t.id,
            name: t.name,
            language: t.language ?? null,
            status: t.status ?? null,
            also_removed_on_meta: Boolean(t.meta_template_id),
          },
        };
      }
      try {
        const { dry_run } = await deleteTemplate(ctx.supabase, ctx.accountId, t.id);
        return { deleted: true, template_id: t.id, name: t.name, simulated: dry_run };
      } catch (err) {
        return opError(err);
      }
    },
  }),
];
