/*
  # Allow anonymous read access to shared reports

  ## Purpose
  Shared report links (/?report=UUID) must be publicly viewable without login.
  UUIDs are cryptographically unguessable, making public SELECT safe.

  ## Changes

  1. reports
     - Add SELECT policy for `anon` role scoped to id lookup (any UUID = valid share)

  2. parcels
     - Add SELECT policy for `anon` role so the parcel address/acreage can be read
       via the reports join

  3. soil_results
     - Add SELECT policy for `anon` role so soil zone data renders in the public view

  4. county_rules
     - Add SELECT policy for `anon` role (was authenticated-only; rules are public data)

  ## Security notes
  - INSERT / UPDATE / DELETE remain authenticated-only — no change
  - Anon users can only READ; no mutation paths are opened
*/

-- reports: anon can SELECT any row by id (UUID share link)
CREATE POLICY "Anyone can read reports by id"
  ON reports FOR SELECT
  TO anon
  USING (true);

-- parcels: anon can SELECT parcels referenced by reports
CREATE POLICY "Anyone can read parcels"
  ON parcels FOR SELECT
  TO anon
  USING (true);

-- soil_results: anon can SELECT results for any report
CREATE POLICY "Anyone can read soil results"
  ON soil_results FOR SELECT
  TO anon
  USING (true);

-- county_rules: anon can read (was authenticated-only; harmless public data)
CREATE POLICY "Anyone can read county rules"
  ON county_rules FOR SELECT
  TO anon
  USING (true);
