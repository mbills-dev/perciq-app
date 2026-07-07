/*
# Add terms_accepted_at to user_profiles

1. Changes to user_profiles table
   - Adds `terms_accepted_at` (timestamptz, nullable) — records the UTC timestamp at which
     the user accepted the Terms of Service and Privacy Policy during account creation.
     NULL means the account was created before this column existed (pre-migration users).

2. Notes
   - Column is nullable so existing rows are not broken.
   - New sign-ups will have this set to now() immediately after supabase.auth.signUp() succeeds.
   - No RLS changes required; existing user_profiles policies already cover this column.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'terms_accepted_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN terms_accepted_at timestamptz DEFAULT NULL;
  END IF;
END $$;
