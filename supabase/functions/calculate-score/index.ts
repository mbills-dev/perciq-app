import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SoilResult {
  id: string;
  report_id: string;
  map_unit_key: string | null;
  map_unit_name: string | null;
  texture_class: string | null;
  drainage_class: string | null;
  perc_class: string | null;
  nrcs_septic_rating: string | null;
  // water_table_depth: seasonal high water table from cosoilmoist (soimoistdept_l where Wet), INCHES
  water_table_depth: number | null;
  // depth_water_table: resdept_r (restrictive layer depth) from corestrictions, CM — backwards compat
  depth_water_table: number | null;
  ksat_low: number | null;
  ksat_r: number | null;
  ksat_high: number | null;
  slope_low: number | null;
  slope_high: number | null;
  pct_coverage: number | null;
  // clay40_depth_cm: shallowest horizon (cm) where clay>=35% AND ksat<1.0 — proxy restrictive layer
  clay40_depth_cm: number | null;
  max_clay_pct: number | null;
  raw_ssurgo: Record<string, unknown> | null;
}

interface CountyRule {
  id: string;
  state: string | null;
  county: string | null;
  min_lot_size_acres: number | null;
  setback_well_ft: number | null;
  setback_property_line_ft: number | null;
  setback_water_ft: number | null;
  alt_systems_allowed: boolean | null;
  notes: string | null;
  last_updated: string | null;
}

interface NearbyTest {
  id: string;
  county: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  outcome: string | null;
  system_type: string | null;
  map_unit_key: string | null;
  test_year: number | null;
  source: string | null;
  verified: boolean | null;
}

