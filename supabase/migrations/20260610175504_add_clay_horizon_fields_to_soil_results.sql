ALTER TABLE soil_results
  ADD COLUMN IF NOT EXISTS clay40_depth_cm integer,
  ADD COLUMN IF NOT EXISTS max_clay_pct numeric;

COMMENT ON COLUMN soil_results.clay40_depth_cm IS 'Shallowest horizon depth (cm) where claytotal_r >= 35 AND ksat_r < 1.0, within top 150 cm. Proxy restrictive layer when corestrictions.resdept_r is null.';
COMMENT ON COLUMN soil_results.max_clay_pct IS 'Maximum claytotal_r (%) across all horizons within top 150 cm.';
