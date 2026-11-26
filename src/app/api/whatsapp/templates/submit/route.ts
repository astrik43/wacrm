import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { submitTemplate, TemplateOpError } from '@/lib/whatsapp/template-ops'

/**
 * Submit a template to Meta for approval AND persist it locally. The
 * logic lives in `submitTemplate` (src/lib/whatsapp/template-ops.ts),
 * shared with the MCP `submit_template` tool; this route owns auth and
 * the response shape.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true the Meta call is skipped and a
 * synthetic `dry-run-<uuid>` meta_template_id is stored.
 */
export async function POST(request: Request) {
  try {
    // Message templates are settings-class data: `canEditSettings` and the
    // message_templates_insert/update RLS policies (migration 017) both
    // require 'admin'. A viewer or agent must not push a template to Meta
    // (an external side effect RLS can't roll back).
    const { supabase, accountId, userId } = await requireRole('admin')

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    try {
      const { template, dry_run } = await submitTemplate(
        supabase,
        accountId,
        userId,
        payload,
      )
      return NextResponse.json({ success: true, template, dry_run })
    } catch (e) {
      if (e instanceof TemplateOpError) {
        return NextResponse.json(
          { error: e.message, ...(e.extra ?? {}) },
          { status: e.status },
        )
      }
      throw e
    }
  } catch (error) {
    // Auth failures map to 401/403 rather than a generic 500.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}
