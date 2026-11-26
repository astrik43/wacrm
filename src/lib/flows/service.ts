import type { SupabaseClient } from '@supabase/supabase-js'

import type { FlowTemplate } from './templates'
import { validateFlowForActivation, type ValidationIssue } from './validate'

// Flow persistence helpers shared by the dashboard routes
// (/api/flows, /api/flows/[id]/activate) and the MCP flow tools. Each
// takes the db client explicitly; callers are responsible for having
// authorised the flow / account first.

type DbError = { error: string }

/** Clone a template into a fresh draft flow (rolls back on node failure). */
export async function cloneFlowFromTemplate(
  db: SupabaseClient,
  args: { userId: string; accountId: string; template: FlowTemplate; name?: string | null },
): Promise<{ flow: Record<string, unknown> } | DbError> {
  const { template } = args
  const { data: flow, error: flowErr } = await db
    .from('flows')
    .insert({
      user_id: args.userId,
      account_id: args.accountId,
      name: args.name?.trim() || template.name,
      description: template.description,
      status: 'draft',
      trigger_type: template.trigger_type,
      trigger_config: template.trigger_config,
      entry_node_id: template.entry_node_id,
    })
    .select()
    .single()
  if (flowErr || !flow) return { error: flowErr?.message ?? 'flow insert failed' }

  if (template.nodes.length > 0) {
    const { error: nodesErr } = await db.from('flow_nodes').insert(
      template.nodes.map((n) => ({
        flow_id: flow.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
      })),
    )
    if (nodesErr) {
      // Roll back the parent flow so a half-cloned template doesn't sit
      // as an empty draft. CASCADE on flow_id removes any nodes too.
      await db.from('flows').delete().eq('id', flow.id)
      return { error: nodesErr.message }
    }
  }
  return { flow }
}

/**
 * Run the full activation validator against a stored flow. Returns null
 * when the flow does not exist, otherwise the issue list (errors block
 * activation, warnings do not).
 */
export async function validateStoredFlow(
  db: SupabaseClient,
  flowId: string,
): Promise<ValidationIssue[] | null> {
  const [{ data: flow }, { data: nodes }] = await Promise.all([
    db
      .from('flows')
      .select('name, trigger_type, trigger_config, entry_node_id')
      .eq('id', flowId)
      .maybeSingle(),
    db.from('flow_nodes').select('node_key, node_type, config').eq('flow_id', flowId),
  ])
  if (!flow) return null
  return validateFlowForActivation(
    flow as Parameters<typeof validateFlowForActivation>[0],
    (nodes ?? []) as Parameters<typeof validateFlowForActivation>[1],
  )
}

export interface FlowNodeInput {
  node_key: string
  node_type: string
  config: Record<string, unknown>
  position_x?: number
  position_y?: number
}

/**
 * Replace a flow's whole node graph (delete-then-insert, not atomic; the
 * runner tolerates mid-edit reads). Returns an error message or null.
 */
export async function replaceFlowNodes(
  db: SupabaseClient,
  flowId: string,
  nodes: FlowNodeInput[],
): Promise<string | null> {
  const { error: delErr } = await db.from('flow_nodes').delete().eq('flow_id', flowId)
  if (delErr) return delErr.message
  if (nodes.length === 0) return null
  const { error: insErr } = await db.from('flow_nodes').insert(
    nodes.map((n) => ({
      flow_id: flowId,
      node_key: n.node_key,
      node_type: n.node_type,
      config: n.config,
      position_x: n.position_x ?? 0,
      position_y: n.position_y ?? 0,
    })),
  )
  return insErr?.message ?? null
}
