/*
  # PercIQ Core Schema

  ## Tables
  1. `parcels` - Stores land parcel data with location and geometry
  2. `reports` - Analysis reports linked to parcels and users
  3. `soil_results` - SSURGO soil data results per report
  4. `county_rules` - Local regulatory rules per county/state
  5. `nearby_tests` - Historical perc test outcomes

  ## Security
  - RLS enabled on all tables
  - Users can only access their own reports and related data
  - County rules and nearby_tests are readable by all authenticated users
  - Parcels are accessible to owners of associated reports
*/

-- Parcels table
CREATE TABLE IF NOT EXISTS parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text,
  apn text,
  lat float8,
  lng float8,
  state text,
  county text,
  boundary_geojson jsonb,
  acreage float8,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE parcels ENABLE ROW LEVEL SECURITY;

-- Reports table
CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  conventional_score int2,
  alternative_score int2,
  confidence int2,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Soil results table
CREATE TABLE IF NOT EXISTS soil_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  map_unit_key text,
  map_unit_name text,
  texture_class text,
  drainage_class text,
  perc_class text,
  nrcs_septic_rating text,
  depth_water_table float4,
  ksat_low float4,
  ksat_high float4,
  slope_low float4,
  slope_high float4,
  pct_coverage float4,
  raw_ssurgo jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE soil_results ENABLE ROW LEVEL SECURITY;

-- County rules table
CREATE TABLE IF NOT EXISTS county_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text,
  county text,
  min_lot_size_acres float4,
  setback_well_ft int2,
  setback_property_line_ft int2,
  setback_water_ft int2,
  alt_systems_allowed boolean DEFAULT false,
  notes text,
  last_updated date
);

ALTER TABLE county_rules ENABLE ROW LEVEL SECURITY;

-- Nearby tests table
CREATE TABLE IF NOT EXISTS nearby_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county text,
  state text,
  lat float8,
  lng float8,
  outcome text,
  system_type text,
  map_unit_key text,
  test_year int2,
  source text,
  verified boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE nearby_tests ENABLE ROW LEVEL SECURITY;

-- RLS Policies: parcels
-- Parcels are readable if the user owns a report for that parcel
CREATE POLICY "Users can view parcels they have reports for"
  ON parcels FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM reports
      WHERE reports.parcel_id = parcels.id
      AND reports.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert parcels"
  ON parcels FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- RLS Policies: reports
CREATE POLICY "Users can view own reports"
  ON reports FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reports"
  ON reports FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reports"
  ON reports FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own reports"
  ON reports FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- RLS Policies: soil_results (accessible if user owns the associated report)
CREATE POLICY "Users can view soil results for own reports"
  ON soil_results FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM reports
      WHERE reports.id = soil_results.report_id
      AND reports.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert soil results for own reports"
  ON soil_results FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM reports
      WHERE reports.id = soil_results.report_id
      AND reports.user_id = auth.uid()
    )
  );

-- RLS Policies: county_rules (read-only for all authenticated users)
CREATE POLICY "Authenticated users can view county rules"
  ON county_rules FOR SELECT
  TO authenticated
  USING (true);

-- RLS Policies: nearby_tests (read-only for all authenticated users)
CREATE POLICY "Authenticated users can view nearby tests"
  ON nearby_tests FOR SELECT
  TO authenticated
  USING (true);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_parcel_id ON reports(parcel_id);
CREATE INDEX IF NOT EXISTS idx_soil_results_report_id ON soil_results(report_id);
CREATE INDEX IF NOT EXISTS idx_county_rules_state_county ON county_rules(state, county);
CREATE INDEX IF NOT EXISTS idx_nearby_tests_county_state ON nearby_tests(county, state);
