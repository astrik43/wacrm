-- ============================================================
-- 055_contacts_is_staff.sql — flag internal team members
--
-- A staff contact is someone on the team (e.g. the person who prints
-- the day's shipping labels), not a customer. The flag lets every
-- marketing path skip them: broadcast audiences (even "All
-- contacts"), marketing counts and spend, abandoned-cart and
-- order-update messages, and customer metrics such as response time.
-- It is also the only recipient type the MCP `send_document_to_staff`
-- tool may send to.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN contacts.is_staff IS
  'Internal team member, not a customer. Excluded from broadcasts, marketing counts and customer metrics.';

-- Staff are few; the partial index keeps "exclude staff" cheap and
-- "list staff" instant.
CREATE INDEX IF NOT EXISTS contacts_account_staff_idx
  ON contacts (account_id)
  WHERE is_staff;