interface Report {
  id: string;
  user_id: string;
  parcel_id: string;
  status: string;
  parcels: {
    id: string;
    lat: number | null;
    lng: number | null;
    state: string | null;
    county: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Gating ceiling constants — exact mirror of ReportDetail.tsx GATE_CEIL.
// Spatial gates (FEMA flood, NWI wetland) require polygon geometry and are
// computed by the frontend only; this engine uses tabular SSURGO data only.
// ---------------------------------------------------------------------------

const GATE_CEIL = {
  WATER_TABLE_VERY_SHALLOW: 39,  // water table < 18 in
  WATER_TABLE_SHALLOW:      55,  // water table [18, 24) in
  WATER_TABLE_MODERATE:     64,  // water table [24, 36) in
  BEDROCK_SHALLOW:          39,  // lithic/paralithic/cemented bedrock < 20 in (< 50.8 cm)
  CLAY_SHALLOW:             50,  // clay or non-bedrock restriction < 20 in
  RESTRICTION_MODERATE:     64,  // any restriction [20, 36) in (50.8–91.44 cm)
  FLOODING_FREQUENT:        39,  // SSURGO flodfreqcl "frequent" / "very frequent"
  KSAT_EXTREME:             39,  // ksat < 0.4 or > 150 µm/s
  SLOPE_SEVERE:             39,  // slope > 30%
  SLOPE_STEEP:              64,  // slope [15, 30]%
} as const;

// ---------------------------------------------------------------------------
// Factor scores — exact mirror of ReportDetail.tsx scoreSoilPolygon factors.
// Weights: drainage 35%, ksat 25%, slope 20%, water table 20%.
// ---------------------------------------------------------------------------

function drainageFactor(drainagecl: string | null): number {
  const d = (drainagecl ?? '').toLowerCase();
  if (d.includes('well drained') && !d.includes('somewhat') && !d.includes('moderately')) return 90;
  if (d.includes('moderately well')) return 75;
  if (d.includes('somewhat excessively')) return 75;
  if (d.includes('excessively') && !d.includes('somewhat')) return 65;
  if (d.includes('somewhat poorly')) return 35;
  if (d.includes('very poorly')) return 0;
  if (d.includes('poorly') && !d.includes('somewhat')) return 10;
  if (d.includes('subaqueous')) return 0;
  return 50;
}

function ksatFactor(ksat: number | null): number {
  if (ksat === null) return 55;                  // neutral when unknown
  if (ksat < 0.4)   return 10;                  // >1000 mpi — clay, won't drain
  if (ksat < 4)     return 35;                  // 100–1000 mpi — conventional likely fails
  if (ksat < 7)     return 60;                  // 60–100 mpi — borderline, design-dependent
  if (ksat <= 30)   return 90;                  // 15–60 mpi — IDEAL conventional range
  if (ksat <= 80)   return 70;                  // 5–15 mpi — moderate-fast, treatment OK
  if (ksat <= 150)  return 45;                  // 3–5 mpi — fast, treatment concerns
  return 10;                                    // <3 mpi — gravel, no treatment capacity
}

// water_table_depth is in INCHES (converted at soil-query storage time)
function waterTableFactor(depthIn: number | null, drainagecl: string | null): number {
  if (depthIn === null) {
    const d = (drainagecl ?? '').toLowerCase();
    return d.includes('excessively drained') ? 85 : 55;
  }
  if (depthIn >= 47) return 95;  // >= 47 in  (~120 cm)
  if (depthIn >= 35) return 80;  // 35–47 in
  if (depthIn >= 24) return 60;  // 24–35 in — meets minimum
  if (depthIn >= 12) return 30;  // 12–24 in — limiting
  return 5;                      // < 12 in — very shallow
}

// slope_high is in percent
function slopeFactor(slopeHigh: number | null): number {
  if (slopeHigh === null) return 60;
  if (slopeHigh <= 3) return 95;
  if (slopeHigh <= 8) return 85;
  if (slopeHigh <= 15) return 60;
  if (slopeHigh <= 25) return 30;
  if (slopeHigh <= 30) return 10;
  return 0;
}

// ---------------------------------------------------------------------------
// NRCS supplementary gates
// NRCS text can only ADD a gate for a condition where the corresponding
// measured SSURGO field is null — it never overrides a measured gate.
// ---------------------------------------------------------------------------

function nrcsSupplementalGates(
  rating: string | null,
  hasWaterTable: boolean,
  hasFloodFreq: boolean,
  hasKsat: boolean,
): { firedGates: string[]; ceiling: number } {
  const text = (rating ?? '').toLowerCase();
  let ceiling = 100;
  const firedGates: string[] = [];

  if (!hasFloodFreq && (text.includes('flood') || text.includes('ponding'))) {
    ceiling = Math.min(ceiling, GATE_CEIL.FLOODING_FREQUENT);
    firedGates.push(`nrcs:flooding→${GATE_CEIL.FLOODING_FREQUENT}`);
  }
  if (!hasWaterTable && (
    text.includes('water table') || text.includes('wetness') ||
    text.includes('seasonal') || text.includes('saturated zone')
  )) {
    // Depth unknown from text alone — apply 18-24in band as conservative default
    ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_SHALLOW);
    firedGates.push(`nrcs:watertable→${GATE_CEIL.WATER_TABLE_SHALLOW}`);
  }
  if (!hasKsat && (
    text.includes('permeability') || text.includes('too rapid') ||
    text.includes('too slow') || text.includes('very slow') || text.includes('very rapid')
  )) {
    ceiling = Math.min(ceiling, GATE_CEIL.KSAT_EXTREME);
    firedGates.push(`nrcs:ksat→${GATE_CEIL.KSAT_EXTREME}`);
  }

  return { firedGates, ceiling };
}

// ---------------------------------------------------------------------------
// Per-unit gated scoring
// ---------------------------------------------------------------------------

interface GatedScore {
  mapUnitKey: string;
  mapUnitName: string;
  pctCoverage: number;
  qualityComposite: number;
  ceiling: number;
  finalSI: number;
  firedGates: string[];
}

const BEDROCK_KINDS = [
  'bedrock', 'lithic', 'paralithic', 'fragipan',
  'duripan', 'cemented', 'ortstein', 'permafrost',
];

function scoreSoilUnit(r: SoilResult, nearbyBoost: number): GatedScore {
  // ── Quality composite (4 factors, same weights as frontend) ──
  const ksatVal = r.ksat_r ?? r.ksat_high ?? r.ksat_low ?? null;
  const ds = drainageFactor(r.drainage_class);
  const ks = ksatFactor(ksatVal);
  const ss = slopeFactor(r.slope_high);
  const wt = waterTableFactor(r.water_table_depth, r.drainage_class);
  const qualityComposite = ds * 0.35 + ks * 0.25 + ss * 0.20 + wt * 0.20;

  // ── Gating ceiling ──
  let ceiling = 100;
  const firedGates: string[] = [];

  // Water table — water_table_depth in INCHES
  const wtDepth = r.water_table_depth;
  if (wtDepth !== null) {
    if (wtDepth < 18) {
      ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_VERY_SHALLOW);
      firedGates.push(`wt<18in→${GATE_CEIL.WATER_TABLE_VERY_SHALLOW}`);
    } else if (wtDepth < 24) {
      ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_SHALLOW);
      firedGates.push(`wt18-24in→${GATE_CEIL.WATER_TABLE_SHALLOW}`);
    } else if (wtDepth < 36) {
      ceiling = Math.min(ceiling, GATE_CEIL.WATER_TABLE_MODERATE);
      firedGates.push(`wt24-36in→${GATE_CEIL.WATER_TABLE_MODERATE}`);
    }
  }

  // Restriction depth — depth_water_table (resdept_r) in CM; clay40_depth_cm in CM
  const reskind = (r.raw_ssurgo?.reskind as string | null) ?? null;
  const isBedrock = reskind !== null && BEDROCK_KINDS.some(k => reskind.toLowerCase().includes(k));
  const effectiveResdeptCm =
    r.depth_water_table != null && !isNaN(r.depth_water_table)
      ? r.depth_water_table
      : r.clay40_depth_cm ?? null;

  if (effectiveResdeptCm !== null && !isNaN(effectiveResdeptCm)) {
    if (effectiveResdeptCm < 50.8) {  // < 20 in
      const cap = isBedrock ? GATE_CEIL.BEDROCK_SHALLOW : GATE_CEIL.CLAY_SHALLOW;
      ceiling = Math.min(ceiling, cap);
      firedGates.push(`restr<20in(${isBedrock ? 'bedrock' : 'clay'})→${cap}`);
    } else if (effectiveResdeptCm < 91.44) {  // 20–36 in
      ceiling = Math.min(ceiling, GATE_CEIL.RESTRICTION_MODERATE);
      firedGates.push(`restr20-36in→${GATE_CEIL.RESTRICTION_MODERATE}`);
    }
  }

  // SSURGO flooding frequency
  const flodfreqcl = (r.raw_ssurgo?.flodfreqcl as string | null) ?? null;
  if (flodfreqcl !== null) {
    const f = flodfreqcl.toLowerCase();
    if (f === 'frequent' || f === 'very frequent') {
      ceiling = Math.min(ceiling, GATE_CEIL.FLOODING_FREQUENT);
      firedGates.push(`flodfreq→${GATE_CEIL.FLOODING_FREQUENT}`);
    }
  }

  // ksat extreme
  if (ksatVal !== null && (ksatVal < 0.4 || ksatVal > 150)) {
    ceiling = Math.min(ceiling, GATE_CEIL.KSAT_EXTREME);
    firedGates.push(`ksat_extreme→${GATE_CEIL.KSAT_EXTREME}`);
  }

  // Slope — slope_high in percent
  const slope = r.slope_high;
  if (slope !== null) {
    if (slope > 30) {
      ceiling = Math.min(ceiling, GATE_CEIL.SLOPE_SEVERE);
      firedGates.push(`slope>30%→${GATE_CEIL.SLOPE_SEVERE}`);
    } else if (slope >= 15) {
      ceiling = Math.min(ceiling, GATE_CEIL.SLOPE_STEEP);
      firedGates.push(`slope15-30%→${GATE_CEIL.SLOPE_STEEP}`);
    }
  }

  // NRCS supplemental gates (only for conditions with no measured data)
  const nrcs = nrcsSupplementalGates(
    r.nrcs_septic_rating,
    wtDepth !== null,      // hasWaterTable
    flodfreqcl !== null,   // hasFloodFreq
    ksatVal !== null,      // hasKsat
  );
  if (nrcs.ceiling < 100) {
    ceiling = Math.min(ceiling, nrcs.ceiling);
    firedGates.push(...nrcs.firedGates);
  }

  // Nearby boost is applied to composite before ceiling clamp
  const finalSI = Math.round(Math.min(qualityComposite + nearbyBoost, ceiling));

  console.log(
    `[edge-score] mukey:${r.map_unit_key} quality_composite:${qualityComposite.toFixed(1)}` +
    ` ceiling:${ceiling} gates:${firedGates.length ? firedGates.join(' ') : 'none'}` +
    ` nrcs_features:${r.nrcs_septic_rating ?? 'none'} final_SI:${finalSI}`
  );

  return {
    mapUnitKey: r.map_unit_key ?? 'unknown',
    mapUnitName: r.map_unit_name ?? 'Unknown Map Unit',
    pctCoverage: r.pct_coverage ?? 0,
    qualityComposite: Math.round(qualityComposite),
    ceiling,
    finalSI,
    firedGates,
  };
}

