-- ============================================================
-- 049_shopify_test_mode.sql — try Shopify updates without messaging
-- customers
--
-- shopify_configs
--   test_mode      while true, webhooks are processed as usual but a
--                  message is only sent to a phone in test_phones;
--                  every other send is recorded as skipped (test_mode).
--   test_phones    digits-only international numbers (at most 5) that
--                  still get messages in test mode, and that "Send
--                  test" offers.
--
-- shopify_notifications
--   is_test        a message sent with "Send test" from the settings
--                  dialog rather than by a webhook.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_configs
  ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_phones text[] NOT NULL DEFAULT '{}';

ALTER TABLE shopify_configs
  DROP CONSTRAINT IF EXISTS shopify_configs_test_phones_check;
ALTER TABLE shopify_configs
  ADD CONSTRAINT shopify_configs_test_phones_check
  CHECK (cardinality(test_phones) <= 5);

ALTER TABLE shopify_notifications
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
