-- ============================================================
-- 048_shopify_follow_ups.sql — several messages per Shopify update
--
-- shopify_event_templates
--   step           0 = the update's first message; 1..4 = follow-ups
--                  (e.g. a feedback request 15 days after "delivered").
--                  Every step has its own template, mapping and delay,
--                  each counted from when the update happened.
--   delay_minutes  limit raised from 30 to 90 days.
--   unique key     now (account_id, event, variant, step).
--
-- shopify_notifications
--   step           which message of the update this row is, so the
--                  cron sends it with that step's current settings.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE shopify_event_templates
  ADD COLUMN IF NOT EXISTS step integer NOT NULL DEFAULT 0;

ALTER TABLE shopify_event_templates
  DROP CONSTRAINT IF EXISTS shopify_event_templates_step_check;
ALTER TABLE shopify_event_templates
  ADD CONSTRAINT shopify_event_templates_step_check
  CHECK (step >= 0 AND step <= 4);

ALTER TABLE shopify_event_templates
  DROP CONSTRAINT IF EXISTS shopify_event_templates_delay_minutes_check;
ALTER TABLE shopify_event_templates
  ADD CONSTRAINT shopify_event_templates_delay_minutes_check
  CHECK (delay_minutes >= 0 AND delay_minutes <= 129600);

DROP INDEX IF EXISTS shopify_event_templates_account_event_variant_key;
CREATE UNIQUE INDEX IF NOT EXISTS shopify_event_templates_account_event_variant_step_key
  ON shopify_event_templates (account_id, event, variant, step);

ALTER TABLE shopify_notifications
  ADD COLUMN IF NOT EXISTS step integer NOT NULL DEFAULT 0;
