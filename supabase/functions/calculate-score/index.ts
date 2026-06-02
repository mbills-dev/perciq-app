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
  // water_table_depth: seasonal high water table from cosoilmoist (soimoistdept_l where Wet), inches
  water_table_depth: number | null;
  // depth_water_table: restrictive layer depth (resdept_r), inches — kept for backwards compat
  depth_water_table: number | null;
  ksat_low: number | null;
  ksat_r: number | null;
  ksat_high: number | null;
  slope_low: number | null;
  slope_high: number | null;
  pct_coverage: number | null;
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
// Scoring helpers — conventional weights
// ---------------------------------------------------------------------------

const WEIGHTS_CONV = {
  nrcs: 0.35,
  ksat: 0.20,
  waterTable: 0.20,
  drainage: 0.10,
  slope: 0.08,
  // remaining 7% is the nearby_tests boost applied post-weighted-sum
};

function scoreNrcs(rating: string | null): { pts: number; note: string } {
  const r = (rating ?? "").toLowerCase();
  if (r.includes("not limited") || r.includes("slight")) {
    return { pts: 100, note: `NRCS septic suitability rating is "${rating}" — favorable for conventional drainfield installation` };
  }
  if (r.includes("somewhat limited") || r.includes("moderate")) {
    return { pts: 45, note: `NRCS septic suitability rating is "${rating}" — site may be installable with design modifications` };
  }
  if (r.includes("very limited") || r.includes("severe")) {
    return { pts: 5, note: `NRCS septic suitability rating is "${rating}" — significant soil limitations for conventional systems` };
  }
  return { pts: 50, note: `NRCS septic suitability rating is "${rating ?? "unknown"}" — insufficient data to classify` };
}

function scoreKsat(ksat: number | null, lenient = false): { pts: number; note: string } {
  if (ksat === null) {
    return { pts: 50, note: "Saturated hydraulic conductivity (Ksat) data not available — using neutral score" };
  }
  const lo = lenient ? ksat * 1.4 : ksat;
  let pts: number;
  let note: string;
  if (lo >= 1.0 && lo <= 6.0) {
    pts = 100;
    note = `Ksat is ${ksat.toFixed(2)} µm/s — ideal permeability range for conventional septic absorption`;
  } else if (lo >= 0.4 && lo < 1.0) {
    pts = 60;
    note = `Ksat is ${ksat.toFixed(2)} µm/s — slightly slow permeability; standard systems may require larger drainfield`;
  } else if (lo > 6.0 && lo <= 20.0) {
    pts = 40;
    note = `Ksat is ${ksat.toFixed(2)} µm/s — moderately fast permeability; effluent treatment may be reduced`;
  } else if (lo > 20.0 && lo <= 150.0) {
    // Coarse sandy soils (e.g. Candor sand, ~42–141 µm/s) fall here. These are approvable
    // in NC and similar states with pump dosing / pressure distribution — not unsuitable.
    pts = 25;
    note = `Ksat is ${ksat.toFixed(2)} µm/s — fast permeability (coarse sand); conventional gravity systems unlikely but pump/pressure-dosed systems are typically approvable`;
  } else if (lo < 0.4) {
    pts = 10;
    note = `Ksat is ${ksat.toFixed(2)} µm/s — very slow permeability; soil is likely clay-dominated and unsuitable for conventional drainfields`;
  } else {
    // > 150 µm/s — gravel/cobble, no treatment capacity
    pts = 10;
    note = `Ksat is ${ksat.toFixed(2)} µm/s — extremely fast permeability; inadequate effluent treatment, engineered system required`;
  }
  if (lenient && pts < 100) {
    pts = Math.min(100, pts + 20);
    note += " (alternative system threshold applied)";
  }
  return { pts, note };
}

