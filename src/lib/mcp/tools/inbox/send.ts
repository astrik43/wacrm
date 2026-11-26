// Inbox tools that send to a customer (scope messages:send).
// All sends go through sendMessageToConversation — the same core the
// dashboard and POST /api/v1/messages use — so the message is recorded
// in the inbox exactly as a dashboard send would be.

import { z } from 'zod';

import { McpToolError } from '../../errors';
import { defineTool, type McpContext } from '../../types';
import { getReplyWindow } from '@/lib/whatsapp/reply-window';
import { reactToMessage, ReactError } from '@/lib/whatsapp/react-message';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  prepareTemplateSend,
  TemplateSendInputError,
} from '@/lib/whatsapp/template-send-params';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import { loadConversation, loadMessage, mapSendError, redactedMetaBody } from './common';

async function requireOpenWindow(ctx: McpContext, conversationId: string) {
  const window = await getReplyWindow(ctx.supabase, conversationId);
  if (!window.open) {
    throw new McpToolError(
      'outside_24h_window',
      window.last_customer_message_at
        ? `The 24-hour reply window closed at ${window.expires_at}. Use send_template with an approved template instead.`
        : 'This customer has not messaged you, so there is no open reply window. Use send_template with an approved template instead.',
      'conversation_id'
    );
  }
  return window;
}

async function checkReplyTarget(ctx: McpContext, conversationId: string, messageId?: string) {
  if (!messageId) return;
  const { data } = await ctx.supabase
    .from('messages')
    .select('id')
    .eq('id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (!data) {
    throw new McpToolError(
      'not_found',
      'reply_to_message_id was not found in this conversation.',
      'reply_to_message_id'
    );
  }
}

const sendResult = (
  r: { messageId: string; whatsappMessageId: string },
  conversationId: string
) => ({
  sent: true,
  message_id: r.messageId,
  whatsapp_message_id: r.whatsappMessageId,
  conversation_id: conversationId,
});

