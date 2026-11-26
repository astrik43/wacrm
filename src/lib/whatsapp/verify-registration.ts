import { decrypt } from '@/lib/whatsapp/encryption'
import { getSubscribedApps, verifyPhoneNumber } from '@/lib/whatsapp/meta-api'

/** The whatsapp_config columns the registration check reads. */
export interface RegistrationConfigRow {
  phone_number_id: string
  waba_id: string | null
  access_token: string
  registered_at?: string | null
  last_registration_error?: string | null
  subscribed_apps_at?: string | null
}

/**
 * Diagnostic: confirm the saved phone number is actually reachable on
 * Meta's side (phone metadata, WABA subscription, local registration
 * stamp). Shared by GET /api/whatsapp/config/verify-registration and the
 * MCP verify_whatsapp_registration tool. Always resolves to a plain
 * result (never throws) so callers can render diagnostic detail. The
 * access token is decrypted here and never included in the result.
 */
export async function runRegistrationCheck(config: RegistrationConfigRow) {
  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return {
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
    }
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  }
  const errors: string[] = []

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          'WABA has no subscribed apps. Re-save the configuration to subscribe.',
        )
      }
    } catch (err) {
      errors.push(
        `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    errors.push(
      "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save.",
    )
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered

  return {
    live,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  }
}
