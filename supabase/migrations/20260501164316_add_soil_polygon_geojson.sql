/*
  # Add soil_polygon_geojson to soil_results

  ## Summary
  Adds a spatial geometry column to soil_results so each soil map unit
  can store the actual SSURGO polygon that was returned by SDA.

  ## Changes
  - `soil_results.soil_polygon_geojson` (jsonb, nullable) — the GeoJSON
    geometry for the soil map unit polygon clipped/intersected with the
    parcel boundary, as returned by SDA's mupolygongeo field.

  ## Notes
  - Existing rows will have NULL in this column; they will be backfilled
    the next time a report is re-analyzed.
  - No RLS changes needed — this column inherits the existing RLS on the
    soil_results table.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'soil_results' AND column_name = 'soil_polygon_geojson'
  ) THEN
    ALTER TABLE soil_results ADD COLUMN soil_polygon_geojson jsonb;
  END IF;
END $$;
