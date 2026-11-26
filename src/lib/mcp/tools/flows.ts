// MCP 2.0 — flows / chatbots. See ../CONVENTIONS.md.
//
// Configuration and debugging only: nothing here sends a WhatsApp message.
// flows / flow_runs carry account_id; flow_nodes and flow_run_events hang
// off them, so they are always reached through an account-checked parent.
import { z } from 'zod';

import type { BuilderNode } from '@/components/flows/shared';
import { deriveCanvasEdges } from '@/lib/flows/edges';
import { redactPayload } from '@/lib/flows/redact';
import { cloneFlowFromTemplate, replaceFlowNodes, validateStoredFlow } from '@/lib/flows/service';
import { getFlowTemplate, listFlowTemplates } from '@/lib/flows/templates';
import { validateFlowForActivation, type ValidationIssue } from '@/lib/flows/validate';

import { McpToolError } from '../errors';
import { defineTool, type AnyMcpTool, type McpContext } from '../types';
import { cursorField, failDb, limitField, loadAccountRow, paginate, uuid } from './common-pgf';

const FLOW_COLUMNS =
  'id, name, description, status, trigger_type, trigger_config, entry_node_id, fallback_policy, execution_count, last_executed_at, created_at, updated_at';
const FLOW_LIST_COLUMNS =
  'id, name, description, status, trigger_type, trigger_config, entry_node_id, execution_count, last_executed_at, created_at, updated_at';

const NODE_TYPES = [
  'start',
  'send_message',
  'send_buttons',
  'send_list',
  'send_media',
  'collect_input',
  'condition',
  'set_tag',
  'handoff',
  'end',
] as const;

const TRIGGER_TYPES = ['keyword', 'first_inbound_message', 'manual'] as const;

function throwFlowIssues(issues: ValidationIssue[], lead: string): never {
  const errors = issues.filter((i) => i.severity === 'error');
  const first = errors[0] ?? issues[0];
  const shown = errors
    .slice(0, 8)
    .map((i) => `${i.node_key ? `node ${i.node_key}: ` : ''}${i.field ? `${i.field}: ` : ''}${i.message}`);
  const more = errors.length > shown.length ? ` (+${errors.length - shown.length} more)` : '';
  throw new McpToolError(
    'invalid_input',
    `${lead} ${errors.length} problem(s) - ${shown.join('; ')}${more}`,
    first.node_key ? `nodes.${first.node_key}${first.field ? `.${first.field}` : ''}` : first.field ?? first.scope
  );
}

async function loadFlow(ctx: McpContext, id: string, columns = FLOW_COLUMNS) {
  return loadAccountRow(ctx, 'flows', id, 'Flow', columns);
}

async function loadNodes(ctx: McpContext, flowId: string) {
  const { data, error } = await ctx.supabase
    .from('flow_nodes')
    .select('node_key, node_type, config, position_x, position_y')
    .eq('flow_id', flowId)
    .order('created_at', { ascending: true });
  if (error) failDb(error);
  return (data ?? []) as BuilderNode[];
}

