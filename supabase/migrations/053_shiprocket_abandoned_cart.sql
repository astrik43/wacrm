-- ============================================================
-- 053_shiprocket_abandoned_cart.sql — Shiprocket Checkout (Fastrr)
-- abandoned carts
--
-- Like FlexyPe (047), Shiprocket Checkout replaces Shopify's checkout,
-- so a store using it never produces Shopify `checkouts/*` webhooks.
-- Shiprocket's "Abandon Cart" webhook feeds the same cart reminders
-- (cart_reminder_1..3), recorded in shopify_checkouts with the id
-- `shiprocket:<cart id>`. Both checkouts can be on at once, so a store
-- can switch between them without reconfiguring anything.
--
-- shopify_configs
--   shiprocket_secret     AES-256-GCM ciphertext of the secret
--                         Shiprocket sends in the X-Chatstrik-Secret
--                         header (added under Headers when creating
--                         the webhook). NULL = the connection is off.
--                         The webhook URL reuses the row's
--                         webhook_token.
--   shiprocket_last_webhook_at
--                         last delivery that passed the secret check,
--                         for the settings card.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS shiprocket_secret text,
  ADD COLUMN IF NOT EXISTS shiprocket_last_webhook_at timestamptz;
