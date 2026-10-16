-- ============================================================
-- 050_message_charges.sql — one row per outbound WhatsApp message,
-- for the Transaction Details page
--
-- message_charges
--   Keyed by (account_id, whatsapp_message_id). Meta's status webhooks
--   (sent → delivered → read, or failed) carry a `pricing` object on
--   every message: the category Meta billed it under (marketing,
--   utility, authentication, service…), the pricing type (regular,
--   free_customer_service, free_entry_point) and whether it is
--   billable. Each status is folded in by record_message_status().
--
--   pricing_source  'meta'      — category/billable came from Meta
--                   'estimated' — backfilled below from what the CRM
--                                 already stored (template category),
--                                 for messages sent before this table
--
--   Service-role only (RLS on, no policies): read through
--   GET /api/billing/transactions, which checks the caller's role.
--
-- record_message_status(...)
--   Upsert used by the WhatsApp webhook. Status only moves forward
--   (sent < failed < delivered < read), so Meta's out-of-order
--   deliveries can't move a read message back to sent; each status's
--   own timestamp is kept the first time it is seen; pricing fields
--   are kept once known.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS message_charges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_message_id  text NOT NULL,
  recipient            text,
  status               text NOT NULL DEFAULT 'sent',
  pricing_category     text,
  pricing_type         text,
  billable             boolean,
  pricing_source       text NOT NULL DEFAULT 'meta',
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  error_code           integer,
  error_title          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_charges
  DROP CONSTRAINT IF EXISTS message_charges_status_check;
ALTER TABLE message_charges
  ADD CONSTRAINT message_charges_status_check
  CHECK (status IN ('sent', 'delivered', 'read', 'failed'));

ALTER TABLE message_charges
  DROP CONSTRAINT IF EXISTS message_charges_pricing_source_check;
ALTER TABLE message_charges
  ADD CONSTRAINT message_charges_pricing_source_check
  CHECK (pricing_source IN ('meta', 'estimated'));

CREATE UNIQUE INDEX IF NOT EXISTS message_charges_account_message_key
  ON message_charges (account_id, whatsapp_message_id);
CREATE INDEX IF NOT EXISTS message_charges_account_created_idx
  ON message_charges (account_id, created_at DESC);

