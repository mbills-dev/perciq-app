/*
  # Add ksat_r column to soil_results

  Adds the representative saturated hydraulic conductivity value (ksat_r) from SSURGO
  to soil_results. Previously only ksat_low and ksat_high were stored; the scoring
  function was incorrectly using ksat_high (theoretical max) as the representative value.
  ksat_r is the correct field for scoring septic suitability.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'soil_results' AND column_name = 'ksat_r'
  ) THEN
    ALTER TABLE soil_results ADD COLUMN ksat_r numeric;
  END IF;
END $$;
