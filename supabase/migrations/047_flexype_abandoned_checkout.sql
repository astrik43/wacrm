-- ============================================================
-- 047_flexype_abandoned_checkout.sql — FlexyPe abandoned checkouts
--
-- Stores that check out through FlexyPe never produce Shopify
-- `checkouts/*` webhooks; FlexyPe instead sends its own Abandoned
-- Checkout Recovery (ACR) webhook 15 minutes after a checkout session
-- is left unfinished. Those feed the same cart reminders
-- (cart_reminder_1..3) as Shopify checkouts, recorded in
-- shopify_checkouts with the id `flexype:<session_id>`.
--
-- shopify_configs
--   flexype_secret        AES-256-GCM ciphertext of the secret FlexyPe
--                         sends in X-Flexype-Authorization. NULL = the
--                         FlexyPe connection is off. The webhook URL
--                         reuses the row's webhook_token.
--   flexype_last_webhook_at
--                         last FlexyPe delivery that passed the secret
--                         check, for the settings card.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS flexype_secret text,
  ADD COLUMN IF NOT EXISTS flexype_last_webhook_at timestamptz;
