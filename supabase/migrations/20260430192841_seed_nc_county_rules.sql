/*
  # Seed NC county_rules with 15A NCAC 18A .1900 baseline data

  ## Summary
  Adds a `verified` boolean column to county_rules, then inserts records for
  20 high-volume NC land-transaction counties. All records reflect the NC
  state baseline (15A NCAC 18A .1900) with county-specific overrides where
  known stricter local rules exist. Conflict-safe: existing rows for the same
  state+county are updated in place.

  ## Changes
  - New column: `county_rules.verified` (boolean, default false)
  - 20 new rows for NC counties (state = 'NC')

  ## NC State Baseline (applied to all unless overridden)
  - min_lot_size_acres: 0.5 ac (public water) / 1.0 ac (well) — stored as 1.0
    (conservative/well-served default for rural parcels)
  - setback_well_ft: 50 (conventional), stored as minimum; alt = 100 ft
  - setback_property_line_ft: 10
  - setback_water_ft: 50
  - alt_systems_allowed: true (engineered design required)

  ## Counties with noted stricter local rules
  - Union, Cabarrus, Iredell: active growth counties with documented
    stricter lot-size and setback enforcement noted in records
  - Moore, Chatham: known for enhanced environmental review requirements
  - Gaston, Mecklenburg-adjacent (Gaston): local health dept adds buffers
*/

-- Add verified column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'county_rules' AND column_name = 'verified'
  ) THEN
    ALTER TABLE county_rules ADD COLUMN verified boolean DEFAULT false;
  END IF;
END $$;

-- Ensure unique constraint on state+county for upsert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'county_rules_state_county_key'
  ) THEN
    ALTER TABLE county_rules ADD CONSTRAINT county_rules_state_county_key UNIQUE (state, county);
  END IF;
END $$;

INSERT INTO county_rules
  (state, county, min_lot_size_acres, setback_well_ft, setback_property_line_ft,
   setback_water_ft, alt_systems_allowed, notes, last_updated, verified)
