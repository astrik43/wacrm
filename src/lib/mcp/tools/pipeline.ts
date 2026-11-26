// MCP 2.0 — pipelines and deals. See ../CONVENTIONS.md.
//
// pipelines and deals carry account_id; pipeline_stages does not (it hangs
// off pipelines), so every stage lookup goes through its pipeline.
import { z } from 'zod';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../types';
import {
  cursorField,
  failDb,
  limitField,
  loadAccountRow,
  paginate,
  uuid,
} from './common-pgf';

const DEAL_COLUMNS =
  'id, pipeline_id, stage_id, contact_id, title, value, currency, status, assigned_to, expected_close_date, created_at, updated_at';
const DEAL_DETAIL_COLUMNS = `${DEAL_COLUMNS}, notes, conversation_id`;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .describe('Date as YYYY-MM-DD.');
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour')
  .describe('Stage colour as #rrggbb.');

interface StageRow {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color: string;
}

async function loadPipeline(ctx: McpContext, id: string) {
  return loadAccountRow(ctx, 'pipelines', id, 'Pipeline', 'id, name, created_at');
}

/** A stage is the account's only if its pipeline is. */
async function loadStage(ctx: McpContext, stageId: string): Promise<StageRow> {
  const { data, error } = await ctx.supabase
    .from('pipeline_stages')
    .select('id, pipeline_id, name, position, color')
    .eq('id', stageId)
    .maybeSingle();
  if (error) failDb(error);
  if (!data) throw new McpToolError('not_found', `Stage ${stageId} not found in this account.`);
  const stage = data as StageRow;
  await loadPipeline(ctx, stage.pipeline_id); // not_found when another account's
  return stage;
}

async function listStages(ctx: McpContext, pipelineId: string): Promise<StageRow[]> {
  const { data, error } = await ctx.supabase
    .from('pipeline_stages')
    .select('id, pipeline_id, name, position, color')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true });
  if (error) failDb(error);
  return (data ?? []) as StageRow[];
}

async function countDealsInStage(ctx: McpContext, stageId: string): Promise<number> {
  const { count, error } = await ctx.supabase
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId)
    .eq('stage_id', stageId);
  if (error) failDb(error);
  return count ?? 0;
}

async function assertContact(ctx: McpContext, contactId: string): Promise<void> {
  await loadAccountRow(ctx, 'contacts', contactId, 'Contact', 'id');
}

/** deals.assigned_to references profiles.id. */
async function assertAssignee(ctx: McpContext, profileId: string): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('id')
    .eq('id', profileId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) failDb(error);
  if (!data) {
    throw new McpToolError(
      'not_found',
      `Team member ${profileId} not found in this account. Use the team members list for valid ids.`,
      'assigned_to'
    );
  }
}

async function loadDeal(ctx: McpContext, dealId: string, detail = false) {
  return loadAccountRow(ctx, 'deals', dealId, 'Deal', detail ? DEAL_DETAIL_COLUMNS : DEAL_COLUMNS);
}

async function setDealStatus(
  ctx: McpContext,
  dealId: string,
  status: 'open' | 'won' | 'lost',
  reason?: string
) {
  const deal = await loadDeal(ctx, dealId, true);
  const patch: Record<string, unknown> = { status };
  if (reason) {
    const prior = typeof deal.notes === 'string' && deal.notes ? `${deal.notes}\n` : '';
    patch.notes = `${prior}Lost reason: ${reason}`;
  }
  if (ctx.dryRun) {
    return { would_update: { deal_id: dealId, from_status: deal.status, ...patch } };
  }
  const { data, error } = await ctx.supabase
    .from('deals')
    .update(patch)
    .eq('id', dealId)
    .eq('account_id', ctx.accountId)
    .select(DEAL_COLUMNS)
    .single();
  if (error) failDb(error);
  return { deal: data };
}