function scoreWaterTable(depthIn: number | null, lenient = false): { pts: number; note: string } {
  if (depthIn === null) {
    return { pts: 50, note: "Depth to seasonal water table data not available — using neutral score" };
  }
  const threshold = lenient ? depthIn * 1.4 : depthIn;
  let pts: number;
  let note: string;
  if (threshold > 36) {
    pts = 100;
    note = `Depth to seasonal water table is ${depthIn.toFixed(0)} inches — well above the minimum for conventional systems`;
  } else if (threshold >= 24) {
    pts = 60;
    note = `Depth to seasonal water table is ${depthIn.toFixed(0)} inches — meets minimum requirements for conventional systems`;
  } else if (threshold >= 18) {
    pts = 25;
    note = `Depth to seasonal water table is ${depthIn.toFixed(0)} inches — below the 24-inch minimum for conventional systems in most states`;
  } else {
    pts = 5;
    note = `Depth to seasonal water table is ${depthIn.toFixed(0)} inches — too shallow for conventional drainfield installation`;
  }
  if (lenient && pts < 100) {
    pts = Math.min(100, pts + 20);
    note += " (mound/drip system threshold applied)";
  }
  return { pts, note };
}

function scoreDrainage(drainagecl: string | null): { pts: number; note: string } {
  const d = drainagecl ?? "";
  const map: Array<{ match: string; pts: number; note: string }> = [
    { match: "Excessively drained", pts: 60, note: `Soil drainage class is excessively drained — good infiltration but may lack treatment capacity` },
    { match: "Somewhat excessively drained", pts: 75, note: `Soil drainage class is somewhat excessively drained — generally suitable` },
    { match: "Well drained", pts: 100, note: `Soil drainage class is well drained — ideal for conventional septic systems` },
    { match: "Moderately well drained", pts: 70, note: `Soil drainage class is moderately well drained — adequate for most conventional systems` },
    { match: "Somewhat poorly drained", pts: 30, note: `Soil drainage class is somewhat poorly drained — seasonal saturation limits system options` },
    { match: "Poorly drained", pts: 5, note: `Soil drainage class is poorly drained — site likely requires elevated or alternative system` },
    { match: "Very poorly drained", pts: 5, note: `Soil drainage class is very poorly drained — unsuitable for in-ground conventional systems` },
  ];
  const hit = map.find((m) => d.toLowerCase().includes(m.match.toLowerCase()));
  return hit ?? { pts: 50, note: `Drainage class "${d || "unknown"}" could not be classified` };
}

function scoreSlope(slopeLow: number | null, slopeHigh: number | null): { pts: number; note: string } {
  const slopeR = slopeLow != null && slopeHigh != null
    ? (slopeLow + slopeHigh) / 2
    : slopeHigh ?? slopeLow;
  if (slopeR === null) {
    return { pts: 65, note: "Slope data not available — using neutral score" };
  }
  if (slopeR < 8) {
    return { pts: 100, note: `Average slope is ${slopeR.toFixed(1)}% — gentle terrain favorable for drainfield placement` };
  }
  if (slopeR <= 15) {
    return { pts: 65, note: `Average slope is ${slopeR.toFixed(1)}% — moderate slope; drainfield placement possible with proper engineering` };
  }
  if (slopeR <= 25) {
    return { pts: 25, note: `Average slope is ${slopeR.toFixed(1)}% — steep terrain; drainfield options are limited and costly` };
  }
  return { pts: 5, note: `Average slope is ${slopeR.toFixed(1)}% — excessive slope; conventional drainfield installation is not feasible` };
}

// ---------------------------------------------------------------------------
// Haversine distance in miles
// ---------------------------------------------------------------------------

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
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
  const hasVerifiedRules = countyRule?.last_updated != null; // treat having county rules as "verified"
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

  // Data completeness: check key fields
  const fields: Array<keyof SoilResult> = [
    "nrcs_septic_rating", "ksat_high", "water_table_depth", "drainage_class", "slope_high",
  ];
  const completeness = soilResults.reduce((acc, r) => {
    const present = fields.filter((f) => r[f] != null).length;
    return acc + present / fields.length;
  }, 0) / soilResults.length;

  // Tier base confidence
  const tierBase: Record<DataTier, number> = { 1: 35, 2: 55, 3: 70, 4: 90 };
  const base = tierBase[tier];

  // Nearby test contribution (up to +8 points)
  const nearbyBoost = Math.min(8, nearbyCount * 1.5);

  // Completeness modifier (±15 points)
  const completenessBoost = (completeness - 0.5) * 30; // -15 to +15

  return Math.round(Math.min(100, Math.max(5, base + nearbyBoost + completenessBoost)));
}

// ---------------------------------------------------------------------------
// Per-component scoring (weighted average across soil map units)
// ---------------------------------------------------------------------------

