/*
  # Add has_parcel_boundary to county_rules

  Tracks whether a confirmed working GIS boundary source exists for each county.
  - true  = county GIS or NC OneMap returns real parcel polygons
  - false = falls back to approximate (FCC census block or bbox)
  - null  = not yet tested

  This column is updated automatically by the parcel lookup pipeline
  and helps prioritize manual GIS URL research for uncovered counties.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'county_rules' AND column_name = 'has_parcel_boundary'
  ) THEN
    ALTER TABLE county_rules ADD COLUMN has_parcel_boundary boolean DEFAULT null;
  END IF;
END $$;

-- Catawba County: confirmed approximate only (no working GIS source yet)
UPDATE county_rules
SET has_parcel_boundary = false
WHERE state = 'NC' AND county = 'Catawba';

-- Wake and Mecklenburg: have known GIS URLs in COUNTY_GIS_URLS table
UPDATE county_rules
SET has_parcel_boundary = true
WHERE state = 'NC' AND county IN ('Wake', 'Mecklenburg');
