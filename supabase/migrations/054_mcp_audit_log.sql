-- ============================================================
-- 054_mcp_audit_log.sql — MCP 2.0 tool-call audit log
--
-- Every MCP tool that is not read-only (writes, destructive actions,
-- dry runs) records one row here: which API key called which tool
-- with which arguments, and what came back. Two jobs:
--
--   1. Audit. "Who changed this tag / sent this message?" is answered
--      by the key id, not by a person who was never signed in.
--   2. Idempotency. A caller that retries a tool call with the same
--      `idempotency_key` gets the stored result back instead of the
--      action running twice (a WhatsApp message cannot be recalled).
--      The partial unique index makes the claim atomic.
--
-- Arguments are stored with secret-looking fields redacted by the app
-- (src/lib/mcp/audit.ts) before they reach this table.
--
-- RLS: admin+ may read their account's log; nothing writes through
-- RLS — the MCP endpoint uses the service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_id      uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  tool            text NOT NULL,
  tier            text NOT NULL CHECK (tier IN ('write', 'destructive')),
  status          text NOT NULL CHECK (status IN ('ok', 'error', 'dry_run')),
  args            jsonb,
  result          jsonb,
  error_code      text,
  idempotency_key text,
  duration_ms     integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_audit_log_account_created_idx
  ON mcp_audit_log (account_id, created_at DESC);

-- One successful run per (account, tool, idempotency key).
CREATE UNIQUE INDEX IF NOT EXISTS mcp_audit_log_idempotency_idx
  ON mcp_audit_log (account_id, tool, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'ok';

ALTER TABLE mcp_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcp_audit_log_select ON mcp_audit_log;
CREATE POLICY mcp_audit_log_select ON mcp_audit_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));