interface ComponentScore {
  mapUnitKey: string;
  mapUnitName: string;
  pctCoverage: number;
  conventionalPts: number;
  alternativePts: number;
  explanations: string[];
}

function scoreRestrictiveLayer(resdept_r: number | null, reskind: string | null): { multiplier: number; note: string } {
  const LIMITING = ['bedrock', 'paralithic', 'fragipan', 'duripan', 'cemented', 'ortstein', 'permafrost', 'densic'];
  const isLimiting = reskind != null && LIMITING.some(k => reskind.toLowerCase().includes(k));

  if (resdept_r == null) {
    if (isLimiting) return { multiplier: 0.85, note: `Restrictive layer (${reskind}) depth unknown — applying precautionary penalty` };
    return { multiplier: 1.0, note: "No restrictive layer recorded" };
  }
  if (resdept_r > 60) return { multiplier: 1.0, note: `Restrictive layer (${reskind ?? "unknown"}) at ${resdept_r.toFixed(0)} inches — deep enough for conventional drainfield` };
  if (resdept_r >= 36) return { multiplier: 0.80, note: `Restrictive layer (${reskind ?? "unknown"}) at ${resdept_r.toFixed(0)} inches — limits drainfield depth, engineered design likely required` };
  if (resdept_r >= 18) return { multiplier: 0.50, note: `Restrictive layer (${reskind ?? "unknown"}) at ${resdept_r.toFixed(0)} inches — severely limits conventional system options` };
  return { multiplier: 0.15, note: `Restrictive layer (${reskind ?? "unknown"}) at ${resdept_r.toFixed(0)} inches — drainfield installation not feasible` };
}

