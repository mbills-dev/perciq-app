/*
  # Add overlay cache fields to reports

  1. Modified Tables
    - `reports`
      - `fema_feature_count` (integer, nullable) — number of FEMA flood zone features returned for this parcel
      - `nwi_feature_count` (integer, nullable) — number of NWI wetland features returned for this parcel

  2. Purpose
    These fields allow the cache-validity check to detect reports that were scored before
    FEMA/NWI data was available (feature counts null or zero), forcing a full re-pipeline
    instead of serving stale scores with missing overlay data.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'fema_feature_count'
  ) THEN
    ALTER TABLE reports ADD COLUMN fema_feature_count integer DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'nwi_feature_count'
  ) THEN
    ALTER TABLE reports ADD COLUMN nwi_feature_count integer DEFAULT NULL;
  END IF;
END $$;