export const pipelineTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_pipelines',
    description:
      'List the sales pipelines with their stages in order. Call this first to get the pipeline_id and stage_id values the deal and stage tools need.',
    scope: 'deals:read',
    tier: 'read',
    input: {},
    handler: async (ctx) => {
      const { data, error } = await ctx.supabase
        .from('pipelines')
        .select('id, name, created_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: true });
      if (error) failDb(error);
      const pipelines = (data ?? []) as { id: string; name: string; created_at: string }[];
      const items = [];
      for (const p of pipelines) {
        items.push({ ...p, stages: await listStages(ctx, p.id) });
      }
      return { items };
    },
  }),

  defineTool({
    name: 'create_stage',
    description:
      'Add a stage to a pipeline. By default it goes last; pass position (0-based) to insert earlier and shift the rest. Get pipeline_id from list_pipelines.',
    scope: 'deals:write',
    tier: 'write',
    input: {
      pipeline_id: uuid('Pipeline id from list_pipelines.'),
      name: z.string().trim().min(1).max(80),
      color: hexColor.optional(),
      position: z.number().int().min(0).optional().describe('0-based insert position (default: last).'),
    },
    handler: async (ctx, args) => {
      await loadPipeline(ctx, args.pipeline_id);
      const stages = await listStages(ctx, args.pipeline_id);
      const at = Math.min(args.position ?? stages.length, stages.length);
      if (ctx.dryRun) {
        return { would_create: { pipeline_id: args.pipeline_id, name: args.name, position: at } };
      }
      const { data, error } = await ctx.supabase
        .from('pipeline_stages')
        .insert({
          pipeline_id: args.pipeline_id,
          name: args.name,
          color: args.color ?? '#3b82f6',
          position: at,
        })
        .select('id, pipeline_id, name, position, color')
        .single();
      if (error) failDb(error);
      // Shift the stages that now sit at or after the insert point.
      for (let i = at; i < stages.length; i++) {
        const { error: e } = await ctx.supabase
          .from('pipeline_stages')
          .update({ position: i + 1 })
          .eq('id', stages[i].id)
          .eq('pipeline_id', args.pipeline_id);
        if (e) failDb(e);
      }
      return { stage: data };
    },
  }),

  defineTool({
    name: 'rename_stage',
    description: 'Rename a stage and/or change its colour. Get stage_id from list_pipelines.',
    scope: 'deals:write',
    tier: 'write',
    input: {
      stage_id: uuid('Stage id from list_pipelines.'),
      name: z.string().trim().min(1).max(80).optional(),
      color: hexColor.optional(),
    },
    handler: async (ctx, args) => {
      const stage = await loadStage(ctx, args.stage_id);
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.color !== undefined) patch.color = args.color;
      if (Object.keys(patch).length === 0) {
        throw new McpToolError('invalid_input', 'Pass a name and/or a color.', 'name');
      }
      if (ctx.dryRun) return { would_update: { stage_id: stage.id, ...patch } };
      const { data, error } = await ctx.supabase
        .from('pipeline_stages')
        .update(patch)
        .eq('id', stage.id)
        .eq('pipeline_id', stage.pipeline_id)
        .select('id, pipeline_id, name, position, color')
        .single();
      if (error) failDb(error);
      return { stage: data };
    },
  }),

  defineTool({
    name: 'reorder_stages',
    description:
      'Set the left-to-right order of a pipeline\'s stages. stage_ids must list EVERY stage of the pipeline exactly once, in the new order (see list_pipelines).',
    scope: 'deals:write',
    tier: 'write',
    input: {
      pipeline_id: uuid('Pipeline id from list_pipelines.'),
      stage_ids: z.array(z.string().uuid()).min(1).describe('All stage ids of the pipeline, in the new order.'),
    },
    handler: async (ctx, args) => {
      await loadPipeline(ctx, args.pipeline_id);
      const stages = await listStages(ctx, args.pipeline_id);
      const have = new Set(stages.map((s) => s.id));
      const want = new Set(args.stage_ids);
      if (
        want.size !== args.stage_ids.length ||
        want.size !== have.size ||
        [...want].some((id) => !have.has(id))
      ) {
        throw new McpToolError(
          'invalid_input',
          'stage_ids must contain every stage of this pipeline exactly once. Call list_pipelines for the current stages.',
          'stage_ids'
        );
      }
      if (ctx.dryRun) {
        return { would_reorder: args.stage_ids.map((id, position) => ({ stage_id: id, position })) };
      }
      for (let i = 0; i < args.stage_ids.length; i++) {
        const { error } = await ctx.supabase
          .from('pipeline_stages')
          .update({ position: i })
          .eq('id', args.stage_ids[i])
          .eq('pipeline_id', args.pipeline_id);
        if (error) failDb(error);
      }
      return { stages: await listStages(ctx, args.pipeline_id) };
    },
  }),

  defineTool({
    name: 'delete_stage',
    description:
      'Delete a pipeline stage. If deals still sit in it you must pass move_deals_to_stage_id (another stage of the same pipeline) and they are moved there first; otherwise it is refused. Use dry_run to see how many deals are affected.',
    scope: 'deals:write',
    tier: 'destructive',
    input: {
      stage_id: uuid('Stage to delete (list_pipelines).'),
      move_deals_to_stage_id: z
        .string()
        .uuid()
        .optional()
        .describe('Another stage of the same pipeline that receives the stage\'s deals.'),
    },
    handler: async (ctx, args) => {
      const stage = await loadStage(ctx, args.stage_id);
      const dealCount = await countDealsInStage(ctx, stage.id);
      let target: StageRow | null = null;
      if (args.move_deals_to_stage_id) {
        target = await loadStage(ctx, args.move_deals_to_stage_id);
        if (target.id === stage.id || target.pipeline_id !== stage.pipeline_id) {
          throw new McpToolError(
            'invalid_input',
            'move_deals_to_stage_id must be a different stage of the same pipeline.',
            'move_deals_to_stage_id'
          );
        }
      }
      if (dealCount > 0 && !target) {
        throw new McpToolError(
          'conflict',
          `Stage still has ${dealCount} deal(s). Pass move_deals_to_stage_id to move them, or move them first with move_deal_stage.`,
          'move_deals_to_stage_id'
        );
      }
      if (ctx.dryRun) {
        return {
          would_delete_stage: stage.id,
          deals_moved: dealCount,
          move_deals_to_stage_id: target?.id ?? null,
        };
      }
      if (dealCount > 0 && target) {
        const { error } = await ctx.supabase
          .from('deals')
          .update({ stage_id: target.id })
          .eq('account_id', ctx.accountId)
          .eq('stage_id', stage.id);
        if (error) failDb(error);
      }
      const { error } = await ctx.supabase
        .from('pipeline_stages')
        .delete()
        .eq('id', stage.id)
        .eq('pipeline_id', stage.pipeline_id);
      if (error) failDb(error);
      return { deleted: stage.id, deals_moved: dealCount };
    },
  }),

  defineTool({
    name: 'list_deals',
    description:
      'List deals, newest first. Filter by pipeline_id, stage_id, owner (assigned_to profile id), status (open/won/lost) and value range. Returns contact ids, not phone numbers. Use next_cursor to page.',
    scope: 'deals:read',
    tier: 'read',
    input: {
      pipeline_id: z.string().uuid().optional(),
      stage_id: z.string().uuid().optional(),
      assigned_to: z.string().uuid().optional().describe('Owner: a team member profile id.'),
      status: z.enum(['open', 'won', 'lost']).optional(),
      min_value: z.number().optional(),
      max_value: z.number().optional(),
      limit: limitField,
      cursor: cursorField,
    },
    handler: async (ctx, args) => {
      if (args.pipeline_id) await loadPipeline(ctx, args.pipeline_id);
      if (args.stage_id) await loadStage(ctx, args.stage_id);
      let q = ctx.supabase.from('deals').select(DEAL_COLUMNS).eq('account_id', ctx.accountId);
      if (args.pipeline_id) q = q.eq('pipeline_id', args.pipeline_id);
      if (args.stage_id) q = q.eq('stage_id', args.stage_id);
      if (args.assigned_to) q = q.eq('assigned_to', args.assigned_to);
      if (args.status) q = q.eq('status', args.status);
      if (args.min_value !== undefined) q = q.gte('value', args.min_value);
      if (args.max_value !== undefined) q = q.lte('value', args.max_value);
      return paginate(q, args);
    },
  }),

  defineTool({
    name: 'get_deal',
    description: 'Get one deal with its notes. deal_id comes from list_deals.',
    scope: 'deals:read',
    tier: 'read',
    input: { deal_id: uuid('Deal id from list_deals.') },
    handler: async (ctx, args) => ({ deal: await loadDeal(ctx, args.deal_id, true) }),
  }),

  defineTool({
    name: 'create_deal',
    description:
      'Create a deal for a contact in a pipeline. stage_id defaults to the first stage. Currency defaults to the account currency. Use list_pipelines for ids and the contacts search for contact_id.',
    scope: 'deals:write',
    tier: 'write',
    input: {
      pipeline_id: uuid('Pipeline id from list_pipelines.'),
      contact_id: uuid('Contact the deal is for.'),
      title: z.string().trim().min(1).max(200),
      stage_id: z.string().uuid().optional().describe('Defaults to the pipeline\'s first stage.'),
      value: z.number().min(0).max(9_999_999_999).optional(),
      currency: z.string().trim().length(3).optional(),
      assigned_to: z.string().uuid().optional().describe('Owner: team member profile id.'),
      notes: z.string().max(5000).optional(),
      expected_close_date: isoDate.optional(),
    },
    handler: async (ctx, args) => {
      await loadPipeline(ctx, args.pipeline_id);
      await assertContact(ctx, args.contact_id);
      let stageId = args.stage_id;
      if (stageId) {
        const stage = await loadStage(ctx, stageId);
        if (stage.pipeline_id !== args.pipeline_id) {
          throw new McpToolError('invalid_input', 'stage_id belongs to a different pipeline.', 'stage_id');
        }
      } else {
        const first = (await listStages(ctx, args.pipeline_id))[0];
        if (!first) {
          throw new McpToolError('invalid_input', 'This pipeline has no stages. Run create_stage first.', 'pipeline_id');
        }
        stageId = first.id;
      }
      if (args.assigned_to) await assertAssignee(ctx, args.assigned_to);
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no creating user, so a deal cannot be attributed.');
      }

      let currency = args.currency?.toUpperCase();
      if (!currency) {
        const { data: acct } = await ctx.supabase
          .from('accounts')
          .select('default_currency')
          .eq('id', ctx.accountId)
          .maybeSingle();
        currency = (acct as { default_currency?: string } | null)?.default_currency ?? 'USD';
      }
      const row = {
        account_id: ctx.accountId,
        user_id: ctx.createdBy,
        pipeline_id: args.pipeline_id,
        stage_id: stageId,
        contact_id: args.contact_id,
        title: args.title,
        value: args.value ?? 0,
        currency,
        assigned_to: args.assigned_to ?? null,
        notes: args.notes ?? null,
        expected_close_date: args.expected_close_date ?? null,
        status: 'open',
      };
      if (ctx.dryRun) {
        const { user_id: _u, account_id: _a, ...preview } = row;
        void _u;
        void _a;
        return { would_create: preview };
      }
      const { data, error } = await ctx.supabase.from('deals').insert(row).select(DEAL_COLUMNS).single();
      if (error) failDb(error);
      return { deal: data };
    },
  }),

  defineTool({
    name: 'update_deal',
    description:
      'Edit a deal\'s title, value, currency, notes, owner, expected close date or contact. To change stage use move_deal_stage; to close it use mark_deal_won / mark_deal_lost. Pass null to clear assigned_to, notes or expected_close_date.',
    scope: 'deals:write',
    tier: 'write',
    input: {
      deal_id: uuid('Deal id from list_deals.'),
      title: z.string().trim().min(1).max(200).optional(),
      value: z.number().min(0).max(9_999_999_999).optional(),
      currency: z.string().trim().length(3).optional(),
      contact_id: z.string().uuid().optional(),
      assigned_to: z.string().uuid().nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
      expected_close_date: isoDate.nullable().optional(),
    },
    handler: async (ctx, args) => {
      await loadDeal(ctx, args.deal_id);
      const { deal_id, ...fields } = args;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) patch[k] = v;
      if (typeof patch.currency === 'string') patch.currency = patch.currency.toUpperCase();
      if (Object.keys(patch).length === 0) {
        throw new McpToolError('invalid_input', 'Pass at least one field to change.');
      }
      if (typeof patch.contact_id === 'string') await assertContact(ctx, patch.contact_id);
      if (typeof patch.assigned_to === 'string') await assertAssignee(ctx, patch.assigned_to);
      if (ctx.dryRun) return { would_update: { deal_id, ...patch } };
      const { data, error } = await ctx.supabase
        .from('deals')
        .update(patch)
        .eq('id', deal_id)
        .eq('account_id', ctx.accountId)
        .select(DEAL_COLUMNS)
        .single();
      if (error) failDb(error);
      return { deal: data };
    },
  }),

  defineTool({
    name: 'move_deal_stage',
    description:
      'Move a deal to another stage of its pipeline. Does not change won/lost status. Get stage ids from list_pipelines.',
    scope: 'deals:write',
    tier: 'write',
    input: { deal_id: uuid('Deal id.'), stage_id: uuid('Target stage id (same pipeline).') },
    handler: async (ctx, args) => {
      const deal = await loadDeal(ctx, args.deal_id);
      const stage = await loadStage(ctx, args.stage_id);
      if (stage.pipeline_id !== deal.pipeline_id) {
        throw new McpToolError(
          'invalid_input',
          'That stage belongs to a different pipeline than the deal.',
          'stage_id'
        );
      }
      if (ctx.dryRun) {
        return { would_update: { deal_id: args.deal_id, from_stage_id: deal.stage_id, stage_id: stage.id } };
      }
      const { data, error } = await ctx.supabase
        .from('deals')
        .update({ stage_id: stage.id })
        .eq('id', args.deal_id)
        .eq('account_id', ctx.accountId)
        .select(DEAL_COLUMNS)
        .single();
      if (error) failDb(error);
      return { deal: data };
    },
  }),

  defineTool({
    name: 'mark_deal_won',
    description: 'Mark a deal as won. deal_id comes from list_deals.',
    scope: 'deals:write',
    tier: 'write',
    input: { deal_id: uuid('Deal id from list_deals.') },
    handler: (ctx, args) => setDealStatus(ctx, args.deal_id, 'won'),
  }),

  defineTool({
    name: 'mark_deal_lost',
    description: 'Mark a deal as lost. The optional reason is appended to the deal notes.',
    scope: 'deals:write',
    tier: 'write',
    input: { deal_id: uuid('Deal id from list_deals.'), reason: z.string().trim().max(500).optional() },
    handler: (ctx, args) => setDealStatus(ctx, args.deal_id, 'lost', args.reason),
  }),

  defineTool({
    name: 'reopen_deal',
    description: 'Set a won or lost deal back to open.',
    scope: 'deals:write',
    tier: 'write',
    input: { deal_id: uuid('Deal id from list_deals.') },
    handler: (ctx, args) => setDealStatus(ctx, args.deal_id, 'open'),
  }),

  defineTool({
    name: 'delete_deal',
    description: 'Permanently delete a deal. Cannot be undone; ask the user first. Consider mark_deal_lost instead.',
    scope: 'deals:write',
    tier: 'destructive',
    input: { deal_id: uuid('Deal id from list_deals.') },
    handler: async (ctx, args) => {
      const deal = await loadDeal(ctx, args.deal_id);
      if (ctx.dryRun) return { would_delete: { deal_id: args.deal_id, title: deal.title } };
      const { error } = await ctx.supabase
        .from('deals')
        .delete()
        .eq('id', args.deal_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      return { deleted: args.deal_id };
    },
  }),
];