function scoreComponent(r: SoilResult, lenientAlt: boolean): ComponentScore {
  const explanations: string[] = [];

  const nrcs = scoreNrcs(r.nrcs_septic_rating);
  explanations.push(nrcs.note);

  // Use ksat_r (representative value) — correct field for scoring septic suitability.
  const ksatVal = r.ksat_r ?? r.ksat_high ?? r.ksat_low;
  const ksatConv = scoreKsat(ksatVal, false);
  const ksatAlt = scoreKsat(ksatVal, lenientAlt);
  explanations.push(ksatConv.note);

  // Use water_table_depth (true seasonal high water table from cosoilmoist).
  // Fall back to depth_water_table (resdept_r) only if water_table_depth is null,
  // since for soils with shallow bedrock the two often align.
  const wtDepth = r.water_table_depth ?? null;
  const wtConv = scoreWaterTable(wtDepth, false);
  const wtAlt = scoreWaterTable(wtDepth, lenientAlt);
  explanations.push(wtConv.note);

  const drain = scoreDrainage(r.drainage_class);
  explanations.push(drain.note);

  const slope = scoreSlope(r.slope_low, r.slope_high);
  explanations.push(slope.note);

  // Restrictive layer is a separate multiplier, not folded into water table score.
  const reskind = (r.raw_ssurgo?.reskind as string | null) ?? null;
  const restrictive = scoreRestrictiveLayer(r.depth_water_table, reskind);
  explanations.push(restrictive.note);

  const baseConv =
    nrcs.pts * WEIGHTS_CONV.nrcs +
    ksatConv.pts * WEIGHTS_CONV.ksat +
    wtConv.pts * WEIGHTS_CONV.waterTable +
    drain.pts * WEIGHTS_CONV.drainage +
    slope.pts * WEIGHTS_CONV.slope;

  const baseAlt =
    nrcs.pts * WEIGHTS_CONV.nrcs +
    ksatAlt.pts * WEIGHTS_CONV.ksat +
    wtAlt.pts * WEIGHTS_CONV.waterTable +
    drain.pts * WEIGHTS_CONV.drainage +
    slope.pts * WEIGHTS_CONV.slope;

  const convPts = baseConv * restrictive.multiplier;
  const altPts = baseAlt * (lenientAlt ? Math.min(1.0, restrictive.multiplier * 1.2) : restrictive.multiplier);

  return {
    mapUnitKey: r.map_unit_key ?? "unknown",
    mapUnitName: r.map_unit_name ?? "Unknown Map Unit",
    pctCoverage: r.pct_coverage ?? 0,
    conventionalPts: convPts,
    alternativePts: altPts,
    explanations,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // Auth
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

    // Verify user owns this report and fetch related parcel
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

    // Fetch soil results
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

    // Fetch county rules
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

    // Fetch nearby tests — get all in same county first, then filter by distance
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

    // Filter to matching map_unit_key within radius
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

    // Data depth tier
    const tier = computeDataTier(
      soilResults.length > 0,
      countyRule,
      nearbyMatching5mi,
      nearbyMatching3mi,
      currentYear
    );

    const countyName = parcel?.county ?? "this";
    const tierNote = dataTierNote(tier, countyName, nearbyMatching5mi.length);

    // Score each soil component
    const componentScores = soilResults.map((r) => scoreComponent(r, true));

    // Weighted average across components by pct_coverage
    const totalPct = componentScores.reduce((s, c) => s + c.pctCoverage, 0);

    let weightedConv: number;
    let weightedAlt: number;

    if (totalPct > 0) {
      weightedConv = componentScores.reduce((s, c) => s + c.conventionalPts * c.pctCoverage, 0) / totalPct;
      weightedAlt = componentScores.reduce((s, c) => s + c.alternativePts * c.pctCoverage, 0) / totalPct;
    } else {
      // Equal weight if no coverage data
      weightedConv = componentScores.reduce((s, c) => s + c.conventionalPts, 0) / componentScores.length;
      weightedAlt = componentScores.reduce((s, c) => s + c.alternativePts, 0) / componentScores.length;
    }

    // Nearby tests boost: +7 pts if 3+ passing tests within 1 mile on same map unit
    if (nearbyPassing1mi.length >= 3) {
      weightedConv = Math.min(100, weightedConv + 7);
      weightedAlt = Math.min(100, weightedAlt + 7);
    }

    // County rules modifier
    const countyExplanations: string[] = [];
    if (countyRule) {
      if (countyRule.min_lot_size_acres != null) {
        countyExplanations.push(
          `${countyName} County requires a minimum lot size of ${countyRule.min_lot_size_acres} acres for septic installation`
        );
      }
      if (countyRule.alt_systems_allowed === false) {
        weightedAlt = Math.min(weightedAlt, 30);
        countyExplanations.push(
          `${countyName} County does not permit alternative septic systems — alternative score capped`
        );
      } else if (countyRule.alt_systems_allowed === true) {
        countyExplanations.push(
          `${countyName} County permits alternative septic systems (mound, drip, aerobic)`
        );
      }
    }

    // Nearby tests explanation
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
        nearbyExplanations.push(
          `${recentCount} of those tests occurred within the last 7 years`
        );
      }
    } else {
      nearbyExplanations.push("No nearby perc test history found for matching soil types in this area");
    }

    if (nearbyPassing1mi.length >= 3) {
      nearbyExplanations.push(
        `${nearbyPassing1mi.length} passing perc tests within 1 mile on the same soil type — score boosted by 7 points`
      );
    }

    // Deduplicate explanations across components (keep unique)
    const seen = new Set<string>();
    const allExplanations: string[] = [];
    for (const comp of componentScores) {
      for (const exp of comp.explanations) {
        if (!seen.has(exp)) {
          seen.add(exp);
          allExplanations.push(exp);
        }
      }
    }

    const explanation = [...allExplanations, ...countyExplanations, ...nearbyExplanations];

    const conventionalScore = Math.round(Math.min(100, Math.max(0, weightedConv)));
    const alternativeScore = Math.round(Math.min(100, Math.max(0, weightedAlt)));
    const confidence = computeConfidence(soilResults, tier, nearbyMatching5mi.length);

    // Persist updated scores to report
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await serviceClient
      .from("reports")
      .update({
        conventional_score: conventionalScore,
        alternative_score: alternativeScore,
        confidence,
        status: "complete",
      })
      .eq("id", report_id);

    return new Response(
      JSON.stringify({
        report_id,
        conventional_score: conventionalScore,
        alternative_score: alternativeScore,
        confidence,
        data_depth_tier: tier,
        data_depth_note: tierNote,
        explanation,
        component_scores: componentScores.map((c) => ({
          map_unit_key: c.mapUnitKey,
          map_unit_name: c.mapUnitName,
          pct_coverage: c.pctCoverage,
          conventional_pts: Math.round(c.conventionalPts),
          alternative_pts: Math.round(c.alternativePts),
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
