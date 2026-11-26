// MCP 2.0 — automations. See ../CONVENTIONS.md.
//
// These tools only CONFIGURE automations; nothing here sends a WhatsApp
// message. Validation reuses src/lib/automations/validate.ts (the same
// validators the dashboard API runs on activation) via definition.ts.
import { z } from 'zod';

import { checkAutomationDefinition, asBuilderSteps, type NormalisedStep } from '@/lib/automations/definition';
import { cloneAutomation, type AutomationRow } from '@/lib/automations/duplicate';
import { insertSteps, loadStepsTree, replaceSteps } from '@/lib/automations/steps-tree';
import type { ValidationIssue } from '@/lib/automations/validate';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../types';
import { cursorField, failDb, limitField, loadAccountRow, paginate, uuid } from './common-pgf';

const TRIGGERS = [
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
  'interactive_reply',
] as const;

const AUTOMATION_COLUMNS =
  'id, name, description, trigger_type, trigger_config, is_active, execution_count, last_executed_at, created_at, updated_at';

const stepInput = z.object({
  step_type: z.string().describe(
    'One of: send_message, send_buttons, send_list, send_template, add_tag, remove_tag, assign_conversation, update_contact_field, create_deal, wait, condition, send_webhook, close_conversation.'
  ),
  step_config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Config for the step type, e.g. send_message {text}, add_tag {tag_id}, wait {amount, unit: minutes|hours|days}, create_deal {pipeline_id, stage_id, title, value}, condition {subject, operand, value}.'
    ),
  branches: z
    .object({
      yes: z.array(z.record(z.string(), z.unknown())).optional(),
      no: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .optional()
    .describe('Only for condition steps: nested step lists for the yes / no branch (same shape as steps).'),
});

const triggerConfigField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Trigger settings. keyword_match {keywords: string[], match_type: exact|contains|word}; tag_added {tag_id}; time_based {schedule, timezone}; interactive_reply {reply_ids: string[]}. Others take {}.'
  );

function describeIssues(issues: ValidationIssue[]): { message: string; field: string } {
  const shown = issues.slice(0, 8).map((i) => `${i.path}: ${i.message}`);
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : '';
  return { message: `${issues.length} problem(s) - ${shown.join('; ')}${more}`, field: issues[0].path };
}

function throwIssues(issues: ValidationIssue[]): never {
  const { message, field } = describeIssues(issues);
  throw new McpToolError('invalid_input', message, field);
}

/** Check tag / pipeline / stage ids referenced by steps and the trigger belong to the account. */
async function referenceIssues(
  ctx: McpContext,
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  steps: NormalisedStep[]
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const tagIds = new Map<string, string>();
  const pipelineIds = new Map<string, string>();
  const stageChecks: { path: string; pipeline: string | null; stage: string }[] = [];
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

  if (triggerType === 'tag_added') {
    const t = str(triggerConfig.tag_id);
    if (t) tagIds.set('trigger.tag_id', t);
  }
  const walk = (list: NormalisedStep[], prefix: string) => {
    list.forEach((s, i) => {
      const path = `${prefix}steps[${i}]`;
      const c = s.step_config;
      if (s.step_type === 'add_tag' || s.step_type === 'remove_tag') {
        const t = str(c.tag_id);
        if (t) tagIds.set(`${path}.tag_id`, t);
      }
      if (s.step_type === 'create_deal') {
        const p = str(c.pipeline_id);
        const st = str(c.stage_id);
        if (p) pipelineIds.set(`${path}.pipeline_id`, p);
        if (st) stageChecks.push({ path: `${path}.stage_id`, pipeline: p, stage: st });
      }
      if (s.branches) {
        walk(s.branches.yes, `${path}.yes.`);
        walk(s.branches.no, `${path}.no.`);
      }
    });
  };
  walk(steps, '');

  const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

  if (tagIds.size > 0) {
    const ids = [...new Set(tagIds.values())].filter(isUuid);
    const { data } = ids.length
      ? await ctx.supabase.from('tags').select('id').eq('account_id', ctx.accountId).in('id', ids)
      : { data: [] };
    const found = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    for (const [path, id] of tagIds) {
      if (!found.has(id)) issues.push({ path, message: 'tag not found in this account' });
    }
  }
  if (pipelineIds.size > 0 || stageChecks.length > 0) {
    const ids = [...new Set(pipelineIds.values())].filter(isUuid);
    const { data } = ids.length
      ? await ctx.supabase.from('pipelines').select('id').eq('account_id', ctx.accountId).in('id', ids)
      : { data: [] };
    const found = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    for (const [path, id] of pipelineIds) {
      if (!found.has(id)) issues.push({ path, message: 'pipeline not found in this account' });
    }
    for (const sc of stageChecks) {
      if (!isUuid(sc.stage)) {
        issues.push({ path: sc.path, message: 'stage not found in this pipeline' });
        continue;
      }
      if (!sc.pipeline || !found.has(sc.pipeline)) continue; // already reported
      const { data: st } = await ctx.supabase
        .from('pipeline_stages')
        .select('id')
        .eq('id', sc.stage)
        .eq('pipeline_id', sc.pipeline)
        .maybeSingle();
      if (!st) issues.push({ path: sc.path, message: 'stage not found in this pipeline' });
    }
  }
  return issues;
}

