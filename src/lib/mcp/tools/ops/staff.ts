// Staff contacts and the document send. Staff are internal team
// members (contacts.is_staff); they are the only valid recipients of
// send_document_to_staff.

import { z } from 'zod';

import { checkPdfUrl } from '@/lib/ops/document';
import { getOpsSettings } from '@/lib/ops/settings';
import {
  WINDOW_MS,
  lastInboundAt,
  latestConversationId,
  withinWindow,
} from '@/lib/ops/staff';
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';

import { McpToolError } from '../../errors';
import { defineTool } from '../../types';

type Row = Record<string, unknown>;

export const staffTools = [
  defineTool({
    name: 'set_contact_staff',
    title: 'Mark a contact as staff',
    description:
      'Flag (or unflag) a contact as an internal team member. Staff are skipped by broadcasts, order updates, abandoned-cart reminders and customer tags, and are the only contacts send_document_to_staff may message. contact_id is a contact id (from find_by_order or the contacts tools).',
    scope: 'ops:write',
    tier: 'write',
    input: {
      contact_id: z.string().uuid().describe('Contact id.'),
      is_staff: z.boolean().describe('true = team member, false = customer.'),
    },
    handler: async (ctx, args) => {
      const { data, error } = await ctx.supabase
        .from('contacts')
        .select('id, is_staff')
        .eq('id', args.contact_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error) throw new McpToolError('internal', 'Could not read the contact.');
      if (!data) throw new McpToolError('not_found', 'Contact not found.', 'contact_id');
      const current = (data as Row).is_staff === true;
      if (ctx.dryRun || current === args.is_staff) {
        return {
          contact_id: args.contact_id,
          is_staff: current,
          would_set: args.is_staff,
          changed: false,
        };
      }
      const { error: updateError } = await ctx.supabase
        .from('contacts')
        .update({ is_staff: args.is_staff, updated_at: new Date().toISOString() })
        .eq('id', args.contact_id)
        .eq('account_id', ctx.accountId);
      if (updateError) throw new McpToolError('internal', 'Could not update the contact.');
      return { contact_id: args.contact_id, is_staff: args.is_staff, changed: true };
    },
  }),

  defineTool({
    name: 'list_staff_contacts',
    title: 'List staff contacts',
    description:
      'List the contacts flagged as staff: id, name and whether they messaged in the last 24 hours (so a document can be sent as a normal message instead of a template). No phone numbers. Call before send_document_to_staff.',
    scope: 'ops:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('contacts')
        .select('id, name')
        .eq('account_id', ctx.accountId)
        .eq('is_staff', true)
        .order('created_at', { ascending: true })
        .limit(100);
      if (error) throw new McpToolError('internal', 'Could not list staff contacts.');
      const staff = (data as Row[] | null) ?? [];
      const ids = staff.map((s) => s.id as string);

      const active = new Set<string>();
      if (ids.length > 0) {
        const { data: convs } = await ctx.supabase
          .from('conversations')
          .select('id, contact_id')
          .eq('account_id', ctx.accountId)
          .in('contact_id', ids);
        const byConv = new Map(
          ((convs as Row[] | null) ?? []).map((c) => [c.id as string, c.contact_id as string])
        );
        if (byConv.size > 0) {
          const since = new Date(Date.now() - WINDOW_MS).toISOString();
          const { data: msgs } = await ctx.supabase
            .from('messages')
            .select('conversation_id')
            .in('conversation_id', [...byConv.keys()])
            .eq('sender_type', 'customer')
            .gte('created_at', since);
          for (const m of (msgs as Row[] | null) ?? []) {
            const contact = byConv.get(m.conversation_id as string);
            if (contact) active.add(contact);
          }
        }
      }
      return {
        items: staff.map((s) => ({
          contact_id: s.id,
          name: s.name ?? null,
          messaged_in_last_24h: active.has(s.id as string),
        })),
      };
    },
  }),

  defineTool({
    name: 'send_document_to_staff',
    title: 'Send a PDF to a team member',
    description:
      'Send a PDF (shipping labels, manifest) to a contact flagged as staff. url must be a public https link to a PDF under 10 MB. Inside the 24-hour window it is a normal document message with caption and filename; outside it, the utility template with a document header configured in ops settings is used (update_ops_settings), otherwise it fails with outside_24h_window. Fails with not_staff for anyone who is not flagged (set_contact_staff). Use dry_run to see the exact Meta payload first.',
    scope: 'ops:write',
    tier: 'write',
    input: {
      contact_id: z.string().uuid().describe('Staff contact id (list_staff_contacts).'),
      url: z.string().url().describe('Public https link to the PDF.'),
      caption: z.string().max(1024).optional().describe('Message shown with the file.'),
      filename: z
        .string()
        .max(120)
        .optional()
        .describe('File name shown in WhatsApp, e.g. labels-2026-11-27.pdf.'),
    },
    handler: async (ctx, args) => {
      const { data: contact, error } = await ctx.supabase
        .from('contacts')
        .select('id, is_staff')
        .eq('id', args.contact_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (error) throw new McpToolError('internal', 'Could not read the contact.');
      if (!contact) throw new McpToolError('not_found', 'Contact not found.', 'contact_id');
      if ((contact as Row).is_staff !== true) {
        throw new McpToolError(
          'not_staff',
          'This contact is not flagged as staff. Documents can only be sent to team members; flag them with set_contact_staff if they are one.',
          'contact_id'
        );
      }

      const { sizeBytes } = await checkPdfUrl(args.url);

      const conversationId = await latestConversationId(ctx.supabase, ctx.accountId, args.contact_id);
      if (!conversationId) {
        throw new McpToolError(
          'outside_24h_window',
          'This staff contact has no conversation yet. Ask them to send any message to the business number first, then retry.'
        );
      }
      const open = withinWindow(await lastInboundAt(ctx.supabase, conversationId));
      const filename = args.filename ?? 'document.pdf';

      if (open) {
        // The same payload sendMediaMessage posts; the recipient is masked.
        const payload = {
          messaging_product: 'whatsapp',
          to: '<staff contact>',
          type: 'document',
          document: {
            link: args.url,
            ...(args.caption ? { caption: args.caption } : {}),
            filename,
          },
        };
        if (ctx.dryRun) return { dry_run: true, mode: 'session', size_bytes: sizeBytes, payload };
        try {
          const result = await sendMessageToConversation(
            ctx.supabase,
            ctx.accountId,
            {
              conversationId,
              messageType: 'document',
              mediaUrl: args.url,
              contentText: args.caption ?? null,
              filename,
            },
            { senderType: 'agent', pauseActiveFlows: false }
          );
          return { sent: true, mode: 'session', message_id: result.messageId };
        } catch (err) {
          throw sendError(err);
        }
      }

      // Outside the window: only a template with a document header can reach them.
      const settings = await getOpsSettings(ctx.supabase, ctx.accountId);
      const nextStep =
        'Ask the team member to send any message to the business number, or set an approved utility template with a document header via update_ops_settings (staff_doc_template_name).';
      if (!settings.staff_doc_template_name) {
        throw new McpToolError(
          'outside_24h_window',
          `The team member has not messaged in the last 24 hours and no document template is configured. ${nextStep}`
        );
      }
      const resolved = await resolveTemplateRow(
        ctx.supabase,
        ctx.accountId,
        settings.staff_doc_template_name,
        settings.staff_doc_template_language
      );
      if (!resolved.row || resolved.malformed) {
        throw new McpToolError(
          'template_not_approved',
          `Template "${settings.staff_doc_template_name}" was not found. Run sync_templates, or fix staff_doc_template_name.`
        );
      }
      if (resolved.row.status !== 'APPROVED') {
        throw new McpToolError(
          'template_not_approved',
          `Template "${resolved.row.name}" is ${resolved.row.status ?? 'not approved'}. ${nextStep}`
        );
      }
      if (resolved.row.header_type !== 'document') {
        throw new McpToolError(
          'invalid_input',
          `Template "${resolved.row.name}" has no document header. Pick a utility template with a DOCUMENT header.`
        );
      }
      const variables = extractVariableIndices(resolved.row.body_text ?? '').length;
      const values = [args.caption ?? filename, filename];
      const body = Array.from({ length: variables }, (_, i) => values[i] ?? '-');
      const payload = {
        messaging_product: 'whatsapp',
        to: '<staff contact>',
        type: 'template',
        template: {
          name: resolved.row.name,
          language: { code: resolved.language },
          components: [
            { type: 'header', parameters: [{ type: 'document', document: { link: args.url } }] },
            ...(body.length > 0
              ? [{ type: 'body', parameters: body.map((text) => ({ type: 'text', text })) }]
              : []),
          ],
        },
      };
      if (ctx.dryRun) return { dry_run: true, mode: 'template', size_bytes: sizeBytes, payload };
      try {
        const result = await sendMessageToConversation(
          ctx.supabase,
          ctx.accountId,
          {
            conversationId,
            messageType: 'template',
            templateName: resolved.row.name,
            templateLanguage: resolved.language,
            templateParams: body,
            templateMessageParams: { body, headerMediaUrl: args.url },
          },
          { senderType: 'agent', pauseActiveFlows: false }
        );
        return { sent: true, mode: 'template', message_id: result.messageId };
      } catch (err) {
        throw sendError(err);
      }
    },
  }),
];

function sendError(err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  if (err instanceof SendMessageError) {
    return new McpToolError('upstream_error', `${err.code}: ${err.message}`);
  }
  return new McpToolError(
    'upstream_error',
    err instanceof Error ? err.message : 'The send failed.'
  );
}
