-- ============================================================
-- 056_ops_ndr.sql — ops settings and the NDR (non-delivery) flow
--
-- ops_settings: one row per account.
--   ndr_enabled / ndr_template_name / ndr_template_language
--     The NDR message ("we couldn't deliver order {{1}}, reply 1 to
--     reattempt, 2 for a new time"). OFF by default; nothing is sent
--     until an admin switches it on and names an approved template.
--   staff_doc_template_name / _language
--     Utility template with a DOCUMENT header, used by
--     send_document_to_staff when the team member has not messaged in
--     the last 24 hours.
--   sync_tags
--     The tag names the ERP tag sync may read and change.
--
-- ndr_requests: one row per (account, order). The unique key is what
-- makes a second NDR on the same order a no-op.
--   state   sent     the NDR template went out, no usable answer yet
--           answered the customer replied 1 or 2
--           expired  no answer within 7 days
--   answer  reattempt (1) | new_time (2) | other (free text; the
--           request stays 'sent' so a later 1 or 2 still counts)
--   resolved_at  a person (or the agent) handled it
--
-- RLS mirrors webhook_endpoints: members read, admins write. The
-- webhook and MCP paths use the service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ops_settings (
  account_id              uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ndr_enabled             boolean NOT NULL DEFAULT false,
  ndr_template_name       text,
  ndr_template_language   text,
  staff_doc_template_name text,
  staff_doc_template_language text,
  sync_tags               text[] NOT NULL DEFAULT ARRAY['Order RTO', 'Blocked', 'Partial pay'],
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ops_settings_select ON ops_settings;
CREATE POLICY ops_settings_select ON ops_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ops_settings_insert ON ops_settings;
CREATE POLICY ops_settings_insert ON ops_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ops_settings_update ON ops_settings;
CREATE POLICY ops_settings_update ON ops_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ops_settings_delete ON ops_settings;
CREATE POLICY ops_settings_delete ON ops_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS ndr_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_name  text NOT NULL,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  state       text NOT NULL DEFAULT 'sent'
    CHECK (state IN ('sent', 'answered', 'expired')),
  answer      text
    CHECK (answer IS NULL OR answer IN ('reattempt', 'new_time', 'other')),
  answer_text text,
  message_id  uuid,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  replied_at  timestamptz,
  resolved_at timestamptz,
  resolved_note text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ndr_requests_account_order_key
  ON ndr_requests (account_id, order_name);

-- "The contact's open NDR" and the state listings.
CREATE INDEX IF NOT EXISTS ndr_requests_contact_open_idx
  ON ndr_requests (account_id, contact_id, state);
CREATE INDEX IF NOT EXISTS ndr_requests_account_replied_idx
  ON ndr_requests (account_id, replied_at, id)
  WHERE replied_at IS NOT NULL;

ALTER TABLE ndr_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ndr_requests_select ON ndr_requests;
CREATE POLICY ndr_requests_select ON ndr_requests FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ndr_requests_update ON ndr_requests;
CREATE POLICY ndr_requests_update ON ndr_requests FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ndr_requests_delete ON ndr_requests;
CREATE POLICY ndr_requests_delete ON ndr_requests FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Event-feed support: the feed derives events from existing tables and
-- walks them by (timestamp, id). These keep each walk an index scan.
CREATE INDEX IF NOT EXISTS contact_tags_created_idx
  ON contact_tags (created_at, id);
CREATE INDEX IF NOT EXISTS shopify_fulfillments_account_updated_idx
  ON shopify_fulfillments (account_id, updated_at, id);
CREATE INDEX IF NOT EXISTS shopify_orders_account_created_idx
  ON shopify_orders (account_id, created_at, id);
CREATE INDEX IF NOT EXISTS shopify_orders_account_cod_decided_idx
  ON shopify_orders (account_id, cod_decided_at, id)
  WHERE cod_decided_at IS NOT NULL;
