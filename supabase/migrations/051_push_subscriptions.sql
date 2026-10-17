-- ============================================================
-- 051_push_subscriptions.sql — Web Push devices for the installed app
--
-- push_subscriptions
--   One row per device/browser that turned on notifications in
--   Settings → Profile. `endpoint` is the push service URL the browser
--   handed out (unique per device); p256dh / auth are its encryption
--   keys. The WhatsApp webhook sends every new customer message to all
--   of an account's devices; a push service answering 404/410 means the
--   device unsubscribed, and its row is deleted.
--
--   Service-role only (RLS on, no policies): written through
--   /api/push/subscription, which checks the signed-in member.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key
  ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx
  ON push_subscriptions (account_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
