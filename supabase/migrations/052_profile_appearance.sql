-- ============================================================
-- 052_profile_appearance.sql — remember each person's theme
--
-- profiles.theme / profiles.color_mode
--   The accent colour and light/dark mode a member picked. The app
--   already keeps them in the browser (so pages paint in the right
--   theme before anything loads); these columns carry the choice to
--   every device and survive the browser's storage being cleared.
--   Written by the member's own session (profiles' existing
--   "update own row" policy).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS theme text,
  ADD COLUMN IF NOT EXISTS color_mode text;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_color_mode_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_color_mode_check
  CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark'));

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_theme_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_theme_check
  CHECK (theme IS NULL OR theme ~ '^[a-z][a-z0-9-]{0,31}$');
