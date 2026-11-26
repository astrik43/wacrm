import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { clampUsageDays, summarizeAiUsage } from '@/lib/ai/usage-summary'

/**
 * GET /api/ai/usage?days=30  (admin+)
 *
 * Token-spend summary for the account's BYO key over the last `days`
 * (1-90, default 30): totals, per-mode + per-model breakdowns, and a
 * zero-filled daily series for charting. Admin-only, mirroring the
 * `ai_usage_log` SELECT policy — spend is billing-class.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const days = clampUsageDays(new URL(request.url).searchParams.get('days'))
    return NextResponse.json(await summarizeAiUsage(supabase, accountId, days))
  } catch (err) {
    return toErrorResponse(err)
  }
}
