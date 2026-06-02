/*
  # Add water_table_depth column and backfill ksat_r

  ## Changes

  1. New column: `water_table_depth` on `soil_results`
     - Stores the true seasonal high water table depth in inches
     - Derived from SSURGO cosoilmoist (soimoistdept_l where soimoiststat = 'Wet', minimum across months)
     - Kept separate from `depth_water_table` (which was incorrectly storing resdept_r)
     - NOTE: `depth_water_table` continues to store resdept_r (restrictive layer depth) for
       backwards compatibility — it is used as the restrictive layer multiplier in scoring.
       The new `water_table_depth` is used exclusively for water table scoring.

  2. Backfill `ksat_r` for all rows where it is null but raw_ssurgo contains the value
     - Affects ~525 NC rows and all historical rows pre-dating the ksat_r column addition
     - Reads directly from the raw_ssurgo JSONB column so no data is lost
*/

-- Add water_table_depth column (true seasonal high water table, in inches)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'soil_results' AND column_name = 'water_table_depth'
  ) THEN
    ALTER TABLE soil_results ADD COLUMN water_table_depth numeric;
  END IF;
END $$;

-- Backfill ksat_r from raw_ssurgo for all rows where it is currently null
UPDATE soil_results
SET ksat_r = (raw_ssurgo->>'ksat_r')::numeric
WHERE ksat_r IS NULL
  AND raw_ssurgo->>'ksat_r' IS NOT NULL
  AND (raw_ssurgo->>'ksat_r')::numeric IS NOT NULL;
