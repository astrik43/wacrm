import type { SupabaseClient } from '@supabase/supabase-js'
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils'

// Rows are aggregated in-process over a bounded window. An active
// account writes a handful of rows per conversation, so 30 days sits
// comfortably under this cap; we surface `truncated` when it doesn't so
// the UI can say "showing a partial window" rather than under-reporting
// silently.
export const MAX_ROWS = 10_000
export const DEFAULT_WINDOW_DAYS = 30

interface UsageRow {
  created_at: string
  mode: 'auto_reply' | 'draft'
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** Clamp a requested window to 1-90 days (default 30). */
export function clampUsageDays(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.min(90, Math.floor(n)) : DEFAULT_WINDOW_DAYS
}

/**
 * Token-spend summary for an account's BYO key over the last `days`
 * (1-90): totals, per-mode + per-model breakdowns and a zero-filled daily
 * series. Shared by GET /api/ai/usage and the MCP get_ai_usage tool.
 * Tokens only: the usage log records no money (providers bill the
 * account's own key).
 */
export async function summarizeAiUsage(db: SupabaseClient, accountId: string, days: number) {
  const supabase = db
  // Align the query cutoff to the START of the oldest local day we'll
  // chart (not a rolling `now - N*24h` instant). Otherwise rows in the
  // oldest partial day would be counted in the totals but fall outside
  // every daily bucket, so the chart's bars wouldn't sum to the
  // headline total. Local-day boundaries match every other dashboard
  // chart (see lib/dashboard/date-utils).
  const since = daysAgoStart(days - 1)

  const { data, error } = await supabase
    .from('ai_usage_log')
    .select(
      'created_at, mode, provider, model, prompt_tokens, completion_tokens, total_tokens',
    )
    .eq('account_id', accountId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS + 1)

  if (error) {
    console.error('[ai/usage GET] fetch error:', error)
    throw new Error('Failed to load usage')
  }

  const all = (data ?? []) as UsageRow[]
  const truncated = all.length > MAX_ROWS
  const rows = truncated ? all.slice(0, MAX_ROWS) : all

  // Totals.
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0

  // Per-mode + per-model tallies.
  const byMode = {
    auto_reply: { calls: 0, tokens: 0 },
    draft: { calls: 0, tokens: 0 },
  }
  const modelMap = new Map<
    string,
    { model: string; provider: string; calls: number; tokens: number }
  >()

  // Zero-filled daily buckets so the chart shows quiet days as gaps,
  // not missing points. Local-day keys, oldest → newest — the same
  // helper every other dashboard chart uses, so day boundaries agree.
  const daily = new Map<string, { date: string; tokens: number; calls: number }>()
  for (const key of lastNDayKeys(days)) {
    daily.set(key, { date: key, tokens: 0, calls: 0 })
  }

  for (const r of rows) {
    promptTokens += r.prompt_tokens
    completionTokens += r.completion_tokens
    totalTokens += r.total_tokens

    // `mode` is DB-CHECK-constrained to these two values.
    byMode[r.mode].calls += 1
    byMode[r.mode].tokens += r.total_tokens

    const mk = `${r.provider}:${r.model}`
    const m =
      modelMap.get(mk) ??
      { model: r.model, provider: r.provider, calls: 0, tokens: 0 }
    m.calls += 1
    m.tokens += r.total_tokens
    modelMap.set(mk, m)

    const bucket = daily.get(localDayKey(r.created_at))
    if (bucket) {
      bucket.tokens += r.total_tokens
      bucket.calls += 1
    }
  }

  const byModel = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens)

  return {
    window_days: days,
    truncated,
    totals: {
      calls: rows.length,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
    by_mode: byMode,
    by_model: byModel,
    daily: [...daily.values()],
  }
}