// ---------------------------------------------------------------------------
// Haversine distance in miles
// ---------------------------------------------------------------------------

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Data depth tier
// ---------------------------------------------------------------------------

type DataTier = 1 | 2 | 3 | 4;

function computeDataTier(
  hasSsurgo: boolean,
  countyRule: CountyRule | null,
  nearbyMatching5mi: NearbyTest[],
  nearbyMatching3mi: NearbyTest[],
  currentYear: number,
): DataTier {
  if (!hasSsurgo) return 1;
  const hasVerifiedRules = countyRule?.last_updated != null;
  if (!hasVerifiedRules) return 1;

  const recent3mi = nearbyMatching3mi.filter(
    (t) => t.test_year != null && t.test_year >= currentYear - 7
  );
  if (recent3mi.length >= 5) return 4;
  if (nearbyMatching5mi.length >= 1) return 3;
  return 2;
}

function dataTierNote(tier: DataTier, county: string, nearbyCount: number): string {
  switch (tier) {
    case 1:
      return `Score based on USDA soil survey data only. No local perc test history available for ${county} County yet. This is a directional pre-screen — not a substitute for a site evaluation.`;
    case 2:
      return `Score includes verified ${county} County environmental health rules. No local test history available yet.`;
    case 3:
      return `Score includes soil data, county rules, and ${nearbyCount} nearby test result${nearbyCount !== 1 ? "s" : ""}. Confidence is moderate — more local data would strengthen this score.`;
    case 4:
      return `Score includes soil data, verified county rules, and ${nearbyCount} nearby test results on matching soil types. This is our highest-confidence rating.`;
  }
}

