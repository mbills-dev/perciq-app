ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS usage_period_start timestamptz;
