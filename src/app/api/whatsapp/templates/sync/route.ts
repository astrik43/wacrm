import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { syncTemplatesFromMeta, TemplateOpError } from '@/lib/whatsapp/template-ops'

/**
 * Sync message templates from Meta -> local message_templates table.
 * The logic lives in `syncTemplatesFromMeta`
 * (src/lib/whatsapp/template-ops.ts), shared with the MCP
 * `sync_templates` tool; this route owns auth and the response shape.
 */
export async function POST() {
  try {
    // Syncing rewrites the account-wide template catalog, which is
    // settings-class data: `canEditSettings` and the message_templates
    // insert/update RLS policies (migration 017) both require 'admin'.
    const { supabase, accountId, userId } = await requireRole('admin')

    try {
      return NextResponse.json(
        await syncTemplatesFromMeta(supabase, accountId, userId),
      )
    } catch (e) {
      if (e instanceof TemplateOpError) {
        return NextResponse.json({ error: e.message }, { status: e.status })
      }
      throw e
    }
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync templates',
      },
      { status: 500 },
    )
  }
}