ALTER TABLE message_charges ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Status ordering and the webhook upsert
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION message_status_rank(p_status text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'sent' THEN 1
    WHEN 'failed' THEN 2
    WHEN 'delivered' THEN 3
    WHEN 'read' THEN 4
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION record_message_status(
  p_account_id       uuid,
  p_message_id       text,
  p_recipient        text,
  p_status           text,
  p_at               timestamptz,
  p_category         text,
  p_pricing_type     text,
  p_billable         boolean,
  p_error_code       integer,
  p_error_title      text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO message_charges AS c (
    account_id, whatsapp_message_id, recipient, status,
    pricing_category, pricing_type, billable, pricing_source,
    sent_at, delivered_at, read_at, failed_at,
    error_code, error_title, created_at
  )
  VALUES (
    p_account_id, p_message_id, p_recipient, p_status,
    p_category, p_pricing_type, p_billable, 'meta',
    CASE WHEN p_status = 'sent' THEN p_at END,
    CASE WHEN p_status = 'delivered' THEN p_at END,
    CASE WHEN p_status = 'read' THEN p_at END,
    CASE WHEN p_status = 'failed' THEN p_at END,
    p_error_code, p_error_title,
    COALESCE(p_at, now())
  )
  ON CONFLICT (account_id, whatsapp_message_id) DO UPDATE SET
    status = CASE
      WHEN message_status_rank(EXCLUDED.status) > message_status_rank(c.status)
        THEN EXCLUDED.status
      ELSE c.status
    END,
    recipient        = COALESCE(c.recipient, EXCLUDED.recipient),
    pricing_category = COALESCE(EXCLUDED.pricing_category, c.pricing_category),
    pricing_type     = COALESCE(EXCLUDED.pricing_type, c.pricing_type),
    billable         = COALESCE(EXCLUDED.billable, c.billable),
    pricing_source   = CASE
      WHEN EXCLUDED.pricing_category IS NOT NULL THEN 'meta'
      ELSE c.pricing_source
    END,
    sent_at      = COALESCE(c.sent_at, EXCLUDED.sent_at),
    delivered_at = COALESCE(c.delivered_at, EXCLUDED.delivered_at),
    read_at      = COALESCE(c.read_at, EXCLUDED.read_at),
    failed_at    = COALESCE(c.failed_at, EXCLUDED.failed_at),
    error_code   = COALESCE(EXCLUDED.error_code, c.error_code),
    error_title  = COALESCE(EXCLUDED.error_title, c.error_title),
    -- The row's time is when the message went out, whichever status
    -- happened to arrive first.
    created_at   = LEAST(c.created_at, EXCLUDED.created_at),
    updated_at   = now();
$$;

REVOKE ALL ON FUNCTION record_message_status(
  uuid, text, text, text, timestamptz, text, text, boolean, integer, text
) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Backfill: messages the CRM sent before this table existed.
-- Category is estimated — the template's own category, else
-- 'service' (a free-form reply inside the 24-hour window). Meta
-- charges a template once it is delivered.
-- ------------------------------------------------------------
INSERT INTO message_charges (
  account_id, whatsapp_message_id, recipient, status,
  pricing_category, pricing_type, billable, pricing_source,
  sent_at, delivered_at, read_at, failed_at,
  error_code, error_title, created_at
)
SELECT
  conv.account_id,
  m.message_id,
  ct.phone,
  m.status,
  CASE
    WHEN m.template_name IS NULL THEN 'service'
    ELSE COALESCE(lower(tpl.category), 'utility')
  END,
  CASE WHEN m.template_name IS NULL THEN 'free_customer_service' ELSE 'regular' END,
  (m.template_name IS NOT NULL AND m.status IN ('delivered', 'read')),
  'estimated',
  m.created_at,
  CASE WHEN m.status IN ('delivered', 'read') THEN m.created_at END,
  CASE WHEN m.status = 'read' THEN m.created_at END,
  CASE WHEN m.status = 'failed' THEN m.created_at END,
  m.error_code,
  m.error_title,
  m.created_at
FROM messages m
JOIN conversations conv ON conv.id = m.conversation_id
LEFT JOIN contacts ct ON ct.id = conv.contact_id
LEFT JOIN LATERAL (
  SELECT t.category
  FROM message_templates t
  WHERE t.account_id = conv.account_id AND t.name = m.template_name
  ORDER BY t.updated_at DESC
  LIMIT 1
) tpl ON true
WHERE m.message_id IS NOT NULL
  AND m.sender_type <> 'customer'
  AND m.status IN ('sent', 'delivered', 'read', 'failed')
ON CONFLICT (account_id, whatsapp_message_id) DO NOTHING;

INSERT INTO message_charges (
  account_id, whatsapp_message_id, recipient, status,
  pricing_category, pricing_type, billable, pricing_source,
  sent_at, delivered_at, read_at, failed_at, created_at
)
SELECT
  b.account_id,
  r.whatsapp_message_id,
  ct.phone,
  r.status,
  COALESCE(lower(tpl.category), 'marketing'),
  'regular',
  r.status IN ('delivered', 'read', 'replied'),
  'estimated',
  COALESCE(r.sent_at, r.created_at),
  r.delivered_at,
  r.read_at,
  CASE WHEN r.status = 'failed' THEN r.created_at END,
  COALESCE(r.sent_at, r.created_at)
FROM broadcast_recipients r
JOIN broadcasts b ON b.id = r.broadcast_id
LEFT JOIN contacts ct ON ct.id = r.contact_id
LEFT JOIN LATERAL (
  SELECT t.category
  FROM message_templates t
  WHERE t.account_id = b.account_id AND t.name = b.template_name
  ORDER BY t.updated_at DESC
  LIMIT 1
) tpl ON true
WHERE r.whatsapp_message_id IS NOT NULL
  AND r.status IN ('sent', 'delivered', 'read', 'failed')
ON CONFLICT (account_id, whatsapp_message_id) DO NOTHING;
