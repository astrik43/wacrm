// Broadcast write tools (scope broadcasts:send): drafts, test sends,
// the real send, resume and delete. The audience, variable, button and
// header rules are the wizard's (src/lib/broadcasts/*, shared with the
// hook); delivery is the dashboard's (broadcast-core / broadcast-resume).

import { z } from 'zod';

import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { resolveServerAudience, type AudienceContact } from '@/lib/broadcasts/audience';
import { runBroadcastDelivery, sendSingleTemplate } from '@/lib/broadcasts/delivery';
import {
  BROADCAST_MAX_RECIPIENTS,
  buildTemplateSendPayload,
  estimateBroadcastCost,
  recipientTemplateParams,
} from '@/lib/broadcasts/payload';
import { fetchCustomValueIndex, headerMediaUrlFor } from '@/lib/broadcasts/shared';
import { toStoredTemplateVariables, fromStoredTemplateVariables } from '@/lib/broadcast-template-variables';
import { normalizeKey } from '@/lib/contacts/dedupe';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { parseRecipientParams } from '@/lib/whatsapp/recipient-params';

import { McpToolError } from '../../errors';
import { defineTool, type McpContext } from '../../types';
import {
  assertCustomFieldsInAccount,
  audienceSchema,
  buttonVariablesSchema,
  loadBroadcast,
  loadSendableTemplate,
  mapError,
  toButtonVariables,
  toServerAudience,
  validateTemplateInputs,
  variablesSchema,
  type AudienceInput,
} from './common';

const templateInput = {
  template_name: z.string().min(1).describe('Name of an APPROVED template (list_templates).'),
  template_language: z.string().optional().describe('Template language code, e.g. en or en_US. Defaults to the template on file.'),
  variables: variablesSchema,
  button_variables: buttonVariablesSchema,
  header_media_url: z
    .string()
    .optional()
    .describe('Public https link for an IMAGE/VIDEO/DOCUMENT header. Falls back to the template\'s own link.'),
};

/** Build the Meta payload for one contact, turning builder failures into a tool error. */
function payloadFor(args: {
  template: Parameters<typeof buildTemplateSendPayload>[0]['template'];
  templateName: string;
  language: string;
  stored: unknown;
}) {
  try {
    return buildTemplateSendPayload(args);
  } catch (err) {
    throw new McpToolError('invalid_input', err instanceof Error ? err.message : 'Template could not be built');
  }
}

async function auditUser(ctx: McpContext): Promise<string> {
  if (ctx.createdBy) return ctx.createdBy;
  try {
    return await resolveAuditUserId(ctx.supabase, ctx.accountId);
  } catch {
    throw new McpToolError('internal', 'Could not resolve the account owner to attribute this broadcast to.');
  }
}

function auditAudienceFilter(a: AudienceInput) {
  // Same shape the wizard stores. Phone numbers are never stored here.
  return {
    type: a.type,
    tagIds: a.tag_ids,
    excludeTagIds: a.exclude_tag_ids,
    customField: a.custom_field
      ? { fieldId: a.custom_field.field_id, operator: a.custom_field.operator, value: a.custom_field.value }
      : undefined,
    contactIds: a.contact_ids,
    phoneCount: a.phones?.length,
  };
}

const hasPhone = (c: AudienceContact) => isValidE164(sanitizePhoneForMeta(c.phone ?? ''));

