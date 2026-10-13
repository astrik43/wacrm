-- ============================================================
-- 043_shopify_integration.sql — Shopify order updates on WhatsApp
--
-- Lets an account point Shopify's webhooks (Settings → Notifications
-- → Webhooks in Shopify admin) at wacrm and have the customer receive
-- a WhatsApp template message when an order is created or cancelled,
-- when tracking is added or changed, and when a shipment goes out for
-- delivery or is delivered.
--
-- Tables
--   shopify_configs          one row per account: the unguessable URL
--                            token and Shopify's webhook signing secret.
--   shopify_event_templates  per-event switch, template and variable
--                            mapping chosen in Settings → Shopify.
--   shopify_orders           what we need to remember about an order —
--                            fulfillment webhooks don't repeat the
--                            order's phone / totals.
--   shopify_fulfillments     last seen tracking + shipment status, so a
--                            `fulfillments/update` can be classified as
--                            "tracking added", "tracking updated", "out
--                            for delivery" or "delivered".
--   shopify_notifications    one row per (event, order/shipment). The
--                            unique `dedupe_key` is the exactly-once
--                            claim against Shopify's retries, and the
--                            rows are the activity list in the UI.
--
-- Design notes
--   - Account-scoped, never user-scoped (same as `webhook_endpoints`).
--   - `webhook_secret` is needed in plaintext to verify each delivery's
--     HMAC, so it is AES-256-GCM-encrypted at rest with the same
--     `encrypt()`/`decrypt()` as `whatsapp_config.access_token`. It is
--     never returned to the client.
--   - Shopify ids are stored as `text`: they are 64-bit integers that
--     overflow a JS number once parsed.
--   - `shop_domain` is captured from the first verified delivery for
--     display only. The token + signature identify the account.
--
-- RLS
--   shopify_configs / shopify_event_templates are settings-class: any
--   member reads, admin+ writes. shopify_notifications is member-read,
--   service-role-write. shopify_orders / shopify_fulfillments hold
--   customer PII and engine state: RLS on with no client policies, so
--   only the service-role webhook path touches them.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- shopify_configs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_configs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  webhook_token        text NOT NULL,          -- URL slug: /api/shopify/webhook/<token>
  webhook_secret       text NOT NULL,          -- AES-256-GCM-encrypted Shopify signing secret
  shop_domain          text,                   -- captured from X-Shopify-Shop-Domain
  default_country_code text
    CHECK (default_country_code IS NULL OR default_country_code ~ '^[1-9][0-9]{0,2}$'),
  is_active            boolean NOT NULL DEFAULT true,
  last_webhook_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_configs_account_id_key
  ON shopify_configs (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS shopify_configs_webhook_token_key
  ON shopify_configs (webhook_token);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shopify_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shopify_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_configs_select ON shopify_configs;
CREATE POLICY shopify_configs_select ON shopify_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS shopify_configs_insert ON shopify_configs;
CREATE POLICY shopify_configs_insert ON shopify_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_configs_update ON shopify_configs;
CREATE POLICY shopify_configs_update ON shopify_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_configs_delete ON shopify_configs;
CREATE POLICY shopify_configs_delete ON shopify_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- shopify_event_templates
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_event_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event             text NOT NULL CHECK (event IN (
                      'order_created', 'tracking_added', 'tracking_updated',
                      'order_cancelled', 'out_for_delivery', 'delivered')),
  is_enabled        boolean NOT NULL DEFAULT false,
  template_name     text,
  template_language text,
  variable_mapping  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_event_templates_account_event_key
  ON shopify_event_templates (account_id, event);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_event_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shopify_event_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shopify_event_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_event_templates_select ON shopify_event_templates;
CREATE POLICY shopify_event_templates_select ON shopify_event_templates FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS shopify_event_templates_insert ON shopify_event_templates;
CREATE POLICY shopify_event_templates_insert ON shopify_event_templates FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_event_templates_update ON shopify_event_templates;
CREATE POLICY shopify_event_templates_update ON shopify_event_templates FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS shopify_event_templates_delete ON shopify_event_templates;
CREATE POLICY shopify_event_templates_delete ON shopify_event_templates FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- shopify_orders — service-role only (customer PII)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shopify_order_id  text NOT NULL,
  order_name        text,                      -- "#1042"
  phone             text,                      -- digits-only E.164, or NULL
  customer_name     text,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  fields            jsonb NOT NULL DEFAULT '{}'::jsonb, -- mappable template values
  cancelled_at      timestamptz,
  source_updated_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_orders_account_order_key
  ON shopify_orders (account_id, shopify_order_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shopify_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shopify_orders ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- shopify_fulfillments — service-role only (engine state)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_fulfillments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shopify_fulfillment_id text NOT NULL,
  shopify_order_id       text,
  tracking_number        text,
  tracking_url           text,
  tracking_company       text,
  shipment_status        text,
  source_updated_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_fulfillments_account_fulfillment_key
  ON shopify_fulfillments (account_id, shopify_fulfillment_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_fulfillments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shopify_fulfillments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shopify_fulfillments ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- shopify_notifications — claim ledger + activity list
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_notifications (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event                  text NOT NULL,
  shopify_order_id       text,
  shopify_fulfillment_id text,
  order_name             text,
  dedupe_key             text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  reason                 text,
  message_id             uuid REFERENCES messages(id) ON DELETE SET NULL,
  whatsapp_message_id    text,
  shopify_webhook_id     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Plain (non-partial) unique index: PostgREST can only infer an
-- ON CONFLICT target from a non-partial index, and the claim is an
-- upsert with ignoreDuplicates.
CREATE UNIQUE INDEX IF NOT EXISTS shopify_notifications_account_dedupe_key
  ON shopify_notifications (account_id, dedupe_key);
CREATE INDEX IF NOT EXISTS shopify_notifications_account_created_idx
  ON shopify_notifications (account_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_notifications;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shopify_notifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shopify_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_notifications_select ON shopify_notifications;
CREATE POLICY shopify_notifications_select ON shopify_notifications FOR SELECT
  USING (is_account_member(account_id));

-- ============================================================
-- Atomic fulfillment state transition.
--
-- Deciding "tracking added" vs "tracking updated" vs "out for
-- delivery" needs the PREVIOUS state of the shipment. Shopify can
-- deliver several fulfillment webhooks at once and out of order, and
-- each is processed in its own after() run, so a read-then-write from
-- the app would let two deliveries both see the same "previous" state
-- and both announce the same change. Here the row is locked, stale
-- deliveries (older `updated_at` than what we stored) are rejected,
-- and the previous values are returned from the same transaction.
--
-- applied = false  → stale delivery, nothing changed, send nothing.
-- was_new = true   → first time we see this fulfillment (prev_* NULL).
-- ============================================================
CREATE OR REPLACE FUNCTION public.shopify_apply_fulfillment(
  p_account_id        uuid,
  p_fulfillment_id    text,
  p_order_id          text,
  p_tracking_number   text,
  p_tracking_url      text,
  p_tracking_company  text,
  p_shipment_status   text,
  p_source_updated_at timestamptz
)
RETURNS TABLE (
  applied              boolean,
  was_new              boolean,
  prev_tracking_number text,
  prev_tracking_url    text,
  prev_shipment_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted uuid;
  v_row      shopify_fulfillments%ROWTYPE;
BEGIN
  INSERT INTO shopify_fulfillments (
    account_id, shopify_fulfillment_id, shopify_order_id, tracking_number,
    tracking_url, tracking_company, shipment_status, source_updated_at
  ) VALUES (
    p_account_id, p_fulfillment_id, p_order_id, p_tracking_number,
    p_tracking_url, p_tracking_company, p_shipment_status, p_source_updated_at
  )
  ON CONFLICT (account_id, shopify_fulfillment_id) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NOT NULL THEN
    RETURN QUERY SELECT true, true, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO v_row
  FROM shopify_fulfillments f
  WHERE f.account_id = p_account_id
    AND f.shopify_fulfillment_id = p_fulfillment_id
  FOR UPDATE;

  IF v_row.source_updated_at IS NOT NULL
     AND p_source_updated_at IS NOT NULL
     AND p_source_updated_at < v_row.source_updated_at THEN
    RETURN QUERY SELECT false, false,
      v_row.tracking_number, v_row.tracking_url, v_row.shipment_status;
    RETURN;
  END IF;

  UPDATE shopify_fulfillments f
  SET shopify_order_id  = COALESCE(p_order_id, f.shopify_order_id),
      tracking_number   = p_tracking_number,
      tracking_url      = p_tracking_url,
      tracking_company  = p_tracking_company,
      shipment_status   = p_shipment_status,
      source_updated_at = COALESCE(p_source_updated_at, f.source_updated_at)
  WHERE f.id = v_row.id;

  RETURN QUERY SELECT true, false,
    v_row.tracking_number, v_row.tracking_url, v_row.shipment_status;
END;
$$;

-- Only the service role (Shopify webhook) calls this. Lock everyone
-- else out so an authenticated user can't rewrite another account's
-- shipment state (mirrors 037).
REVOKE ALL ON FUNCTION public.shopify_apply_fulfillment(uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shopify_apply_fulfillment(uuid, text, text, text, text, text, text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.shopify_apply_fulfillment(uuid, text, text, text, text, text, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.shopify_apply_fulfillment(uuid, text, text, text, text, text, text, timestamptz) TO service_role;
