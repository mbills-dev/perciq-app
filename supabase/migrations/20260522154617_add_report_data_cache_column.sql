/*
  # Add report_data cache column to reports

  ## Summary
  Stores the fully-computed ReportData JSON (soil zones, scores, flood/wetland
  percentages, recommended test sites, area values) on the report row so that
  public/shared report pages can render an exact copy of what the authenticated
  user saw — without re-running any SSURGO, FEMA, or NWI API calls.

  ## Changes
  1. reports
     - `report_data` (jsonb, nullable) — serialized ReportData object written by
       the client when the authenticated user generates the PDF. NULL until the
       user opens the report and the map fully renders.

  ## Security
  - No RLS changes needed; existing anon SELECT policy already covers this column.
  - INSERT/UPDATE remain authenticated-only.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'report_data'
  ) THEN
    ALTER TABLE reports ADD COLUMN report_data jsonb DEFAULT NULL;
  END IF;
END $$;
