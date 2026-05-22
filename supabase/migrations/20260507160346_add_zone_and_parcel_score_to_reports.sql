/*
  # Add best_zone_score and parcel_score to reports

  ## Summary
  The dashboard was showing `conventional_score` (raw server-side SSURGO score, ~52)
  instead of the client-computed best-zone score (~83) that accounts for per-polygon
  soil factor scoring, flood/wetland penalties, and area weighting.

  ## Changes
  - `reports.best_zone_score` (smallint): highest suitabilityScore across all scored
    soil polygons on the parcel — what the right panel shows as "Best Zone".
  - `reports.parcel_score` (smallint): area-weighted average of all polygon scores
    with flood/wetland penalties applied — what the right panel shows as "Parcel Overall".

  Both are nullable (NULL until the client computes and writes them back after the
  soil overlay renders). The dashboard and reports list will prefer these over
  conventional_score when present.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'best_zone_score'
  ) THEN
    ALTER TABLE reports ADD COLUMN best_zone_score smallint;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'parcel_score'
  ) THEN
    ALTER TABLE reports ADD COLUMN parcel_score smallint;
  END IF;
END $$;
