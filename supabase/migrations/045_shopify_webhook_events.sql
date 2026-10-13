-- ============================================================
-- 045_shopify_webhook_events.sql — Shopify webhook log
--
-- One row per delivery that reached a connected store's webhook URL,
-- so "Shopify says it sent the webhook, why did the customer get
-- nothing?" can be answered from Settings → Shopify instead of the
-- server logs:
--
--   received   accepted, processing has not finished (or the process
--              died mid-way).
--   processed  handled. `outcome` lists each customer update it
--              produced and what happened to it; `detail` explains a
--              delivery that produced none (stale update, no change,
--              order already cancelled, …).
--   ignored    accepted but not acted on (connection paused, or a
--              topic wacrm doesn't handle).
--   rejected   failed the signature check or wasn't JSON. No payload
--              is kept: it didn't prove it came from Shopify.
--   error      processing threw; `detail` has the message.
--
-- `payload` is the delivery body. It contains customer PII (names,
-- addresses, phone numbers), so the table is readable by admin+ only,
-- written only by the service-role webhook, and the app prunes rows
-- older than 30 days as new ones arrive.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  received_at        timestamptz NOT NULL DEFAULT now(),
  topic              text,
  shopify_webhook_id text,
  shop_domain        text,
  order_ref          text,                     -- "#1042" when known
  status             text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'rejected', 'error')),
  detail             text,
  outcome            jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload            jsonb
);

CREATE INDEX IF NOT EXISTS shopify_webhook_events_account_received_idx
  ON shopify_webhook_events (account_id, received_at DESC);

ALTER TABLE shopify_webhook_events ENABLE ROW LEVEL SECURITY;

-- Admin+ only: unlike shopify_notifications, these rows carry the
-- raw order payload.
DROP POLICY IF EXISTS shopify_webhook_events_select ON shopify_webhook_events;
CREATE POLICY shopify_webhook_events_select ON shopify_webhook_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));