async function loadAutomation(ctx: McpContext, id: string, columns = AUTOMATION_COLUMNS) {
  return loadAccountRow(ctx, 'automations', id, 'Automation', columns);
}

/** Validate a full definition. Returns normalised steps and the issue list (errors only matter when enabled). */
async function checkDefinition(
  ctx: McpContext,
  def: { trigger_type: string; trigger_config: Record<string, unknown>; steps: unknown }
) {
  const { steps, issues } = checkAutomationDefinition(def);
  const refs = await referenceIssues(ctx, def.trigger_type, def.trigger_config, steps);
  return { steps, issues: [...issues, ...refs] };
}

export const automationsTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_automations',
    description:
      'List automations, newest first, with their trigger and a summary of their steps (step types in order). Filter by is_active or trigger_type. Use get_automation for the full definition.',
    scope: 'automations:read',
    tier: 'read',
    input: {
      is_active: z.boolean().optional(),
      trigger_type: z.enum(TRIGGERS).optional(),
      limit: limitField,
      cursor: cursorField,
    },
    handler: async (ctx, args) => {
      let q = ctx.supabase.from('automations').select(AUTOMATION_COLUMNS).eq('account_id', ctx.accountId);
      if (args.is_active !== undefined) q = q.eq('is_active', args.is_active);
      if (args.trigger_type) q = q.eq('trigger_type', args.trigger_type);
      const page = await paginate<{ id: string; created_at: string }>(q, args);
      const ids = page.items.map((a) => a.id);
      const stepTypes = new Map<string, string[]>();
      if (ids.length > 0) {
        const { data, error } = await ctx.supabase
          .from('automation_steps')
          .select('automation_id, step_type, position')
          .in('automation_id', ids)
          .order('position', { ascending: true });
        if (error) failDb(error);
        for (const r of (data ?? []) as { automation_id: string; step_type: string }[]) {
          const list = stepTypes.get(r.automation_id) ?? [];
          list.push(r.step_type);
          stepTypes.set(r.automation_id, list);
        }
      }
      return {
        items: page.items.map((a) => ({
          ...a,
          step_count: stepTypes.get(a.id)?.length ?? 0,
          step_types: stepTypes.get(a.id) ?? [],
        })),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineTool({
    name: 'get_automation',
    description:
      'Get one automation in full: trigger, config and the nested step tree (condition steps carry branches.yes / branches.no). automation_id comes from list_automations.',
    scope: 'automations:read',
    tier: 'read',
    input: { automation_id: uuid('Automation id from list_automations.') },
    handler: async (ctx, args) => {
      const automation = await loadAutomation(ctx, args.automation_id);
      const steps = await loadStepsTree(args.automation_id, ctx.supabase);
      return { automation, steps };
    },
  }),

  defineTool({
    name: 'get_automation_logs',
    description:
      'Execution history of one automation, newest first: trigger event, status (success/partial/failed), per-step results and the error message. Contact ids only. Use it to find out why an automation failed.',
    scope: 'automations:read',
    tier: 'read',
    input: {
      automation_id: uuid('Automation id from list_automations.'),
      status: z.enum(['success', 'partial', 'failed']).optional(),
      limit: limitField,
      cursor: cursorField,
    },
    handler: async (ctx, args) => {
      await loadAutomation(ctx, args.automation_id, 'id');
      let q = ctx.supabase
        .from('automation_logs')
        .select('id, automation_id, contact_id, trigger_event, steps_executed, status, error_message, created_at')
        .eq('account_id', ctx.accountId)
        .eq('automation_id', args.automation_id);
      if (args.status) q = q.eq('status', args.status);
      return paginate(q, args);
    },
  }),

  defineTool({
    name: 'list_pending_automation_executions',
    description:
      'List automation runs that are parked on a wait step (status pending by default) with when they will resume. Use cancel_pending_execution to stop one.',
    scope: 'automations:read',
    tier: 'read',
    input: {
      automation_id: z.string().uuid().optional(),
      status: z.enum(['pending', 'running', 'done', 'failed']).optional().describe('Default pending.'),
      limit: limitField,
      cursor: cursorField,
    },
    handler: async (ctx, args) => {
      if (args.automation_id) await loadAutomation(ctx, args.automation_id, 'id');
      let q = ctx.supabase
        .from('automation_pending_executions')
        .select('id, automation_id, contact_id, status, run_at, next_step_position, created_at')
        .eq('account_id', ctx.accountId)
        .eq('status', args.status ?? 'pending');
      if (args.automation_id) q = q.eq('automation_id', args.automation_id);
      return paginate(q, args);
    },
  }),

  defineTool({
    name: 'cancel_pending_execution',
    description:
      'Cancel one pending (waiting) automation run so its remaining steps never fire. Only pending runs can be cancelled. Get execution_id from list_pending_automation_executions.',
    scope: 'automations:write',
    tier: 'write',
    input: { execution_id: uuid('Pending execution id.') },
    handler: async (ctx, args) => {
      const row = await loadAccountRow(
        ctx,
        'automation_pending_executions',
        args.execution_id,
        'Pending execution',
        'id, automation_id, status, context'
      );
      if (row.status !== 'pending') {
        throw new McpToolError('conflict', `This run is already ${String(row.status)}; only pending runs can be cancelled.`);
      }
      if (ctx.dryRun) return { would_cancel: args.execution_id, automation_id: row.automation_id };
      const prior = (row.context && typeof row.context === 'object' ? row.context : {}) as Record<string, unknown>;
      const { error } = await ctx.supabase
        .from('automation_pending_executions')
        .update({ status: 'failed', context: { ...prior, cancelled_via: 'mcp' } })
        .eq('id', args.execution_id)
        .eq('account_id', ctx.accountId)
        .eq('status', 'pending');
      if (error) failDb(error);
      return { cancelled: args.execution_id };
    },
  }),

  defineTool({
    name: 'create_automation',
    description:
      'Create an automation (trigger + steps). Saved disabled unless enabled: true. The trigger and steps are checked with the same validators as the dashboard; a disabled draft may be incomplete (problems come back as warnings), an enabled one must be valid. Look up tag_id / pipeline_id / stage_id first (list_tags, list_pipelines). Use dry_run to validate and see the normalised definition without saving. Configuring only: this never sends a message.',
    scope: 'automations:write',
    tier: 'write',
    input: {
      name: z.string().trim().min(1).max(120),
      description: z.string().max(500).optional(),
      trigger_type: z.enum(TRIGGERS),
      trigger_config: triggerConfigField,
      steps: z.array(stepInput).max(100).optional(),
      enabled: z.boolean().optional().describe('Turn it on immediately (default false).'),
    },
    handler: async (ctx, args) => {
      const trigger_config = args.trigger_config ?? {};
      const { steps, issues } = await checkDefinition(ctx, {
        trigger_type: args.trigger_type,
        trigger_config,
        steps: args.steps ?? [],
      });
      const enabled = args.enabled === true;
      if (enabled && issues.length > 0) throwIssues(issues);
      const definition = {
        name: args.name,
        description: args.description ?? null,
        trigger_type: args.trigger_type,
        trigger_config,
        is_active: enabled,
        steps,
      };
      if (ctx.dryRun) return { valid: issues.length === 0, warnings: issues, definition };
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no creating user, so an automation cannot be attributed.');
      }
      const { data, error } = await ctx.supabase
        .from('automations')
        .insert({
          account_id: ctx.accountId,
          user_id: ctx.createdBy,
          name: definition.name,
          description: definition.description,
          trigger_type: definition.trigger_type,
          trigger_config,
          is_active: enabled,
        })
        .select(AUTOMATION_COLUMNS)
        .single();
      if (error || !data) failDb(error);
      const stepErr = await insertSteps((data as { id: string }).id, asBuilderSteps(steps), ctx.supabase);
      if (stepErr) {
        await ctx.supabase.from('automations').delete().eq('id', (data as { id: string }).id).eq('account_id', ctx.accountId);
        throw new McpToolError('internal', stepErr);
      }
      return { automation: data, warnings: issues };
    },
  }),

  defineTool({
    name: 'update_automation',
    description:
      'Edit an automation: name, description, trigger and/or steps. Passing steps REPLACES the whole step tree, so send the complete tree (get_automation first). If the automation is enabled the result must be valid; a disabled one may stay incomplete (warnings). Does not turn it on or off - use set_automation_enabled. Use dry_run to preview the merged, validated definition.',
    scope: 'automations:write',
    tier: 'write',
    input: {
      automation_id: uuid('Automation id from list_automations.'),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      trigger_type: z.enum(TRIGGERS).optional(),
      trigger_config: triggerConfigField,
      steps: z.array(stepInput).max(100).optional(),
    },
    handler: async (ctx, args) => {
      const existing = await loadAutomation(ctx, args.automation_id);
      const trigger_type = (args.trigger_type ?? existing.trigger_type) as string;
      const trigger_config = (args.trigger_config ??
        (args.trigger_type ? {} : (existing.trigger_config as Record<string, unknown>)) ??
        {}) as Record<string, unknown>;
      const currentSteps = args.steps === undefined ? await loadStepsTree(args.automation_id, ctx.supabase) : null;
      const { steps, issues } = await checkDefinition(ctx, {
        trigger_type,
        trigger_config,
        steps: args.steps ?? currentSteps,
      });
      const isActive = existing.is_active === true;
      if (isActive && issues.length > 0) throwIssues(issues);

      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.trigger_type !== undefined) patch.trigger_type = args.trigger_type;
      if (args.trigger_config !== undefined || args.trigger_type !== undefined) patch.trigger_config = trigger_config;
      if (Object.keys(patch).length === 0 && args.steps === undefined) {
        throw new McpToolError('invalid_input', 'Pass at least one field to change.');
      }
      const definition = {
        name: (patch.name as string | undefined) ?? existing.name,
        description: patch.description !== undefined ? patch.description : existing.description,
        trigger_type,
        trigger_config,
        is_active: isActive,
        steps,
      };
      if (ctx.dryRun) return { valid: issues.length === 0, warnings: issues, definition };

      if (Object.keys(patch).length > 0) {
        const { error } = await ctx.supabase
          .from('automations')
          .update(patch)
          .eq('id', args.automation_id)
          .eq('account_id', ctx.accountId);
        if (error) failDb(error);
      }
      if (args.steps !== undefined) {
        const err = await replaceSteps(args.automation_id, asBuilderSteps(steps), ctx.supabase);
        if (err) throw new McpToolError('internal', err);
      }
      return { updated: args.automation_id, warnings: issues };
    },
  }),

  defineTool({
    name: 'set_automation_enabled',
    description:
      'Turn an automation on or off. Turning on re-validates the stored trigger and steps and refuses (invalid_input) if they are broken.',
    scope: 'automations:write',
    tier: 'write',
    input: { automation_id: uuid('Automation id from list_automations.'), enabled: z.boolean() },
    handler: async (ctx, args) => {
      const existing = await loadAutomation(ctx, args.automation_id);
      if (args.enabled) {
        const steps = await loadStepsTree(args.automation_id, ctx.supabase);
        const { issues } = await checkDefinition(ctx, {
          trigger_type: existing.trigger_type as string,
          trigger_config: (existing.trigger_config ?? {}) as Record<string, unknown>,
          steps,
        });
        if (issues.length > 0) throwIssues(issues);
      }
      if (ctx.dryRun) {
        return { would_update: { automation_id: args.automation_id, from: existing.is_active, is_active: args.enabled } };
      }
      const { error } = await ctx.supabase
        .from('automations')
        .update({ is_active: args.enabled })
        .eq('id', args.automation_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      return { automation_id: args.automation_id, is_active: args.enabled };
    },
  }),

  defineTool({
    name: 'duplicate_automation',
    description: 'Copy an automation and its steps into a new, disabled automation named "<name> (Copy)".',
    scope: 'automations:write',
    tier: 'write',
    input: { automation_id: uuid('Automation id from list_automations.') },
    handler: async (ctx, args) => {
      const original = await loadAutomation(ctx, args.automation_id, '*');
      if (ctx.dryRun) return { would_create: { name: `${String(original.name)} (Copy)`, is_active: false } };
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no creating user, so an automation cannot be attributed.');
      }
      const result = await cloneAutomation(ctx.supabase, original as unknown as AutomationRow, ctx.createdBy);
      if ('error' in result) throw new McpToolError('internal', result.error);
      const { id, name, is_active } = result.copy as { id: string; name: string; is_active: boolean };
      return { automation: { id, name, is_active } };
    },
  }),

  defineTool({
    name: 'delete_automation',
    description: 'Permanently delete an automation with its steps, logs and pending runs. Cannot be undone; consider set_automation_enabled false instead.',
    scope: 'automations:write',
    tier: 'destructive',
    input: { automation_id: uuid('Automation id from list_automations.') },
    handler: async (ctx, args) => {
      const existing = await loadAutomation(ctx, args.automation_id, 'id, name');
      if (ctx.dryRun) return { would_delete: { automation_id: args.automation_id, name: existing.name } };
      const { error } = await ctx.supabase
        .from('automations')
        .delete()
        .eq('id', args.automation_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      return { deleted: args.automation_id };
    },
  }),
];
