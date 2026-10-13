-- ============================================================
-- 046_shopify_delay_cod_cart.sql — delayed sends, COD / prepaid
-- templates, the COD confirmation page and cart reminders
--
-- shopify_event_templates
--   variant        'all' | 'cod' | 'prepaid'. An event can now carry a
--                  separate template for cash-on-delivery and prepaid
--                  orders; 'all' is the fallback used when the order's
--                  own variant isn't switched on.
--   delay_minutes  0 = send as soon as the webhook arrives. Anything
--                  else parks the notification as `scheduled` until
--                  GET /api/shopify/cron picks it up.
--   event          gains cart_reminder_1..3 (abandoned checkout).
--
-- shopify_notifications
--   status         gains 'scheduled' (waiting for send_at) and
--                  'cancelled' (was scheduled, no longer wanted: the
--                  order was cancelled, the cart was bought, …).
--   send_at / payload
--                  when to send, and the snapshot (phone, name, field
--                  values) needed to send without the webhook.
--
-- shopify_orders
--   payment_mode   'cod' | 'prepaid', from the order's gateways.
--   confirm_token  unguessable slug of the public /o/<token> page a
--                  template button opens.
--   cod_decision   what the customer pressed there. The matching
--                  Shopify order tag is added through the Admin API;
--                  cod_tag_synced_at / cod_tag_error track that so the
--                  cron can retry a tag Shopify didn't take.
--
-- shopify_checkouts
--   Last seen state of an abandoned checkout — service-role only,
--   like shopify_orders (customer PII).
--
-- shopify_configs.api_scopes
--   Scopes of the connected Shopify app, so Settings can say whether
--   order tagging (write_orders) is available.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- shopify_event_templates
-- ------------------------------------------------------------
ALTER TABLE shopify_event_templates
  ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS delay_minutes integer NOT NULL DEFAULT 0;

ALTER TABLE shopify_event_templates
  DROP CONSTRAINT IF EXISTS shopify_event_templates_variant_check;
ALTER TABLE shopify_event_templates
  ADD CONSTRAINT shopify_event_templates_variant_check
  CHECK (variant IN ('all', 'cod', 'prepaid'));

ALTER TABLE shopify_event_templates
  DROP CONSTRAINT IF EXISTS shopify_event_templates_delay_minutes_check;
ALTER TABLE shopify_event_templates
  ADD CONSTRAINT shopify_event_templates_delay_minutes_check
  CHECK (delay_minutes >= 0 AND delay_minutes <= 43200);

ALTER TABLE shopify_event_templates
  DROP CONSTRAINT IF EXISTS shopify_event_templates_event_check;
ALTER TABLE shopify_event_templates
  ADD CONSTRAINT shopify_event_templates_event_check
  CHECK (event IN (
    'order_created', 'tracking_added', 'tracking_updated',
    'order_cancelled', 'out_for_delivery', 'delivered',
    'cart_reminder_1', 'cart_reminder_2', 'cart_reminder_3'));

DROP INDEX IF EXISTS shopify_event_templates_account_event_key;
CREATE UNIQUE INDEX IF NOT EXISTS shopify_event_templates_account_event_variant_key
  ON shopify_event_templates (account_id, event, variant);

-- ------------------------------------------------------------
-- shopify_notifications
-- ------------------------------------------------------------
ALTER TABLE shopify_notifications
  ADD COLUMN IF NOT EXISTS send_at timestamptz,
  ADD COLUMN IF NOT EXISTS variant text,
  ADD COLUMN IF NOT EXISTS shopify_checkout_id text,
  ADD COLUMN IF NOT EXISTS payload jsonb;

ALTER TABLE shopify_notifications
  DROP CONSTRAINT IF EXISTS shopify_notifications_status_check;
ALTER TABLE shopify_notifications
  ADD CONSTRAINT shopify_notifications_status_check
  CHECK (status IN (
    'pending', 'scheduled', 'sent', 'skipped', 'failed', 'cancelled'));

-- The cron's "what is due" scan, across accounts.
CREATE INDEX IF NOT EXISTS shopify_notifications_due_idx
  ON shopify_notifications (send_at)
  WHERE status = 'scheduled';

-- ------------------------------------------------------------
-- shopify_orders
-- ------------------------------------------------------------
ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS payment_mode text,
  ADD COLUMN IF NOT EXISTS confirm_token text,
  ADD COLUMN IF NOT EXISTS cod_decision text,
  ADD COLUMN IF NOT EXISTS cod_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS cod_tag_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS cod_tag_error text;

ALTER TABLE shopify_orders
  DROP CONSTRAINT IF EXISTS shopify_orders_payment_mode_check;
ALTER TABLE shopify_orders
  ADD CONSTRAINT shopify_orders_payment_mode_check
  CHECK (payment_mode IS NULL OR payment_mode IN ('cod', 'prepaid'));

ALTER TABLE shopify_orders
  DROP CONSTRAINT IF EXISTS shopify_orders_cod_decision_check;
ALTER TABLE shopify_orders
  ADD CONSTRAINT shopify_orders_cod_decision_check
  CHECK (cod_decision IS NULL OR cod_decision IN ('confirmed', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS shopify_orders_confirm_token_key
  ON shopify_orders (confirm_token)
  WHERE confirm_token IS NOT NULL;

-- "Has this phone ordered since the cart was abandoned?"
CREATE INDEX IF NOT EXISTS shopify_orders_account_phone_idx
  ON shopify_orders (account_id, phone, created_at DESC);

-- ------------------------------------------------------------
-- shopify_checkouts — service-role only (customer PII)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_checkouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shopify_checkout_id text NOT NULL,
  phone               text,                    -- digits-only E.164, or NULL
  customer_name       text,
  fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at        timestamptz,
  source_updated_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopify_checkouts_account_checkout_key
  ON shopify_checkouts (account_id, shopify_checkout_id);

DROP TRIGGER IF EXISTS set_updated_at ON shopify_checkouts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shopify_checkouts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shopify_checkouts ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- shopify_configs
-- ------------------------------------------------------------
ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS api_scopes text;
