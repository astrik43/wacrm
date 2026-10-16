-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- Shopify integration (043). The webhook path and the settings
  -- routes use untyped clients, so a missing table or a wrong RPC
  -- signature is a runtime error on a customer's order, not a build
  -- failure.
  IF to_regclass('public.shopify_configs') IS NULL
     OR to_regclass('public.shopify_event_templates') IS NULL
     OR to_regclass('public.shopify_orders') IS NULL
     OR to_regclass('public.shopify_fulfillments') IS NULL
     OR to_regclass('public.shopify_notifications') IS NULL THEN
    RAISE EXCEPTION
      'shopify_* tables are missing — migration 043 did not apply';
  END IF;

  IF to_regprocedure(
       'public.shopify_apply_fulfillment(uuid, text, text, text, text, text, text, timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'shopify_apply_fulfillment is missing — migration 043 did not apply';
  END IF;

  -- Shopify Admin API credentials (044). The webhook's config lookup
  -- selects these columns by name on an untyped client, so a missing
  -- one turns every Shopify delivery into a 503.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shopify_configs'
      AND column_name IN (
        'api_client_id', 'api_client_secret',
        'api_access_token', 'api_token_expires_at'
      )
  ) <> 4 THEN
    RAISE EXCEPTION
      'shopify_configs.api_* columns are missing — migration 044 did not apply';
  END IF;

  -- Shopify webhook log (045). Written by the webhook on every
  -- delivery through an untyped client.
  IF to_regclass('public.shopify_webhook_events') IS NULL THEN
    RAISE EXCEPTION
      'shopify_webhook_events is missing — migration 045 did not apply';
  END IF;

  -- Delayed sends, COD / prepaid templates, cart reminders (046).
  -- All read and written by name through untyped clients.
  IF to_regclass('public.shopify_checkouts') IS NULL THEN
    RAISE EXCEPTION
      'shopify_checkouts is missing — migration 046 did not apply';
  END IF;
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('shopify_event_templates', 'variant'),
        ('shopify_event_templates', 'delay_minutes'),
        ('shopify_notifications', 'send_at'),
        ('shopify_notifications', 'payload'),
        ('shopify_notifications', 'shopify_checkout_id'),
        ('shopify_orders', 'payment_mode'),
        ('shopify_orders', 'confirm_token'),
        ('shopify_orders', 'cod_decision'),
        ('shopify_orders', 'cod_tag_synced_at'),
        ('shopify_configs', 'api_scopes')
      )
  ) <> 10 THEN
    RAISE EXCEPTION
      'shopify delay / COD columns are missing — migration 046 did not apply';
  END IF;
  -- Follow-up messages (048). The settings upsert targets
  -- (account_id, event, variant, step); without that exact index
  -- PostgREST rejects every save.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('shopify_event_templates', 'step'),
        ('shopify_notifications', 'step')
      )
  ) <> 2 THEN
    RAISE EXCEPTION
      'shopify step columns are missing — migration 048 did not apply';
  END IF;
  IF to_regclass('public.shopify_event_templates_account_event_variant_step_key') IS NULL THEN
    RAISE EXCEPTION
      'shopify_event_templates step index is missing — migration 048 did not apply';
  END IF;
  -- Test mode (049): the webhook path reads these on every send.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('shopify_configs', 'test_mode'),
        ('shopify_configs', 'test_phones'),
        ('shopify_notifications', 'is_test')
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'shopify test mode columns are missing — migration 049 did not apply';
  END IF;

  -- FlexyPe abandoned checkouts (047). Read by the FlexyPe webhook
  -- through an untyped client.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shopify_configs'
      AND column_name IN ('flexype_secret', 'flexype_last_webhook_at')
  ) <> 2 THEN
    RAISE EXCEPTION
      'shopify_configs.flexype_* columns are missing — migration 047 did not apply';
  END IF;

  -- WhatsApp message charges (050). Read by the Transaction Details
  -- page; written by the status webhook through record_message_status.
  IF to_regclass('public.message_charges') IS NULL THEN
    RAISE EXCEPTION 'message_charges is missing — migration 050 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'record_message_status'
  ) THEN
    RAISE EXCEPTION
      'record_message_status() is missing — migration 050 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
