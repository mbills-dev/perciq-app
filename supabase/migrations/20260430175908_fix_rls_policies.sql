/*
  # Fix RLS policies for all tables

  ## Changes

  1. parcels
     - Add user_id column (uuid, references auth.users) so ownership is explicit
     - Backfill user_id from the associated report where possible
     - Drop old loose policies (INSERT WITH CHECK true, SELECT via reports join)
     - Add four tight policies: SELECT / INSERT / UPDATE / DELETE all scoped to auth.uid() = user_id

  2. reports
     - Drop and recreate all four policies (they were correct but this keeps naming consistent)

  3. soil_results
     - Existing SELECT + INSERT policies are correct — no change needed

  4. county_rules
     - Existing SELECT policy uses USING (true) — correct for public read
     - Add explicit service-role-only INSERT and UPDATE policies

  5. nearby_tests
     - Same pattern as county_rules
*/

-- ============================================================
-- 1. parcels — add user_id column
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'parcels'
      AND column_name  = 'user_id'
  ) THEN
    ALTER TABLE parcels ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill: set user_id from the earliest report that references each parcel
UPDATE parcels p
SET user_id = (
  SELECT r.user_id
  FROM reports r
  WHERE r.parcel_id = p.id
  ORDER BY r.created_at ASC
  LIMIT 1
)
WHERE p.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_parcels_user_id ON parcels(user_id);

-- ============================================================
-- 2. Drop all existing policies we are replacing
-- ============================================================

DROP POLICY IF EXISTS "Users can insert parcels"                         ON parcels;
DROP POLICY IF EXISTS "Users can view parcels they have reports for"     ON parcels;

DROP POLICY IF EXISTS "Users can view own reports"                       ON reports;
DROP POLICY IF EXISTS "Users can insert own reports"                     ON reports;
DROP POLICY IF EXISTS "Users can update own reports"                     ON reports;
DROP POLICY IF EXISTS "Users can delete own reports"                     ON reports;

DROP POLICY IF EXISTS "Authenticated users can view county rules"        ON county_rules;
DROP POLICY IF EXISTS "Authenticated users can view nearby tests"        ON nearby_tests;

-- ============================================================
-- 3. parcels — four owner-scoped policies
-- ============================================================

CREATE POLICY "Owners can select own parcels"
  ON parcels FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Owners can insert own parcels"
  ON parcels FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners can update own parcels"
  ON parcels FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners can delete own parcels"
  ON parcels FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- 4. reports — four owner-scoped policies
-- ============================================================

CREATE POLICY "Owners can select own reports"
  ON reports FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Owners can insert own reports"
  ON reports FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners can update own reports"
  ON reports FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners can delete own reports"
  ON reports FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- 5. soil_results — existing policies are correct, leave them
--    (SELECT + INSERT scoped via report ownership subquery)
-- ============================================================

-- ============================================================
-- 6. county_rules — public read, service-role-only writes
-- ============================================================

CREATE POLICY "Authenticated users can read county rules"
  ON county_rules FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert county rules"
  ON county_rules FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update county rules"
  ON county_rules FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 7. nearby_tests — public read, service-role-only writes
-- ============================================================

CREATE POLICY "Authenticated users can read nearby tests"
  ON nearby_tests FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert nearby tests"
  ON nearby_tests FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update nearby tests"
  ON nearby_tests FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);
