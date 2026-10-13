-- ============================================================
-- 044_shopify_api_credentials.sql — Shopify Admin API access
--
-- Order webhooks carry product ids but no image links. To put the
-- ordered product's picture in a template's image header, wacrm has
-- to look the image up through Shopify's Admin API, which needs
-- credentials: the client id + secret of an app the merchant creates
-- in Shopify's Dev Dashboard (client-credentials grant).
--
-- Columns (all optional — the integration works without them, just
-- with the template's own static image):
--   api_client_id        the app's client id (not a secret).
--   api_client_secret    AES-256-GCM-encrypted, like webhook_secret.
--   api_access_token     AES-256-GCM-encrypted. Shopify issues these
--                        for 24 hours; cached here so each order
--                        doesn't cost a token exchange.
--   api_token_expires_at when the cached token stops being usable.
--
-- RLS is unchanged: shopify_configs is already settings-class (043).
-- The API routes never select the secret or token for the client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS api_client_id text;

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS api_client_secret text;

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS api_access_token text;

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS api_token_expires_at timestamptz;