// ---------------------------------------------------------------------------
// Confidence score
// ---------------------------------------------------------------------------

function computeConfidence(
  soilResults: SoilResult[],
  tier: DataTier,
  nearbyCount: number,
): number {
  if (soilResults.length === 0) return 0;

  const fields: Array<keyof SoilResult> = [
    "nrcs_septic_rating", "ksat_high", "water_table_depth", "drainage_class", "slope_high",
  ];
  const completeness = soilResults.reduce((acc, r) => {
    const present = fields.filter((f) => r[f] != null).length;
    return acc + present / fields.length;
  }, 0) / soilResults.length;

  const tierBase: Record<DataTier, number> = { 1: 35, 2: 55, 3: 70, 4: 90 };
  const base = tierBase[tier];
  const nearbyBoost = Math.min(8, nearbyCount * 1.5);
  const completenessBoost = (completeness - 0.5) * 30;

  return Math.round(Math.min(100, Math.max(5, base + nearbyBoost + completenessBoost)));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json() as { report_id: string };
    if (!body.report_id) {
      return new Response(JSON.stringify({ error: "report_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { report_id } = body;

    const { data: report, error: reportErr } = await supabaseClient
      .from("reports")
      .select("id, user_id, parcel_id, status, parcels(id, lat, lng, state, county)")
      .eq("id", report_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (reportErr || !report) {
      return new Response(JSON.stringify({ error: "Report not found or access denied" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const typedReport = report as unknown as Report;

    const { data: soilRows } = await supabaseClient
      .from("soil_results")
      .select("*")
      .eq("report_id", report_id);

    const soilResults: SoilResult[] = (soilRows as SoilResult[]) ?? [];

    if (soilResults.length === 0) {
      return new Response(
        JSON.stringify({ error: "No soil results found for this report. Run soil analysis first." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parcel = typedReport.parcels;
    let countyRule: CountyRule | null = null;
    if (parcel?.state && parcel?.county) {
      const { data: rule } = await supabaseClient
        .from("county_rules")
        .select("*")
        .eq("state", parcel.state)
        .eq("county", parcel.county)
        .maybeSingle();
      countyRule = (rule as CountyRule | null);
    }

    const mapUnitKeys = [...new Set(soilResults.map((r) => r.map_unit_key).filter(Boolean))];
    let allNearby: NearbyTest[] = [];
    if (parcel?.state && parcel?.county) {
      const { data: nearby } = await supabaseClient
        .from("nearby_tests")
        .select("*")
        .eq("state", parcel.state)
        .eq("county", parcel.county);
      allNearby = (nearby as NearbyTest[]) ?? [];
    }

    const parcelLat = parcel?.lat;
    const parcelLng = parcel?.lng;

    const nearbyMatching5mi = allNearby.filter((t) => {
      if (!mapUnitKeys.includes(t.map_unit_key)) return false;
      if (parcelLat == null || parcelLng == null || t.lat == null || t.lng == null) return false;
      return haversineDistance(parcelLat, parcelLng, t.lat, t.lng) <= 5;
    });

    const nearbyMatching3mi = allNearby.filter((t) => {
      if (!mapUnitKeys.includes(t.map_unit_key)) return false;
      if (parcelLat == null || parcelLng == null || t.lat == null || t.lng == null) return false;
      return haversineDistance(parcelLat, parcelLng, t.lat, t.lng) <= 3;
    });

    const nearbyPassing1mi = allNearby.filter((t) => {
      if (!mapUnitKeys.includes(t.map_unit_key)) return false;
      if (t.outcome?.toLowerCase() !== "pass") return false;
      if (parcelLat == null || parcelLng == null || t.lat == null || t.lng == null) return false;
      return haversineDistance(parcelLat, parcelLng, t.lat, t.lng) <= 1;
    });

    const currentYear = new Date().getFullYear();

    const tier = computeDataTier(
      soilResults.length > 0,
      countyRule,
      nearbyMatching5mi,
      nearbyMatching3mi,
      currentYear
    );

    const countyName = parcel?.county ?? "this";
    const tierNote = dataTierNote(tier, countyName, nearbyMatching5mi.length);

    // Nearby boost: +7 pts if 3+ passing tests within 1 mile on same map unit.
    // Applied as a boost to quality_composite BEFORE ceiling clamp (still bounded by gate).
    const nearbyBoostPts = nearbyPassing1mi.length >= 3 ? 7 : 0;

    // Score each soil map unit with the gated model
    const unitScores = soilResults.map((r) => scoreSoilUnit(r, nearbyBoostPts));

    // Coverage-weighted average of final_SI across all map units (parcel-level score)
    const totalPct = unitScores.reduce((s, u) => s + u.pctCoverage, 0);
    let weightedFinalSI: number;

    if (totalPct > 0) {
      weightedFinalSI = unitScores.reduce((s, u) => s + u.finalSI * u.pctCoverage, 0) / totalPct;
    } else {
      weightedFinalSI = unitScores.reduce((s, u) => s + u.finalSI, 0) / unitScores.length;
    }

    // County rules: cap alternative systems if county disallows them
    const countyExplanations: string[] = [];
    if (countyRule) {
      if (countyRule.min_lot_size_acres != null) {
        countyExplanations.push(
          `${countyName} County requires a minimum lot size of ${countyRule.min_lot_size_acres} acres for septic installation`
        );
      }
      if (countyRule.alt_systems_allowed === false) {
        countyExplanations.push(
          `${countyName} County does not permit alternative septic systems`
        );
      } else if (countyRule.alt_systems_allowed === true) {
        countyExplanations.push(
          `${countyName} County permits alternative septic systems (mound, drip, aerobic)`
        );
      }
    }

    const nearbyExplanations: string[] = [];
    if (nearbyMatching5mi.length > 0) {
      const passingCount = nearbyMatching5mi.filter((t) => t.outcome?.toLowerCase() === "pass").length;
      const failingCount = nearbyMatching5mi.filter((t) => t.outcome?.toLowerCase() === "fail").length;
      const recentCount = nearbyMatching5mi.filter(
        (t) => t.test_year != null && t.test_year >= currentYear - 7
      ).length;
      if (passingCount > 0) {
        nearbyExplanations.push(
          `${passingCount} nearby parcel${passingCount !== 1 ? "s" : ""} with the same soil type passed perc tests within 5 miles`
        );
      }
      if (failingCount > 0) {
        nearbyExplanations.push(
          `${failingCount} nearby parcel${failingCount !== 1 ? "s" : ""} with the same soil type failed perc tests within 5 miles`
        );
      }
      if (recentCount > 0) {
        nearbyExplanations.push(`${recentCount} of those tests occurred within the last 7 years`);
      }
    } else {
      nearbyExplanations.push("No nearby perc test history found for matching soil types in this area");
    }

    if (nearbyPassing1mi.length >= 3) {
      nearbyExplanations.push(
        `${nearbyPassing1mi.length} passing perc tests within 1 mile on the same soil type — score boosted by 7 points`
      );
    }

    const finalScore = Math.round(Math.min(100, Math.max(0, weightedFinalSI)));
    const confidence = computeConfidence(soilResults, tier, nearbyMatching5mi.length);

    console.log(
      `[edge-score] parcel weighted final_SI:${finalScore}` +
      ` (units:${unitScores.length} nearby_boost:${nearbyBoostPts})`
    );

    // Store gated score as conventional_score (single engine — no divergent alt path).
    // alternative_score mirrors conventional for backwards compat with ReportsPage display.
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await serviceClient
      .from("reports")
      .update({
        conventional_score: finalScore,
        alternative_score: finalScore,
        confidence,
        status: "complete",
      })
      .eq("id", report_id);

    return new Response(
      JSON.stringify({
        report_id,
        conventional_score: finalScore,
        alternative_score: finalScore,
        final_si: finalScore,
        confidence,
        data_depth_tier: tier,
        data_depth_note: tierNote,
        explanation: [...countyExplanations, ...nearbyExplanations],
        component_scores: unitScores.map((u) => ({
          map_unit_key: u.mapUnitKey,
          map_unit_name: u.mapUnitName,
          pct_coverage: u.pctCoverage,
          quality_composite: u.qualityComposite,
          ceiling: u.ceiling,
          final_si: u.finalSI,
          fired_gates: u.firedGates,
          // backwards-compat aliases
          conventional_pts: u.finalSI,
          alternative_pts: u.finalSI,
        })),
        nearby_tests_summary: {
          matching_within_5mi: nearbyMatching5mi.length,
          matching_within_3mi: nearbyMatching3mi.length,
          passing_within_1mi: nearbyPassing1mi.length,
        },
        county_rules_applied: countyRule != null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("calculate-score error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