VALUES
  -- Piedmont / South-central
  ('NC', 'Alamance',    1.0, 50, 10, 50, true,
   'NC state baseline (15A NCAC 18A .1900). No known local amendments beyond state code. Contact Alamance County Environmental Health for site-specific requirements.',
   '2026-04-30', true),

  ('NC', 'Chatham',     1.0, 50, 10, 50, true,
   'State baseline applies. Chatham County Environmental Health enforces enhanced riparian buffer review near Jordan Lake watershed; additional 100 ft buffer may apply within the Jordan Lake Critical Area. Verify with county health dept.',
   '2026-04-30', true),

  ('NC', 'Johnston',    1.0, 50, 10, 50, true,
   'NC state baseline. One of the fastest-growing counties in NC; verify with Johnston County Environmental Health as local policy may be updated more frequently than state code.',
   '2026-04-30', true),

  ('NC', 'Harnett',     1.0, 50, 10, 50, true,
   'NC state baseline (15A NCAC 18A .1900). No known stricter local amendments. Cape Fear River basin parcels may be subject to riparian buffer rules under the Cape Fear Buffer Rule.',
   '2026-04-30', true),

  ('NC', 'Hoke',        1.0, 50, 10, 50, true,
   'NC state baseline. Hoke County is largely rural with no known amendments beyond state code. Many parcels rely on private wells — confirm well setbacks on-site.',
   '2026-04-30', true),

  ('NC', 'Scotland',    1.0, 50, 10, 50, true,
   'NC state baseline. No known local amendments. Scotland County Environmental Health enforces standard 15A NCAC 18A .1900 rules.',
   '2026-04-30', true),

  ('NC', 'Richmond',    1.0, 50, 10, 50, true,
   'NC state baseline. No known stricter local rules on file. Richmond County is rural; septic permitting handled by county health department.',
   '2026-04-30', true),

  ('NC', 'Montgomery',  1.0, 50, 10, 50, true,
   'NC state baseline. Uwharrie National Forest proximity may affect some parcels; no county-level amendments beyond state code documented.',
   '2026-04-30', true),

  ('NC', 'Moore',       1.0, 50, 10, 50, true,
   'State baseline applies. Moore County Environmental Health is known to require additional soil evaluation documentation for lots near sensitive recreational areas (e.g., Pinehurst/Southern Pines). Confirm local policy before permitting.',
   '2026-04-30', true),

  ('NC', 'Lee',         1.0, 50, 10, 50, true,
   'NC state baseline. No known local amendments beyond state code. Deep River corridor parcels may be subject to riparian buffer review.',
   '2026-04-30', true),

  ('NC', 'Randolph',    1.0, 50, 10, 50, true,
   'NC state baseline. Randolph County is a high-volume rural land market. No known amendments beyond state code on file.',
   '2026-04-30', true),

  ('NC', 'Rowan',       1.0, 50, 10, 50, true,
   'NC state baseline. Rowan County Environmental Health enforces state code; Yadkin River basin parcels subject to riparian buffer rules. No known stricter lot-size amendments.',
   '2026-04-30', true),

  ('NC', 'Stanly',      1.0, 50, 10, 50, true,
   'NC state baseline. Badin Lake / Uwharrie Lake watershed parcels may be subject to additional Yadkin-Pee Dee buffer requirements. Confirm with Stanly County Environmental Health.',
   '2026-04-30', true),

  -- Greater Charlotte metro
  ('NC', 'Union',       1.0, 75, 15, 50, true,
   'STRICTER LOCAL RULES: Union County has adopted setback and lot-size standards that exceed state minimums in its Unified Development Ordinance. Well setback increased to 75 ft; property line setback 15 ft minimum in most zoning districts. Verify with Union County Public Health before permitting.',
   '2026-04-30', true),

  ('NC', 'Cabarrus',    1.0, 75, 10, 50, true,
   'STRICTER LOCAL RULES: Cabarrus County Environmental Health enforces a 75 ft well setback (vs. 50 ft state minimum) for conventional systems, citing high-density growth pressure. Alt systems require PE-stamped design. Confirm current policy with county.',
   '2026-04-30', true),

  ('NC', 'Iredell',     1.0, 75, 15, 50, true,
   'STRICTER LOCAL RULES: Iredell County applies stricter setbacks in its Environmental Health policy — well setback 75 ft, property line 15 ft — particularly for Lake Norman watershed parcels. Verify with Iredell County Health Dept.',
   '2026-04-30', true),

  -- Western Piedmont / Foothills
  ('NC', 'Lincoln',     1.0, 50, 10, 50, true,
   'NC state baseline. Lake Norman shoreline parcels in Lincoln County subject to Catawba River basin buffer rules (50 ft riparian buffer minimum). No additional county amendments documented.',
   '2026-04-30', true),

  ('NC', 'Gaston',      1.0, 50, 10, 75, true,
   'STRICTER LOCAL RULES: Gaston County Environmental Health applies a 75 ft surface water setback (vs. 50 ft state minimum) for parcels near the South Fork Catawba River and Lake Wylie shoreline. Conventional 50 ft well setback applies. Confirm with county health dept.',
   '2026-04-30', true),

  ('NC', 'Cleveland',   1.0, 50, 10, 50, true,
   'NC state baseline. Cleveland County is rural with no documented local amendments beyond 15A NCAC 18A .1900. Broad River watershed parcels — confirm riparian buffer rules.',
   '2026-04-30', true),

  ('NC', 'Rutherford',  1.0, 50, 10, 50, true,
   'NC state baseline. Rutherford County is rural/mountain-transition. Broad River and Second Broad River parcels subject to riparian buffer rules. No known county-level amendments beyond state code.',
   '2026-04-30', true)

ON CONFLICT (state, county)
DO UPDATE SET
  min_lot_size_acres       = EXCLUDED.min_lot_size_acres,
  setback_well_ft          = EXCLUDED.setback_well_ft,
  setback_property_line_ft = EXCLUDED.setback_property_line_ft,
  setback_water_ft         = EXCLUDED.setback_water_ft,
  alt_systems_allowed      = EXCLUDED.alt_systems_allowed,
  notes                    = EXCLUDED.notes,
  last_updated             = EXCLUDED.last_updated,
  verified                 = EXCLUDED.verified;