export const inboxSendTools = [
  defineTool({
    name: 'send_text',
    title: 'Send a text message',
    description:
      'Send a free-form text message in a conversation. Only allowed inside the 24-hour reply window (the customer wrote within the last 24 hours); outside it this fails with outside_24h_window and you must use send_template. Call check_reply_window first if unsure. conversation_id comes from list_conversations_filtered. Use dry_run to preview the exact Meta payload.',
    scope: 'messages:send',
    tier: 'write',
    input: {
      conversation_id: z.string().uuid(),
      text: z.string().min(1).max(4096).describe('Message text (max 4096 chars).'),
      reply_to_message_id: z
        .string()
        .uuid()
        .optional()
        .describe('Quote this message (an id from get_conversation_thread).'),
    },
    handler: async (ctx, args) => {
      await loadConversation(ctx, args.conversation_id);
      const window = await requireOpenWindow(ctx, args.conversation_id);
      await checkReplyTarget(ctx, args.conversation_id, args.reply_to_message_id);

      if (ctx.dryRun) {
        return {
          would_send: true,
          reply_window_expires_at: window.expires_at,
          meta_payload: redactedMetaBody({
            type: 'text',
            text: { body: args.text, preview_url: false },
          }),
        };
      }
      try {
        const r = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
          conversationId: args.conversation_id,
          messageType: 'text',
          contentText: args.text,
          replyToMessageId: args.reply_to_message_id ?? null,
        });
        return sendResult(r, args.conversation_id);
      } catch (err) {
        return mapSendError(err);
      }
    },
  }),

  defineTool({
    name: 'send_template',
    title: 'Send a template message',
    description:
      'Send an approved WhatsApp template. Works inside and outside the 24-hour window (it is the only way to start a conversation or reach a customer after the window closed). Give conversation_id OR contact_id (an existing contact; a conversation is opened if there is none). Fill body_params in {{1}},{{2}} order, header_text if the header has a variable, header_media_url for image/video/document headers, and button_params for URL buttons with a variable ({"0": "order-123"} keyed by button index) and to override a COPY_CODE coupon. Run get_template or preview_template first to see which values are needed. Fails with template_not_approved unless the template is APPROVED, and button_param_missing when a URL button value is missing. dry_run returns the exact Meta payload and rendered text and sends nothing. Param values may use {{contact.name}} / {{contact.first_name}}.',
    scope: 'messages:send',
    tier: 'write',
    input: {
      conversation_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().optional(),
      template_name: z.string().min(1).describe('Template name from list_templates.'),
      language: z.string().optional().describe('Language code, e.g. en_US. Default: the template\'s own.'),
      body_params: z.array(z.string()).optional().describe('Values for {{1}}, {{2}}, ... in order.'),
      header_text: z.string().optional().describe('Value for a {{1}} in a TEXT header.'),
      header_media_url: z
        .string()
        .url()
        .startsWith('https://')
        .optional()
        .describe('Public https URL for an image/video/document header (defaults to the template\'s saved media).'),
      button_params: z
        .record(z.string(), z.string())
        .optional()
        .describe('Button values keyed by button index ("0", "1", ...): URL suffix for a URL button with {{1}}, or a coupon code for COPY_CODE.'),
    },
    handler: async (ctx, args) => {
      if (!args.conversation_id === !args.contact_id) {
        throw new McpToolError(
          'invalid_input',
          'Pass exactly one of conversation_id or contact_id.'
        );
      }

      // Resolve the contact/conversation, both scoped to the account.
      let conversationId = args.conversation_id ?? null;
      let contact = null as { id: string; name: string | null } | null;
      if (conversationId) {
        const conv = await loadConversation(ctx, conversationId);
        const { data } = await ctx.supabase
          .from('contacts')
          .select('id, name')
          .eq('id', conv.contact_id)
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        contact = data as typeof contact;
      } else {
        const { data } = await ctx.supabase
          .from('contacts')
          .select('id, name')
          .eq('id', args.contact_id!)
          .eq('account_id', ctx.accountId)
          .maybeSingle();
        if (!data) {
          throw new McpToolError('not_found', 'Contact not found.', 'contact_id');
        }
        contact = data as typeof contact;
        const { data: existing } = await ctx.supabase
          .from('conversations')
          .select('id')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', args.contact_id!)
          .maybeSingle();
        conversationId = (existing as { id: string } | null)?.id ?? null;
      }

      // Template row + approval gate.
      const resolved = await resolveTemplateRow(
        ctx.supabase,
        ctx.accountId,
        args.template_name,
        args.language
      );
      if (resolved.malformed) {
        throw new McpToolError(
          'conflict',
          'The local template row is malformed. Run sync_templates to repair it.',
          'template_name'
        );
      }
      const template = resolved.row;
      if (!template) {
        throw new McpToolError(
          'not_found',
          `No template named "${args.template_name}"${args.language ? ` in ${args.language}` : ''}. Run list_templates (or sync_templates) first.`,
          'template_name'
        );
      }
      if (template.status !== 'APPROVED') {
        throw new McpToolError(
          'template_not_approved',
          `Template "${template.name}" is ${template.status ?? 'not submitted'}; only APPROVED templates can be sent. Check get_template, or run sync_templates to refresh its status.`,
          'template_name'
        );
      }

      let prepared;
      try {
        prepared = prepareTemplateSend(
          template,
          {
            body_params: args.body_params,
            header_text: args.header_text,
            header_media_url: args.header_media_url,
            button_params: args.button_params,
          },
          { language: resolved.language, contact: contact ?? undefined }
        );
      } catch (err) {
        if (err instanceof TemplateSendInputError) {
          throw new McpToolError(err.code, err.message, err.field);
        }
        throw err;
      }

      if (ctx.dryRun) {
        return {
          would_send: true,
          opens_new_conversation: conversationId === null,
          rendered: prepared.rendered,
          meta_payload: redactedMetaBody({
            type: 'template',
            template: prepared.metaTemplate,
          }),
        };
      }

      // Business-initiated send from a contact with no conversation yet:
      // open one (same as the dashboard's contact_id path).
      if (!conversationId) {
        if (!ctx.createdBy) {
          throw new McpToolError(
            'invalid_input',
            'This API key has no owning user, so a new conversation cannot be opened. Pass an existing conversation_id.'
          );
        }
        const { data: created, error } = await ctx.supabase
          .from('conversations')
          .insert({
            account_id: ctx.accountId,
            user_id: ctx.createdBy,
            contact_id: args.contact_id,
          })
          .select('id')
          .single();
        if (error || !created) {
          throw new McpToolError('internal', 'Failed to open a conversation for this contact.');
        }
        conversationId = (created as { id: string }).id;
      }

      try {
        const r = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
          conversationId,
          messageType: 'template',
          templateName: template.name,
          templateLanguage: resolved.language,
          templateMessageParams: prepared.messageParams,
        });
        return sendResult(r, conversationId);
      } catch (err) {
        return mapSendError(err);
      }
    },
  }),

  defineTool({
    name: 'send_media',
    title: 'Send an image, video, document or audio',
    description:
      'Send a media message from a public https URL. Free-form, so it is only allowed inside the 24-hour reply window (otherwise outside_24h_window; use send_template with a media header instead). caption is not supported for audio (max 1024 chars otherwise). filename applies to documents.',
    scope: 'messages:send',
    tier: 'write',
    input: {
      conversation_id: z.string().uuid(),
      kind: z.enum(['image', 'video', 'document', 'audio']),
      media_url: z.string().url().startsWith('https://').describe('Public https URL of the file.'),
      caption: z.string().max(1024).optional(),
      filename: z.string().max(200).optional(),
    },
    handler: async (ctx, args) => {
      await loadConversation(ctx, args.conversation_id);
      const window = await requireOpenWindow(ctx, args.conversation_id);
      if (args.kind === 'audio' && args.caption) {
        throw new McpToolError('invalid_input', 'Audio messages cannot have a caption.', 'caption');
      }
      if (ctx.dryRun) {
        return {
          would_send: true,
          reply_window_expires_at: window.expires_at,
          meta_payload: redactedMetaBody({
            type: args.kind,
            [args.kind]: {
              link: args.media_url,
              ...(args.caption && args.kind !== 'audio' ? { caption: args.caption } : {}),
              ...(args.kind === 'document' && args.filename ? { filename: args.filename } : {}),
            },
          }),
        };
      }
      try {
        const r = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
          conversationId: args.conversation_id,
          messageType: args.kind,
          mediaUrl: args.media_url,
          contentText: args.caption ?? null,
          filename: args.filename ?? null,
        });
        return sendResult(r, args.conversation_id);
      } catch (err) {
        return mapSendError(err);
      }
    },
  }),

  defineTool({
    name: 'send_reaction',
    title: 'React to a message',
    description:
      'React to a message in a thread with an emoji (empty string removes your reaction). message_id is an id from get_conversation_thread; the message must have been delivered via WhatsApp.',
    scope: 'messages:send',
    tier: 'write',
    input: {
      message_id: z.string().uuid(),
      emoji: z.string().max(16).describe('A single emoji, or "" to remove the reaction.'),
    },
    handler: async (ctx, args) => {
      const message = await loadMessage(ctx, args.message_id);
      if (!message.message_id) {
        throw new McpToolError(
          'invalid_input',
          'That message has not been sent to WhatsApp, so it cannot be reacted to.',
          'message_id'
        );
      }
      if (!ctx.createdBy) {
        throw new McpToolError(
          'invalid_input',
          'This API key has no owning user to attribute the reaction to.'
        );
      }
      if (ctx.dryRun) {
        return {
          would_send: true,
          meta_payload: redactedMetaBody({
            type: 'reaction',
            reaction: { message_id: '<whatsapp message id>', emoji: args.emoji },
          }),
        };
      }
      try {
        await reactToMessage(ctx.supabase, ctx.accountId, ctx.createdBy, args.message_id, args.emoji);
      } catch (err) {
        if (err instanceof ReactError) {
          throw new McpToolError(
            err.status === 404 ? 'not_found' : err.status >= 500 ? 'upstream_error' : 'invalid_input',
            err.message
          );
        }
        throw err;
      }
      return { sent: true, message_id: args.message_id, emoji: args.emoji };
    },
  }),
];
