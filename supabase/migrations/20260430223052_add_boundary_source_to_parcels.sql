/*
  # Add boundary_source to parcels

  1. Changes
    - `parcels.boundary_source` (text, nullable) — tracks where the stored boundary came from.
      Values: 'regrid', 'nc1map', 'county-gis-*', 'fcc-census-block', 'point-fallback', null

  2. Notes
    - Used by the client to decide whether to skip re-fetching the boundary on load.
    - If 'regrid', boundary is authoritative and the fetch pipeline skips Step 1c.
    - If null / 'fcc-census-block' / 'point-fallback', boundary should be re-fetched.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'parcels' AND column_name = 'boundary_source'
  ) THEN
    ALTER TABLE parcels ADD COLUMN boundary_source text DEFAULT NULL;
  END IF;
END $$;
