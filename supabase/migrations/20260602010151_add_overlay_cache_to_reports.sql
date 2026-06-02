/*
  # Add overlay_geojson cache column to reports

  ## Summary
  Adds a single `overlay_geojson` JSONB column to the `reports` table to cache
  the raw FEMA flood zone and NWI wetland GeoJSON features after the first
  analysis. On subsequent opens the app loads this column instead of re-fetching
  from Esri ArcGIS REST services, eliminating all repeat overlay API calls.

  ## Changes
  - `reports.overlay_geojson` (jsonb, nullable) — stores an object with two
    arrays: `femaFeatures` and `nwiFeatures`, each containing the clipped
    GeoJSON features returned by FEMA/NWI on the first pipeline run.

  ## Notes
  - Column is nullable so existing rows remain valid.
  - No RLS changes required; existing policies on `reports` already cover this column.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'overlay_geojson'
  ) THEN
    ALTER TABLE reports ADD COLUMN overlay_geojson jsonb;
  END IF;
END $$;