export const broadcastSendTools = [
  defineTool({
    name: 'create_broadcast_draft',
    title: 'Save a broadcast draft',
    description:
      'Save a broadcast as a draft without sending it: template, variable mapping and (optionally) the audience. Nothing is sent. The draft can then be test-sent with send_broadcast_test using its broadcast_id.',
    scope: 'broadcasts:send',
    tier: 'write',
    input: {
      name: z.string().min(1).max(200),
      ...templateInput,
      audience: audienceSchema.optional(),
    },
    handler: async (ctx, args) => {
      const { template, language } = await loadSendableTemplate(ctx, args.template_name, args.template_language);
      const buttonVariables = toButtonVariables(args.button_variables);
      await assertCustomFieldsInAccount(ctx, [...Object.values(args.variables), ...Object.values(buttonVariables)]);
      if (args.audience) {
        try {
          // Validates every id in the audience against the account.
          await resolveServerAudience(ctx.supabase, ctx.accountId, toServerAudience(args.audience), { cap: 1 });
        } catch (err) {
          mapError(err);
        }
      }
      const row = {
        name: args.name,
        template_name: args.template_name,
        template_language: language,
        template_variables: toStoredTemplateVariables({
          variables: args.variables,
          buttonVariables,
          headerMediaUrl: headerMediaUrlFor(template, args.header_media_url) ?? '',
        }),
        audience_filter: args.audience ? auditAudienceFilter(args.audience) : {},
        status: 'draft',
        total_recipients: 0,
      };
      if (ctx.dryRun) return { would_create: row };

      const { data, error } = await ctx.supabase
        .from('broadcasts')
        .insert({ ...row, account_id: ctx.accountId, user_id: await auditUser(ctx) })
        .select('id')
        .single();
      if (error || !data) throw new McpToolError('internal', 'Failed to save the draft');
      return { broadcast_id: data.id, status: 'draft' };
    },
  }),

  defineTool({
    name: 'send_broadcast_test',
    title: 'Send a broadcast test',
    description:
      'Send the broadcast message to ONE phone number so it can be checked on a real phone. Records nothing. Variables fill from the contact with that number, or from a stand-in named "Test". Give template_name + variables, or a saved broadcast_id to reuse its template and values. dry_run returns the exact Meta payload without sending.',
    scope: 'broadcasts:send',
    tier: 'write',
    input: {
      phone: z.string().min(5).max(40).describe('International number with country code.'),
      broadcast_id: z.string().uuid().optional().describe('A saved draft or sent broadcast to reuse (instead of template_name).'),
      template_name: z.string().optional(),
      template_language: z.string().optional(),
      variables: variablesSchema,
      button_variables: buttonVariablesSchema,
      header_media_url: z.string().optional(),
    },
    handler: async (ctx, args) => {
      let templateName = args.template_name;
      let templateLanguage = args.template_language;
      let variables = args.variables;
      let buttonVariables = toButtonVariables(args.button_variables);
      let headerMediaUrl = args.header_media_url;

      if (args.broadcast_id) {
        const saved = await loadBroadcast(ctx, args.broadcast_id, 'id, template_name, template_language, template_variables');
        const stored = fromStoredTemplateVariables(saved.template_variables);
        templateName = saved.template_name as string;
        templateLanguage = saved.template_language as string;
        variables = stored.variables;
        buttonVariables = stored.buttonVariables;
        headerMediaUrl = args.header_media_url ?? stored.headerMediaUrl;
      }
      if (!templateName) {
        throw new McpToolError('invalid_input', 'Give template_name or a saved broadcast_id.', 'template_name');
      }

      const { template, language } = await loadSendableTemplate(ctx, templateName, templateLanguage);
      validateTemplateInputs(template, variables, buttonVariables, headerMediaUrl);
      await assertCustomFieldsInAccount(ctx, [...Object.values(variables), ...Object.values(buttonVariables)]);

      const phone = sanitizePhoneForMeta(args.phone);
      if (!isValidE164(phone)) {
        throw new McpToolError('invalid_input', 'phone must be a valid international number, e.g. +14155550123.', 'phone');
      }

      // The contact with this number, if the account has one (staff are fine: a test is one message to one number).
      const key = normalizeKey(phone);
      const { data: found } = await ctx.supabase
        .from('contacts')
        .select('id, name, phone, email, company')
        .eq('account_id', ctx.accountId)
        .eq('phone_normalized', key)
        .limit(1)
        .maybeSingle();
      const contact = (found as AudienceContact | null) ?? { id: '', name: 'Test', phone, email: null, company: null };
      const customValues = found
        ? (await fetchCustomValueIndex(ctx.supabase, [contact.id])).get(contact.id)
        : undefined;

      const stored = recipientTemplateParams({
        template,
        variables,
        buttonVariables,
        headerMediaUrl,
        contact,
        customValues,
      });
      const payload = payloadFor({ template, templateName, language, stored });
      if (ctx.dryRun) return { payload, contact_found: Boolean(found) };

      const { params, messageParams } = parseRecipientParams(stored);
      try {
        const messageId = await sendSingleTemplate({
          db: ctx.supabase,
          accountId: ctx.accountId,
          phone,
          template,
          templateName,
          language,
          params,
          messageParams,
        });
        return { sent: true, whatsapp_message_id: messageId, contact_found: Boolean(found) };
      } catch (err) {
        throw new McpToolError('upstream_error', err instanceof Error ? err.message : 'Test send failed');
      }
    },
  }),

  defineTool({
    name: 'send_broadcast',
    title: 'Send a broadcast',
    description: `Create a broadcast and send the template to an audience. THIS MESSAGES REAL PEOPLE and cannot be recalled. Always run estimate_audience first, then call with dry_run: true (returns the recipient count, the exact Meta payload for the first recipient and the estimated cost), show the user, and only then call with confirm: true. At most ${BROADCAST_MAX_RECIPIENTS} recipients per call. Staff contacts are never included. Delivery continues after the call returns: poll get_broadcast, and use resume_broadcast if it stalls.`,
    scope: 'broadcasts:send',
    tier: 'destructive',
    input: {
      name: z.string().min(1).max(200).describe('Label for the broadcast, shown in the dashboard.'),
      ...templateInput,
      audience: audienceSchema,
    },
    handler: async (ctx, args) => {
      const { template, language } = await loadSendableTemplate(ctx, args.template_name, args.template_language);
      const buttonVariables = toButtonVariables(args.button_variables);
      validateTemplateInputs(template, args.variables, buttonVariables, args.header_media_url);
      await assertCustomFieldsInAccount(ctx, [...Object.values(args.variables), ...Object.values(buttonVariables)]);

      const audienceUser = ctx.dryRun ? undefined : await auditUser(ctx);
      let resolved;
      try {
        resolved = await resolveServerAudience(ctx.supabase, ctx.accountId, toServerAudience(args.audience), {
          cap: BROADCAST_MAX_RECIPIENTS + 1,
          createMissing: audienceUser ? { auditUserId: audienceUser } : undefined,
        });
      } catch (err) {
        mapError(err);
      }

      const sendable = resolved.contacts.filter(hasPhone);
      // A dry run has not created the contacts a phone list names, so count them too.
      const total = sendable.length + (ctx.dryRun ? resolved.unmatchedPhones : 0);
      if (resolved.capped || total > BROADCAST_MAX_RECIPIENTS) {
        throw new McpToolError(
          'invalid_input',
          `This audience is larger than ${BROADCAST_MAX_RECIPIENTS} contacts, the limit per call. Narrow it (tags, exclude_tag_ids, contact_ids) and send in parts.`,
          'audience'
        );
      }
      if (total === 0) {
        throw new McpToolError('invalid_input', 'No contacts found for this audience (staff contacts and numbers without a valid phone are skipped).', 'audience');
      }

      const customIndex = await fetchCustomValueIndex(ctx.supabase, sendable.map((c) => c.id));
      const paramsFor = (contact: AudienceContact) =>
        recipientTemplateParams({
          template,
          variables: args.variables,
          buttonVariables,
          headerMediaUrl: args.header_media_url,
          contact,
          customValues: customIndex.get(contact.id),
        });

      // Build the first message now: a template that cannot be built fails here, before anything is created.
      const first = sendable[0] ?? { id: '', name: 'Test', phone: null, email: null, company: null };
      const firstStored = paramsFor(first);
      const payload = payloadFor({ template, templateName: args.template_name, language, stored: firstStored });
      const cost = estimateBroadcastCost(template.category, total);

      const summary = {
        recipients: total,
        staff_excluded: resolved.staffExcluded,
        skipped_without_valid_phone: resolved.contacts.length - sendable.length,
        first_recipient_payload: payload,
        estimated_cost: cost,
        ...(cost ? {} : { cost_note: `No rate is known for the '${template.category}' category, so the cost could not be estimated.` }),
      };
      if (ctx.dryRun) return summary;

      const { data: config } = await ctx.supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!config) {
        throw new McpToolError('conflict', 'WhatsApp is not connected for this account. Connect it in Settings first.');
      }

      const { data: created, error: createErr } = await ctx.supabase.rpc('create_broadcast_with_recipients', {
        p_account_id: ctx.accountId,
        p_user_id: audienceUser,
        p_name: args.name,
        p_template_name: args.template_name,
        p_template_language: language,
        p_total_recipients: sendable.length,
        p_contact_ids: sendable.map((c) => c.id),
        // Frozen per recipient so a resume sends exactly what this pass would.
        p_template_params: sendable.map(paramsFor),
      });
      if (createErr || !created || created.length === 0) {
        throw new McpToolError('internal', 'Failed to create the broadcast. Nothing was sent.');
      }
      const broadcastId = created[0].broadcast_id as string;

      // Keep the mapping and audience on the row, so the broadcast can be test-sent or reviewed later.
      await ctx.supabase
        .from('broadcasts')
        .update({
          template_variables: toStoredTemplateVariables({
            variables: args.variables,
            buttonVariables,
            headerMediaUrl: headerMediaUrlFor(template, args.header_media_url) ?? '',
          }),
          audience_filter: auditAudienceFilter(args.audience),
        })
        .eq('id', broadcastId)
        .eq('account_id', ctx.accountId);

      // Deliver through the same lock + plan the dashboard's resume uses.
      const claimed = await claimBroadcastDelivery(ctx.supabase, ctx.accountId, broadcastId);
      if (!claimed) {
        throw new McpToolError('conflict', `Broadcast ${broadcastId} was created but could not start. Call resume_broadcast.`);
      }
      let plan;
      try {
        ({ plan } = await planBroadcastResume(ctx.supabase, ctx.accountId, broadcastId, 'pending'));
      } catch (err) {
        await releaseBroadcastDelivery(ctx.supabase, broadcastId).catch(() => {});
        try {
          mapError(err);
        } catch (mapped) {
          throw new McpToolError(
            mapped instanceof McpToolError ? mapped.code : 'internal',
            `Broadcast ${broadcastId} was created but not sent: ${mapped instanceof Error ? mapped.message : 'unknown error'} Fix that, then call resume_broadcast.`
          );
        }
        throw err;
      }
      await markBroadcastSending(ctx.supabase, broadcastId);
      const run = await runBroadcastDelivery(ctx.supabase, plan);

      return {
        broadcast_id: broadcastId,
        status: run.deferred ? 'sending' : 'sent',
        recipients: sendable.length,
        staff_excluded: resolved.staffExcluded,
        estimated_cost: cost,
      };
    },
  }),

  defineTool({
    name: 'resume_broadcast',
    title: 'Resume or retry a broadcast',
    description:
      'Send the recipients of an existing broadcast that did not go out: scope "pending" (never attempted, e.g. it stalled), "failed" (retry the failures) or "all" (both). Messages real people, so run dry_run first to see how many, then confirm. Refuses while another delivery pass is running. At most 1000 recipients per call; run it again if some remain.',
    scope: 'broadcasts:send',
    tier: 'destructive',
    input: {
      broadcast_id: z.string().uuid(),
      scope: z.enum(['pending', 'failed', 'all']).optional().describe('Which recipients to send (default pending).'),
    },
    handler: async (ctx, args) => {
      const scope = args.scope ?? 'pending';
      const broadcast = await loadBroadcast(ctx, args.broadcast_id);
      if (broadcast.status === 'draft') {
        throw new McpToolError('conflict', 'This is a draft with no recipients. Use send_broadcast to send it.');
      }

      if (ctx.dryRun) {
        const statuses = scope === 'pending' ? ['pending'] : scope === 'failed' ? ['failed'] : ['pending', 'failed'];
        const { count } = await ctx.supabase
          .from('broadcast_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('broadcast_id', args.broadcast_id)
          .in('status', statuses);
        return {
          broadcast_id: args.broadcast_id,
          scope,
          would_send: Math.min(count ?? 0, BROADCAST_MAX_RECIPIENTS),
          remaining_after: Math.max(0, (count ?? 0) - BROADCAST_MAX_RECIPIENTS),
          delivering_now: Boolean(broadcast.delivery_locked_at),
        };
      }

      // Claim BEFORE planning: two overlapping passes would message everyone twice.
      const claimed = await claimBroadcastDelivery(ctx.supabase, ctx.accountId, args.broadcast_id);
      if (!claimed) {
        throw new McpToolError('conflict', 'A delivery pass is already running for this broadcast. Wait for it to finish, then resume again.');
      }
      let result;
      try {
        result = await planBroadcastResume(ctx.supabase, ctx.accountId, args.broadcast_id, scope);
        await markBroadcastSending(ctx.supabase, args.broadcast_id);
      } catch (err) {
        await releaseBroadcastDelivery(ctx.supabase, args.broadcast_id).catch(() => {});
        mapError(err);
      }
      await runBroadcastDelivery(ctx.supabase, result.plan);
      return {
        broadcast_id: args.broadcast_id,
        scope,
        resuming: result.plan.planned.length,
        remaining: result.remaining,
        unsendable: result.unsendable,
      };
    },
  }),

  defineTool({
    name: 'delete_broadcast',
    title: 'Delete a broadcast',
    description:
      'Delete a broadcast and its recipient history. Refuses while it is sending. Messages already delivered are not recalled. Cannot be undone.',
    scope: 'broadcasts:send',
    tier: 'destructive',
    input: { broadcast_id: z.string().uuid() },
    handler: async (ctx, args) => {
      const broadcast = await loadBroadcast(ctx, args.broadcast_id);
      if (broadcast.status === 'sending' || broadcast.delivery_locked_at) {
        throw new McpToolError('conflict', 'This broadcast is sending. Wait for it to finish before deleting it.');
      }
      if (ctx.dryRun) {
        return { would_delete: { broadcast_id: args.broadcast_id, name: broadcast.name, recipients: broadcast.total_recipients } };
      }
      const { error } = await ctx.supabase
        .from('broadcasts')
        .delete()
        .eq('id', args.broadcast_id)
        .eq('account_id', ctx.accountId);
      if (error) throw new McpToolError('internal', 'Failed to delete the broadcast');
      return { deleted: true, broadcast_id: args.broadcast_id };
    },
  }),
];
