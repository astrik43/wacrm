// ============================================================
// WhatsApp number status + business profile (Meta Graph API).
//
// Read/update helpers used by the MCP settings tools. Every function
// takes the already-decrypted access token and NEVER returns it.
// ============================================================

import { MetaApiError } from './meta-api'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

export interface PhoneStatus {
  display_phone_number: string | null
  verified_name: string | null
  quality_rating: string | null
  /** e.g. TIER_1K, TIER_10K, TIER_100K, TIER_UNLIMITED. */
  messaging_limit_tier: string | null
  name_status: string | null
  /** e.g. CONNECTED, DISCONNECTED, PENDING. */
  status: string | null
}

export interface BusinessProfile {
  about: string | null
  address: string | null
  description: string | null
  email: string | null
  websites: string[]
  vertical: string | null
}

/** Fields an update may change (all optional; websites replace the list). */
export interface BusinessProfileUpdate {
  about?: string
  address?: string
  description?: string
  email?: string
  websites?: string[]
}

export const BUSINESS_PROFILE_LIMITS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
  websites: 2,
} as const

async function graph<T>(url: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!response.ok) {
    let message = `Meta API error: ${response.status}`
    let code: number | null = null
    try {
      const data = (await response.json()) as { error?: { message?: string; code?: number } }
      if (data.error?.message) message = data.error.message
      if (typeof data.error?.code === 'number') code = data.error.code
    } catch {
      // not JSON — keep the fallback
    }
    throw new MetaApiError(message, { code, httpStatus: response.status })
  }
  return (await response.json()) as T
}

/** Number status: display number, verified name, quality, tier, state. */
export async function fetchPhoneStatus(args: {
  phoneNumberId: string
  accessToken: string
}): Promise<PhoneStatus> {
  const fields =
    'display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,status'
  const d = await graph<Record<string, unknown>>(
    `${GRAPH_BASE}/${args.phoneNumberId}?fields=${fields}`,
    args.accessToken,
  )
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    display_phone_number: s(d.display_phone_number),
    verified_name: s(d.verified_name),
    quality_rating: s(d.quality_rating),
    messaging_limit_tier: s(d.messaging_limit_tier),
    name_status: s(d.name_status),
    status: s(d.status),
  }
}

export async function fetchBusinessProfile(args: {
  phoneNumberId: string
  accessToken: string
}): Promise<BusinessProfile> {
  const d = await graph<{ data?: Array<Record<string, unknown>> }>(
    `${GRAPH_BASE}/${args.phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,websites,vertical`,
    args.accessToken,
  )
  const p = d.data?.[0] ?? {}
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    about: s(p.about),
    address: s(p.address),
    description: s(p.description),
    email: s(p.email),
    websites: Array.isArray(p.websites)
      ? (p.websites as unknown[]).filter((w): w is string => typeof w === 'string')
      : [],
    vertical: s(p.vertical),
  }
}

export async function pushBusinessProfile(args: {
  phoneNumberId: string
  accessToken: string
  update: BusinessProfileUpdate
}): Promise<void> {
  await graph<unknown>(`${GRAPH_BASE}/${args.phoneNumberId}/whatsapp_business_profile`, args.accessToken, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', ...args.update }),
  })
}

/** Fields that differ between the current profile and a requested update. */
export function diffBusinessProfile(
  current: BusinessProfile,
  update: BusinessProfileUpdate,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of ['about', 'address', 'description', 'email'] as const) {
    const next = update[key]
    if (next !== undefined && next !== (current[key] ?? '')) {
      diff[key] = { from: current[key], to: next }
    }
  }
  if (update.websites !== undefined) {
    if (JSON.stringify(update.websites) !== JSON.stringify(current.websites)) {
      diff.websites = { from: current.websites, to: update.websites }
    }
  }
  return diff
}