export const flowsTools: AnyMcpTool[] = [
  defineTool({
    name: 'list_flows',
    description:
      'List chatbot flows, newest first, with status (draft/active/archived), trigger and run counts. Use get_flow for the nodes.',
    scope: 'flows:read',
    tier: 'read',
    input: {
      status: z.enum(['draft', 'active', 'archived']).optional(),
      limit: limitField,
      cursor: cursorField,
    },
    handler: async (ctx, args) => {
      let q = ctx.supabase.from('flows').select(FLOW_LIST_COLUMNS).eq('account_id', ctx.accountId);
      if (args.status) q = q.eq('status', args.status);
      return paginate(q, args);
    },
  }),

  defineTool({
    name: 'list_flow_templates',
    description:
      'List the built-in flow templates (slug, name, description, trigger, node count). Use a slug with create_flow_from_template.',
    scope: 'flows:read',
    tier: 'read',
    input: {},
    handler: async () => ({
      items: listFlowTemplates().map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        trigger_type: t.trigger_type,
        node_count: t.nodes.length,
      })),
    }),
  }),

  defineTool({
    name: 'get_flow',
    description:
      'Get one flow: settings, fallback policy, every node (node_key, node_type, config) and the derived edges (source -> target with a label). flow_id comes from list_flows. Also lists validation issues so you can see what blocks activation.',
    scope: 'flows:read',
    tier: 'read',
    input: { flow_id: uuid('Flow id from list_flows.') },
    handler: async (ctx, args) => {
      const flow = await loadFlow(ctx, args.flow_id);
      const nodes = await loadNodes(ctx, args.flow_id);
      const issues = await validateStoredFlow(ctx.supabase, args.flow_id);
      return { flow, nodes, edges: deriveCanvasEdges(nodes), validation_issues: issues ?? [] };
    },
  }),

  defineTool({
    name: 'create_flow_from_template',
    description:
      'Create a new DRAFT flow by copying a template (see list_flow_templates). Edit it with update_flow_nodes, then activate_flow.',
    scope: 'flows:write',
    tier: 'write',
    input: {
      template_slug: z.string().min(1).describe('Slug from list_flow_templates.'),
      name: z.string().trim().min(1).max(120).optional().describe('Defaults to the template name.'),
    },
    handler: async (ctx, args) => {
      const template = getFlowTemplate(args.template_slug);
      if (!template) {
        throw new McpToolError(
          'not_found',
          `Unknown template "${args.template_slug}". Call list_flow_templates for valid slugs.`,
          'template_slug'
        );
      }
      if (ctx.dryRun) {
        return {
          would_create: {
            name: args.name ?? template.name,
            status: 'draft',
            trigger_type: template.trigger_type,
            node_count: template.nodes.length,
          },
        };
      }
      if (!ctx.createdBy) {
        throw new McpToolError('invalid_input', 'This API key has no creating user, so a flow cannot be attributed.');
      }
      const cloned = await cloneFlowFromTemplate(ctx.supabase, {
        userId: ctx.createdBy,
        accountId: ctx.accountId,
        template,
        name: args.name,
      });
      if ('error' in cloned) throw new McpToolError('internal', cloned.error);
      const { id, name, status } = cloned.flow as { id: string; name: string; status: string };
      return { flow: { id, name, status } };
    },
  }),

  defineTool({
    name: 'update_flow_nodes',
    description:
      'Replace a flow\'s whole node graph (send the COMPLETE list, from get_flow) and optionally its name, trigger, entry node or fallback policy. Edges live inside node configs (next_node_key etc.). The flow is checked with the same validator as the dashboard: an ACTIVE flow must stay valid; a draft may be incomplete and problems come back as validation_issues. dry_run validates without saving. Configuring only: this sends nothing.',
    scope: 'flows:write',
    tier: 'write',
    input: {
      flow_id: uuid('Flow id from list_flows.'),
      nodes: z
        .array(
          z.object({
            node_key: z.string().trim().min(1).max(80).describe('Unique key inside the flow; configs point at it.'),
            node_type: z.enum(NODE_TYPES),
            config: z.record(z.string(), z.unknown()),
            position_x: z.number().int().optional(),
            position_y: z.number().int().optional(),
          })
        )
        .max(200),
      entry_node_id: z.string().nullable().optional().describe('node_key where the flow starts.'),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      trigger_type: z.enum(TRIGGER_TYPES).optional(),
      trigger_config: z.record(z.string(), z.unknown()).optional(),
      fallback_policy: z.record(z.string(), z.unknown()).optional(),
    },
    handler: async (ctx, args) => {
      const flow = await loadFlow(ctx, args.flow_id);
      const keys = new Set<string>();
      for (const n of args.nodes) {
        if (keys.has(n.node_key)) {
          throw new McpToolError('invalid_input', `Duplicate node_key "${n.node_key}".`, `nodes.${n.node_key}`);
        }
        keys.add(n.node_key);
      }
      const merged = {
        name: args.name ?? (flow.name as string),
        trigger_type: (args.trigger_type ?? flow.trigger_type) as (typeof TRIGGER_TYPES)[number],
        trigger_config: (args.trigger_config ?? flow.trigger_config ?? {}) as Record<string, unknown>,
        entry_node_id: args.entry_node_id !== undefined ? args.entry_node_id : (flow.entry_node_id as string | null),
      };
      const issues = validateFlowForActivation(merged, args.nodes);
      const hasErrors = issues.some((i) => i.severity === 'error');
      if (flow.status === 'active' && hasErrors) {
        throwFlowIssues(issues, 'The flow is active, so the new graph must be valid.');
      }
      if (ctx.dryRun) {
        return {
          valid: !hasErrors,
          validation_issues: issues,
          definition: { ...merged, nodes: args.nodes },
          edges: deriveCanvasEdges(args.nodes as BuilderNode[]),
        };
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.trigger_type !== undefined) patch.trigger_type = args.trigger_type;
      if (args.trigger_config !== undefined) patch.trigger_config = args.trigger_config;
      if (args.entry_node_id !== undefined) patch.entry_node_id = args.entry_node_id;
      if (args.fallback_policy !== undefined) patch.fallback_policy = args.fallback_policy;
      const { error } = await ctx.supabase
        .from('flows')
        .update(patch)
        .eq('id', args.flow_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      const nodesErr = await replaceFlowNodes(ctx.supabase, args.flow_id, args.nodes);
      if (nodesErr) throw new McpToolError('internal', nodesErr);
      return { updated: args.flow_id, node_count: args.nodes.length, validation_issues: issues };
    },
  }),

  defineTool({
    name: 'activate_flow',
    description:
      'Turn a flow on so it starts answering customers. The flow is validated first; any error blocks activation and is returned as invalid_input. Check with get_flow (validation_issues).',
    scope: 'flows:write',
    tier: 'write',
    input: { flow_id: uuid('Flow id from list_flows.') },
    handler: async (ctx, args) => {
      const flow = await loadFlow(ctx, args.flow_id, 'id, status');
      const issues = (await validateStoredFlow(ctx.supabase, args.flow_id)) ?? [];
      if (issues.some((i) => i.severity === 'error')) {
        throwFlowIssues(issues, 'Cannot activate this flow.');
      }
      if (ctx.dryRun) {
        return { would_update: { flow_id: args.flow_id, from: flow.status, status: 'active' }, validation_issues: issues };
      }
      const { error } = await ctx.supabase
        .from('flows')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', args.flow_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      return { flow_id: args.flow_id, status: 'active', validation_issues: issues };
    },
  }),

  defineTool({
    name: 'deactivate_flow',
    description:
      'Turn a flow off (back to draft, or archived with archive: true). Customers already mid-flow are not messaged further by new triggers; no messages are sent.',
    scope: 'flows:write',
    tier: 'write',
    input: {
      flow_id: uuid('Flow id from list_flows.'),
      archive: z.boolean().optional().describe('Archive instead of returning to draft.'),
    },
    handler: async (ctx, args) => {
      const flow = await loadFlow(ctx, args.flow_id, 'id, status');
      const status = args.archive ? 'archived' : 'draft';
      if (ctx.dryRun) return { would_update: { flow_id: args.flow_id, from: flow.status, status } };
      const { error } = await ctx.supabase
        .from('flows')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', args.flow_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      return { flow_id: args.flow_id, status };
    },
  }),

  defineTool({
    name: 'delete_flow',
    description:
      'Permanently delete a flow with its nodes, runs and run events. Active runs end immediately. Cannot be undone; consider deactivate_flow instead.',
    scope: 'flows:write',
    tier: 'destructive',
    input: { flow_id: uuid('Flow id from list_flows.') },
    handler: async (ctx, args) => {
      const flow = await loadFlow(ctx, args.flow_id, 'id, name, status');
      if (ctx.dryRun) return { would_delete: { flow_id: args.flow_id, name: flow.name, status: flow.status } };
      const { error } = await ctx.supabase
        .from('flows')
        .delete()
        .eq('id', args.flow_id)
        .eq('account_id', ctx.accountId);
      if (error) failDb(error);
      return { deleted: args.flow_id };
    },
  }),

  defineTool({
    name: 'list_flow_runs',
    description:
      'List flow runs (one per customer conversation with a flow), newest first: status, the node it is on, reprompt count, start/end and end reason. Contact ids only, no phone numbers, and collected answers are listed by name only. Filter by flow, status or contact. Use get_flow_run_events to see why a run got stuck.',
    scope: 'flows:read',
    tier: 'read',
    input: {
      flow_id: z.string().uuid().optional(),
      contact_id: z.string().uuid().optional(),
      status: z
        .enum(['active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed'])
        .optional(),
      limit: limitField,
      cursor: cursorField,
    },
    handler: async (ctx, args) => {
      if (args.flow_id) await loadFlow(ctx, args.flow_id, 'id');
      let q = ctx.supabase
        .from('flow_runs')
        .select(
          'id, flow_id, contact_id, conversation_id, status, current_node_key, reprompt_count, started_at, last_advanced_at, ended_at, end_reason, vars'
        )
        .eq('account_id', ctx.accountId);
      if (args.flow_id) q = q.eq('flow_id', args.flow_id);
      if (args.contact_id) q = q.eq('contact_id', args.contact_id);
      if (args.status) q = q.eq('status', args.status);
      const page = await paginate<{ id: string; vars?: Record<string, unknown> | null }>(q, args, 'started_at');
      return {
        items: page.items.map((r) => {
          const { vars, ...rest } = r;
          return { ...rest, var_keys: Object.keys(vars ?? {}) };
        }),
        next_cursor: page.next_cursor,
      };
    },
  }),

  defineTool({
    name: 'get_flow_run_events',
    description:
      'The event timeline of one flow run (started, node_entered, message_sent, reply_received, fallback_fired, handoff, timeout, error, completed) in order, to debug why a customer got stuck. Free-text and phone-like values in payloads are redacted. run_id comes from list_flow_runs.',
    scope: 'flows:read',
    tier: 'read',
    input: {
      run_id: uuid('Run id from list_flow_runs.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max events, 1-500 (default 200).'),
    },
    handler: async (ctx, args) => {
      const run = await loadAccountRow(
        ctx,
        'flow_runs',
        args.run_id,
        'Flow run',
        'id, flow_id, contact_id, status, current_node_key, reprompt_count, started_at, last_advanced_at, ended_at, end_reason'
      );
      const { data, error } = await ctx.supabase
        .from('flow_run_events')
        .select('event_type, node_key, payload, created_at')
        .eq('flow_run_id', args.run_id)
        .order('created_at', { ascending: true })
        .limit(args.limit ?? 200);
      if (error) failDb(error);
      const events = ((data ?? []) as { event_type: string; node_key: string | null; payload: unknown; created_at: string }[]).map(
        (e) => ({ ...e, payload: redactPayload(e.payload) })
      );
      return { run, events };
    },
  }),
];
