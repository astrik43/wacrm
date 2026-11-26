// Strip customer-identifying content from flow run payloads before they
// leave the system through a debugging tool. Run events and `vars` can
// hold what the customer typed (names, phones, emails, addresses), so the
// structure is kept for debugging (which node, which event, which keys)
// but free-text values are masked.

const SENSITIVE_KEY =
  /phone|wa_id|msisdn|mobile|email|address|name|text|body|caption|input|value|message_text|reply_text|title|description|url/i

const PHONE_LIKE = /\+?\d[\d\s().-]{7,}\d/
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/

export const REDACTED = '[redacted]'

export function redactPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return PHONE_LIKE.test(value) || EMAIL_LIKE.test(value) ? REDACTED : value
  }
  if (depth >= 6) return REDACTED
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactPayload(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && v !== null && typeof v !== 'object') {
        out[k] = typeof v === 'string' && v === '' ? v : REDACTED
      } else {
        out[k] = redactPayload(v, depth + 1)
      }
    }
    return out
  }
  return REDACTED
}
