import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// SDA requires POST with application/x-www-form-urlencoded
const SDA_URL = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Compute approximate polygon area (shoelace formula) for ring selection.
function ringArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

// Thin a coordinate ring to at most maxPts points using uniform stride sampling.
// Always keeps the first and last point (which must be identical for a closed ring).
function thinRing(ring: number[][], maxPts: number): number[][] {
  if (ring.length <= maxPts) return ring;
  const step = (ring.length - 1) / (maxPts - 1);
  const result: number[][] = [];
  for (let i = 0; i < maxPts - 1; i++) {
    result.push(ring[Math.round(i * step)]);
  }
  result.push(ring[ring.length - 1]); // close the ring
  return result;
}

const MAX_WKT_COORDS = 150; // SDA reliably handles polygons under ~150 vertices

// Compute bounding box WKT from any GeoJSON geometry — always valid for SDA.
function geojsonToBboxWkt(geojson: Record<string, unknown>): string {
  const geo = (geojson?.type === "Feature"
    ? (geojson.geometry as Record<string, unknown>)
    : geojson) ?? {};
  const type = geo.type as string;

  let allCoords: number[][];
  if (type === "Point") {
    const [lng, lat] = geo.coordinates as number[];
    const d = 0.002;
    return `POLYGON((${lng - d} ${lat - d}, ${lng + d} ${lat - d}, ${lng + d} ${lat + d}, ${lng - d} ${lat + d}, ${lng - d} ${lat - d}))`;
  } else if (type === "Polygon") {
    allCoords = (geo.coordinates as number[][][]).flat();
  } else if (type === "MultiPolygon") {
    allCoords = (geo.coordinates as number[][][][]).flat(2);
  } else {
    throw new Error(`Cannot compute bbox for type: ${type}`);
  }

  const lngs = allCoords.map(c => c[0]);
  const lats = allCoords.map(c => c[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  return `POLYGON((${minLng} ${minLat}, ${maxLng} ${minLat}, ${maxLng} ${maxLat}, ${minLng} ${maxLat}, ${minLng} ${minLat}))`;
}

function geojsonToWkt(geojson: Record<string, unknown>): string {
  // Unwrap Feature wrapper
  const geo = (geojson?.type === "Feature"
    ? (geojson.geometry as Record<string, unknown>)
    : geojson) ?? {};

  const type = geo.type as string;
  if (!type) throw new Error("No geometry type");

  // Point stored from a bad previous run — convert to bbox polygon
  if (type === "Point") {
    const [pLng, pLat] = geo.coordinates as [number, number];
    const d = 0.002;
    return `POLYGON((${pLng - d} ${pLat - d}, ${pLng + d} ${pLat - d}, ${pLng + d} ${pLat + d}, ${pLng - d} ${pLat + d}, ${pLng - d} ${pLat - d}))`;
  }

  let outerRing: number[][];

  if (type === "Polygon") {
    outerRing = (geo.coordinates as number[][][])[0];
  } else if (type === "MultiPolygon") {
    // Pick the largest sub-polygon by shoelace area so we query the right piece
    const rings = (geo.coordinates as number[][][][]).map(poly => poly[0]);
    outerRing = rings.reduce((best, cur) =>
      ringArea(cur) > ringArea(best) ? cur : best
    );
    console.log("[soil-query] MultiPolygon — picked largest ring of", rings.length, "sub-polygons, coords:", outerRing.length);
  } else {
    throw new Error(`Unsupported GeoJSON type: ${type}`);
  }

  // Thin the ring if it exceeds SDA's reliable vertex limit
  if (outerRing.length > MAX_WKT_COORDS) {
    const before = outerRing.length;
    outerRing = thinRing(outerRing, MAX_WKT_COORDS);
    console.log("[soil-query] thinned ring from", before, "to", outerRing.length, "coords for SDA");
  }

  const coords = outerRing.map((pt) => `${pt[0]} ${pt[1]}`).join(", ");
  return `POLYGON((${coords}))`;
}

interface SDARow {
  mukey: string;
  muname: string;
  musym: string;
  cokey: string;
  majcompflag: string;
  comppct_r: number | null;
  drainagecl: string | null;
  slope_l: number | null;
  slope_h: number | null;
  septic_rating: string | null;
  texture_l: string | null;
  ksat_l: number | null;
  ksat_r: number | null;
  ksat_h: number | null;
  resdept_r: number | null;
  reskind: string | null;
  pondfreqcl: string | null;
  flodfreqcl: string | null;
  // Seasonal high water table: minimum soimoistdept_l (cm) across months where soimoiststat='Wet'
  water_table_cm: number | null;
}

function parseTable(sdaJson: Record<string, unknown>, hasRating: boolean): SDARow[] {
  const table = (sdaJson as { Table?: unknown[][] }).Table;
  if (!table || table.length < 2) return [];

  const headers = table[0] as string[];
  const idx = (name: string) => headers.indexOf(name);

  const toNum = (v: unknown): number | null => {
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
  };
  const toStr = (v: unknown): string | null =>
    v == null || v === "" ? null : String(v);

  const iMukey       = idx("mukey");
  const iMuname      = idx("muname");
  const iMusym       = idx("musym");
  const iCokey       = idx("cokey");
  const iMajcomp     = idx("majcompflag");
  const iComppct     = idx("comppct_r");
  const iDrain       = idx("drainagecl");
  const iSlopeL      = idx("slope_l");
  const iSlopeH      = idx("slope_h");
  const iRating      = hasRating ? idx("septic_rating") : -1;
  const iTexture     = idx("texture_l");
  const iKsatL       = idx("ksat_l");
  const iKsatR       = idx("ksat_r");
  const iKsatH       = idx("ksat_h");
  const iResdept     = idx("resdept_r");
  const iReskind     = idx("reskind");
  const iPondfreq    = idx("pondfreqcl");
  const iFlodfreq    = idx("flodfreqcl");
  const iWaterTable  = idx("water_table_cm");

  return table.slice(1).map((row) => ({
    mukey:          String(row[iMukey]),
    muname:         toStr(row[iMuname]) ?? "",
    musym:          toStr(row[iMusym]) ?? "",
    cokey:          String(row[iCokey]),
    majcompflag:    String(row[iMajcomp]),
    comppct_r:      toNum(row[iComppct]),
    drainagecl:     toStr(row[iDrain]),
    slope_l:        toNum(row[iSlopeL]),
    slope_h:        toNum(row[iSlopeH]),
    septic_rating:  iRating >= 0 ? toStr(row[iRating]) : null,
    texture_l:      toStr(row[iTexture]),
    ksat_l:         toNum(row[iKsatL]),
    ksat_r:         toNum(row[iKsatR]),
    ksat_h:         toNum(row[iKsatH]),
    resdept_r:      toNum(row[iResdept]),
    reskind:        iReskind >= 0 ? toStr(row[iReskind]) : null,
    pondfreqcl:     iPondfreq >= 0 ? toStr(row[iPondfreq]) : null,
    flodfreqcl:     iFlodfreq >= 0 ? toStr(row[iFlodfreq]) : null,
    water_table_cm: iWaterTable >= 0 ? toNum(row[iWaterTable]) : null,
  }));
}

function derivePercClass(ksat_r: number | null): string | null {
  if (ksat_r === null) return null;
  if (ksat_r >= 14.1) return "Rapid";
  if (ksat_r >= 4.23) return "Moderately Rapid";
  if (ksat_r >= 1.41) return "Moderate";
  if (ksat_r >= 0.42) return "Moderately Slow";
  if (ksat_r >= 0.14) return "Slow";
  return "Very Slow";
}

function wktPolygonToGeojson(wkt: string): Record<string, unknown> | null {
  try {
    const inner = wkt.replace(/^MULTIPOLYGON\s*\(\(\(/, "").replace(/^POLYGON\s*\(\(/, "").replace(/\)\)$/, "").replace(/\)\).*$/, "");
    const coords = inner.split(",").map((pair) => {
      const [lng, lat] = pair.trim().split(/\s+/).map(Number);
      return [lng, lat];
    });
    return { type: "Polygon", coordinates: [coords] };
  } catch {
    return null;
  }
}

// POST to SDA.
// Seasonal high water table: minimum soimoistdept_l (cm) across cosoilmoist records
// where soimoiststat = 'Wet' — this is the correct SSURGO source for water table depth.
// flodfreqcl and pondfreqcl live in comonth (not component), so we use correlated
// subqueries to get the worst-case value per component across all months.
// NRCS septic interp: 'ENG - Septic Tank Absorption Fields' is the current live name
// in SDA (verified 2026-06 against mukey 113087). The old 'NC - Septic Tank Absorption
// Fields' name returns no rows.
async function querySDA(wkt: string, withInterp: boolean): Promise<Record<string, unknown>> {
  const freqSubqueries = `
  (SELECT TOP 1 flodfreqcl FROM comonth WHERE cokey = c.cokey
    ORDER BY CASE flodfreqcl WHEN 'Frequent' THEN 1 WHEN 'Occasional' THEN 2 WHEN 'Rare' THEN 3 ELSE 4 END
  ) as flodfreqcl,
  (SELECT TOP 1 pondfreqcl FROM comonth WHERE cokey = c.cokey
    ORDER BY CASE pondfreqcl WHEN 'Frequent' THEN 1 WHEN 'Occasional' THEN 2 WHEN 'Rare' THEN 3 ELSE 4 END
  ) as pondfreqcl,
  (SELECT MIN(csm.soimoistdept_l)
   FROM comonth cm2
   JOIN cosoilmoist csm ON csm.comonthkey = cm2.comonthkey
   WHERE cm2.cokey = c.cokey AND csm.soimoiststat = 'Wet'
  ) as water_table_cm`;

  const sql = withInterp
    ? `SELECT mu.mukey, mu.muname,
  c.cokey, c.majcompflag, c.comppct_r,
  c.drainagecl, c.slope_l, c.slope_h,
  ci.interphrc as septic_rating,
  h.ksat_l, h.ksat_r, h.ksat_h,
  h.awc_r, r.resdept_r, r.reskind,
  ${freqSubqueries}
FROM mapunit mu
JOIN component c ON mu.mukey = c.mukey AND c.majcompflag = 'Yes'
LEFT JOIN cointerp ci ON c.cokey = ci.cokey
  AND ci.mrulename = 'ENG - Septic Tank Absorption Fields'
  AND ci.ruledepth = 0
LEFT JOIN chorizon h ON c.cokey = h.cokey AND h.hzdept_r = 0
LEFT JOIN corestrictions r ON c.cokey = r.cokey
WHERE mu.mukey IN (
  SELECT DISTINCT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')
)
ORDER BY r.resdept_r ASC`
    : `SELECT mu.mukey, mu.muname,
  c.cokey, c.majcompflag, c.comppct_r,
  c.drainagecl, c.slope_l, c.slope_h,
  h.ksat_l, h.ksat_r, h.ksat_h,
  h.awc_r, r.resdept_r, r.reskind,
  ${freqSubqueries}
FROM mapunit mu
JOIN component c ON mu.mukey = c.mukey AND c.majcompflag = 'Yes'
LEFT JOIN chorizon h ON c.cokey = h.cokey AND h.hzdept_r = 0
LEFT JOIN corestrictions r ON c.cokey = r.cokey
WHERE mu.mukey IN (
  SELECT DISTINCT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}')
)
ORDER BY r.resdept_r ASC`;

  const params = new URLSearchParams();
  params.append("query", sql);
  params.append("format", "JSON+COLUMNNAME");

  console.log("[sda] POST to", SDA_URL, "withInterp:", withInterp);
  console.log("[sda] WKT length:", wkt.length, "preview:", wkt.slice(0, 200));

  const resp = await withTimeout(
    fetch(SDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }),
    45_000
  );

  const rawText = await resp.text();
  console.log("[sda] response status:", resp.status, rawText.slice(0, 600));

  if (!resp.ok) {
    console.error("[sda] HTTP", resp.status, "full response:", rawText);
    throw new Error(`SDA HTTP ${resp.status}: ${rawText.slice(0, 200)}`);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawText) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`SDA response not valid JSON: ${rawText.slice(0, 200)}`);
  }

  const table = (json as { Table?: unknown[][] }).Table;
  console.log("[sda] rows returned:", table ? table.length - 1 : 0);
  return json;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const jsonResp = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResp({ error: "Missing Authorization header" }, 401);

    // Accept both user JWTs and service role key (for background calls from lookup-parcel)
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify auth — service role key bypasses user check; user JWT verifies normally
    const isServiceCall = authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let userId: string | null = null;

    if (!isServiceCall) {
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user }, error } = await anonClient.auth.getUser();
      if (error || !user) return jsonResp({ error: "Unauthorized" }, 401);
      userId = user.id;
    }

    const body = await req.json() as {
      report_id: string;
      geometry: Record<string, unknown>;
      wkt_override?: string;
      boundary_source?: string;
      has_boundary?: boolean;
      append_results?: boolean;
    };

    if (!body.report_id || !body.geometry) {
      return jsonResp({ error: "report_id and geometry are required" }, 400);
    }

    const { report_id, geometry, wkt_override, has_boundary = false, append_results = false } = body;
    console.log("[soil-query] report_id:", report_id, "has_boundary:", has_boundary, "wkt_override:", !!wkt_override, "append:", append_results);

    // Verify report exists (and ownership if user call)
    const reportQuery = serviceClient
      .from("reports")
      .select("id, user_id, parcel_id")
      .eq("id", report_id);
    if (userId) reportQuery.eq("user_id", userId);

    const { data: report, error: reportErr } = await reportQuery.maybeSingle();
    if (reportErr || !report) {
      console.error("[soil-query] report not found:", reportErr?.message);
      return jsonResp({ error: "Report not found or access denied" }, 404);
    }

    await serviceClient.from("reports").update({ status: "processing" }).eq("id", report_id);

    // Use client-provided WKT when given (client handles MultiPolygon + bbox fallback).
    // Otherwise derive WKT from geometry, picking largest sub-polygon and thinning if needed.
    let wkt: string;
    if (wkt_override) {
      wkt = wkt_override;
      console.log("[soil-query] using client wkt_override, length:", wkt.length);
    } else {
      try {
        wkt = geojsonToWkt(geometry);
        console.log("[soil-query] derived WKT length:", wkt.length, "preview:", wkt.slice(0, 200));
      } catch (e) {
        return jsonResp({ error: `Invalid GeoJSON: ${(e as Error).message}` }, 400);
      }
    }

    // ── Query SDA: try with NRCS interp first, fall back to basic query ────────
    let rows: SDARow[] = [];
    let hasRating = false;

    try {
      console.log("[soil-query] trying interp query (ENG - Septic Tank Absorption Fields), WKT length:", wkt.length);
      const sdaJson = await querySDA(wkt, true);
      rows = parseTable(sdaJson, true);
      hasRating = true;
      console.log("[soil-query] interp query returned", rows.length, "rows, ratings:", rows.filter(r => r.septic_rating).length, "non-null");
    } catch (e) {
      console.warn("[soil-query] interp query failed:", (e as Error).message, "— trying basic");
      try {
        const sdaJson = await querySDA(wkt, false);
        rows = parseTable(sdaJson, false);
        hasRating = false;
        console.log("[soil-query] basic query returned", rows.length, "rows");
      } catch (e2) {
        console.error("[soil-query] both SDA queries failed:", (e2 as Error).message);
        await serviceClient.from("reports").update({ status: "failed" }).eq("id", report_id);
        return jsonResp({ error: `SSURGO query failed: ${(e2 as Error).message}` }, 502);
      }
    }

    if (rows.length === 0) {
      console.log("[soil-query] no SSURGO data for this geometry — marking complete");
      await serviceClient
        .from("reports")
        .update({ status: "complete", conventional_score: null, alternative_score: null, confidence: 0 })
        .eq("id", report_id);
      return jsonResp({ report_id, soil_units: [], message: "No SSURGO data intersects this parcel" });
    }

    // Save soil results — clear existing rows unless appending (subsequent sub-polygon queries).
    if (!append_results) {
      await serviceClient.from("soil_results").delete().eq("report_id", report_id);
    }

    // Convert water_table_cm (cm) to inches for storage.
    // water_table_cm is the minimum soimoistdept_l (top of wet zone) across all wet months.
    // depth_water_table continues to store resdept_r (restrictive layer) for backwards compat.
    const CM_TO_IN = 0.393701;

    const soilInserts = rows.map((row) => ({
      report_id,
      map_unit_key: row.mukey,
      map_unit_name: row.muname,
      texture_class: row.texture_l,
      drainage_class: row.drainagecl,
      perc_class: derivePercClass(row.ksat_r),
      nrcs_septic_rating: row.septic_rating,
      depth_water_table: row.resdept_r,            // restrictive layer depth — kept for backwards compat
      water_table_depth: row.water_table_cm != null // true seasonal high water table
        ? Math.round(row.water_table_cm * CM_TO_IN)
        : null,
      ksat_low: row.ksat_l,
      ksat_r: row.ksat_r,
      ksat_high: row.ksat_h,
      slope_low: row.slope_l,
      slope_high: row.slope_h,
      pct_coverage: row.comppct_r,
      raw_ssurgo: row as unknown as Record<string, unknown>,
    }));

    const { error: insertErr } = await serviceClient.from("soil_results").insert(soilInserts);
    if (insertErr) {
      console.error("[soil-query] insert failed:", insertErr.message);
      await serviceClient.from("reports").update({ status: "failed" }).eq("id", report_id);
      return jsonResp({ error: `Failed to store soil results: ${insertErr.message}` }, 500);
    }

    console.log("[soil-query] inserted", soilInserts.length, "soil results, hasRating:", hasRating);

    // Update parcel boundary if it came from a real source
    await serviceClient
      .from("parcels")
      .update({ boundary_geojson: geometry })
      .eq("id", report.parcel_id);

    return jsonResp({
      report_id,
      soil_units_count: rows.length,
      has_nc_rating: hasRating,
      message: "Soil data retrieved successfully",
    });

  } catch (err) {
    console.error("[soil-query] unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
