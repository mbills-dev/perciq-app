-- Prevent clients from directly updating monthly_analyses_used or analyses_reset_at.
-- The increment-analysis-count edge function (service role) is the only writer.
-- We achieve this by dropping the existing broad UPDATE policy and replacing it
-- with a column-restricted one that excludes those two fields.

-- Drop existing user self-update policy (recreated below without the counter columns)
DROP POLICY IF EXISTS "update_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;

-- Restricted update policy: users may update profile/billing fields but NOT
-- monthly_analyses_used or analyses_reset_at (those are service-role only).
CREATE POLICY "update_own_profile" ON user_profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
  );

-- Revoke direct column write on the counter columns from the authenticated role.
-- Service role bypasses RLS so the edge function is unaffected.
REVOKE UPDATE (monthly_analyses_used, analyses_reset_at) ON user_profiles FROM authenticated;
