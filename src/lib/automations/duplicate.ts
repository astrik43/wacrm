import type { SupabaseClient } from '@supabase/supabase-js'

// Clone an automation (inactive) plus its step tree. Shared by the
// dashboard route (POST /api/automations/[id]/duplicate) and the MCP
// `duplicate_automation` tool. The caller loads + authorises `original`.

export interface AutomationRow {
  id: string
  account_id: string
  name: string
  description: string | null
  trigger_type: string
  trigger_config: unknown
  [key: string]: unknown
}

export async function cloneAutomation(
  db: SupabaseClient,
  original: AutomationRow,
  userId: string,
): Promise<{ copy: Record<string, unknown> } | { error: string }> {
  const { data: copy, error: copyErr } = await db
    .from('automations')
    .insert({
      // Clone into the same account as the original. account_id is NOT
      // NULL post-017, so the INSERT fails the constraint without it.
      account_id: original.account_id,
      user_id: userId,
      name: `${original.name} (Copy)`,
      description: original.description,
      trigger_type: original.trigger_type,
      trigger_config: original.trigger_config,
      is_active: false,
    })
    .select()
    .single()
  if (copyErr || !copy) return { error: copyErr?.message ?? 'copy failed' }

  const { data: steps } = await db
    .from('automation_steps')
    .select('id, parent_step_id, branch, step_type, step_config, position')
    .eq('automation_id', original.id)
    .order('position', { ascending: true })

  if (steps && steps.length > 0) {
    // Re-map parent_step_id: build old→new id map first so the second
    // pass inserts rows with correct parent references.
    const idMap = new Map<string, string>()
    const uid = () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    for (const row of steps) idMap.set(row.id as string, uid())

    const rows = steps.map((row) => ({
      id: idMap.get(row.id as string)!,
      automation_id: copy.id,
      parent_step_id: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
      branch: row.branch,
      step_type: row.step_type,
      step_config: row.step_config,
      position: row.position,
    }))
    const { error: insErr } = await db.from('automation_steps').insert(rows)
    if (insErr) return { error: insErr.message }
  }

  return { copy }
}
