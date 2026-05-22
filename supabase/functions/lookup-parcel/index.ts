import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const NC1MAP_URL =
  "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0/query";

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Mapbox geocoding
// ---------------------------------------------------------------------------

interface MapboxFeature {
  center: [number, number];
  place_name: string;
  context?: Array<{ id: string; text: string; short_code?: string }>;
}

interface GeocodedLocation {
  lat: number;
  lng: number;
  formattedAddress: string;
  state: string | null;
  county: string | null;
}

async function geocodeAddress(query: string, token: string): Promise<GeocodedLocation> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?country=US&types=address,place&limit=1&access_token=${token}`;

  console.log("[geocode] querying Mapbox for:", query);
  const resp = await timeout(fetch(url), 10_000);
  if (!resp.ok) throw new Error(`Mapbox geocoding HTTP ${resp.status}`);

  const json = (await resp.json()) as { features: MapboxFeature[] };
  if (!json.features?.length) throw new Error("No geocoding results found for that address");

  const feature = json.features[0];
  const [lng, lat] = feature.center;
  let state: string | null = null;
  let county: string | null = null;

  for (const ctx of feature.context ?? []) {
    if (ctx.id.startsWith("region.")) state = ctx.short_code?.replace("US-", "") ?? ctx.text ?? null;
    if (ctx.id.startsWith("district.")) county = ctx.text?.replace(/ County$/i, "") ?? null;
  }

  console.log(`[geocode] result: lat=${lat} lng=${lng} state=${state} county=${county}`);
  return { lat, lng, formattedAddress: feature.place_name, state, county };
}

// ---------------------------------------------------------------------------
// NC OneMap parcel lookup
// ---------------------------------------------------------------------------

interface NCParcelProperties {
  parno?: string;
  owner?: string;
  siteaddress?: string;
  gisacreage?: number;
  calcacreage?: number;
  county?: string;
  [key: string]: unknown;
}

interface NCParcelResult {
  apn: string | null;
  owner: string | null;
  acreage: number | null;
  county: string | null;
  siteAddress: string | null;
  boundary: Record<string, unknown> | null;
}

function buildBboxFallback(lat: number, lng: number): Record<string, unknown> {
  const d = 0.001; // ~100m buffer (smaller = more accurate centroid queries)
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - d, lat - d],
        [lng + d, lat - d],
        [lng + d, lat + d],
        [lng - d, lat + d],
        [lng - d, lat - d],
      ],
    ],
  };
}

async function queryNC1MapByEnvelope(lat: number, lng: number): Promise<NCParcelResult | null> {
  // Use a 50m envelope for spatial intersect — large enough to hit most parcels
  const delta = 0.0005; // ~55m
  const envelope = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;

  const params = new URLSearchParams({
    geometry: envelope,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    f: "geojson",
    outSR: "4326",
    resultRecordCount: "1",
  });

  console.log("[nc1map] spatial envelope query:", envelope);
  const resp = await timeout(fetch(`${NC1MAP_URL}?${params.toString()}`), 20_000);

  if (!resp.ok) {
    console.warn("[nc1map] HTTP error:", resp.status, resp.statusText);
    return null;
  }

  const text = await resp.text();
  console.log("[nc1map] response length:", text.length, "first 200:", text.slice(0, 200));

  let json: { features?: Array<{ geometry?: Record<string, unknown>; properties?: NCParcelProperties }>; error?: { message?: string } };
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.warn("[nc1map] JSON parse failed:", e);
    return null;
  }

  if (json.error) {
    console.warn("[nc1map] API error:", json.error.message);
    return null;
  }

  if (!json.features?.length) {
    console.log("[nc1map] no features returned for envelope");
    return null;
  }

  const feat = json.features[0];
  const props = feat.properties ?? {};
  console.log("[nc1map] found parcel:", props.parno, props.siteaddress, "acreage:", props.gisacreage);

  return {
    apn: props.parno ?? null,
    owner: props.owner ?? null,
    acreage: props.gisacreage ?? props.calcacreage ?? null,
    county: props.county ?? null,
    siteAddress: props.siteaddress ?? null,
    boundary: feat.geometry ?? null,
  };
}

async function queryNC1MapByAPN(apn: string): Promise<NCParcelResult | null> {
  const params = new URLSearchParams({
    where: `parno='${apn.replace(/'/g, "''")}'`,
    outFields: "*",
    returnGeometry: "true",
    f: "geojson",
    outSR: "4326",
    resultRecordCount: "1",
  });

  console.log("[nc1map] APN query:", apn);
  const resp = await timeout(fetch(`${NC1MAP_URL}?${params.toString()}`), 20_000);
  if (!resp.ok) return null;

  const json = (await resp.json()) as { features?: Array<{ geometry?: Record<string, unknown>; properties?: NCParcelProperties }> };
  if (!json.features?.length) return null;

  const feat = json.features[0];
  const props = feat.properties ?? {};
  return {
    apn: props.parno ?? null,
    owner: props.owner ?? null,
    acreage: props.gisacreage ?? props.calcacreage ?? null,
    county: props.county ?? null,
    siteAddress: props.siteaddress ?? null,
    boundary: feat.geometry ?? null,
  };
}

// Reformat a hyphen-free APN string into Durham-style XXXX-XX-XXXXXX (4-2-6).
function reformatApn(raw: string): string[] {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length !== 12) return [];
  // 4-2-6 pattern: chars 0-3, 4-5, 6-11
  return [`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`];
}

async function resolveParcel(query: string, lat: number, lng: number): Promise<NCParcelResult | null> {
  // Try APN lookup first if input looks like a parcel number
  if (/^[\d\s\-]+$/.test(query.trim())) {
    const trimmed = query.trim();
    const result = await queryNC1MapByAPN(trimmed).catch((e) => {
      console.warn("[nc1map] APN lookup failed:", e.message);
      return null;
    });
    if (result) return result;

    // Retry with hyphen-reformatted variants (e.g. "096063606060" → "0960-63-6060")
    const variants = reformatApn(trimmed);
    console.log("[nc1map] APN returned 0 results, trying reformatted variants:", variants);
    for (const variant of variants) {
      const r = await queryNC1MapByAPN(variant).catch((e) => {
        console.warn("[nc1map] APN variant lookup failed:", e.message);
        return null;
      });
      if (r) return r;
    }
  }

  // Primary: spatial envelope lookup using geocoded coordinates
  const result = await queryNC1MapByEnvelope(lat, lng).catch((e) => {
    console.warn("[nc1map] envelope lookup failed:", e.message);
    return null;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = (await req.json()) as { query: string };
    if (!body.query?.trim()) return json({ error: "query is required" }, 400);

    const rawQuery = body.query.trim();
    const mapboxToken = Deno.env.get("MAPBOX_TOKEN");
    if (!mapboxToken) return json({ error: "Mapbox token not configured" }, 500);

    // ── Step 1: Geocode ──────────────────────────────────────────────────────
    console.log("[lookup-parcel] step 1: geocoding query:", rawQuery);
    let lat: number, lng: number, formattedAddress: string;
    let geocodedState: string | null = null;
    let geocodedCounty: string | null = null;

    try {
      const geo = await geocodeAddress(rawQuery, mapboxToken);
      lat = geo.lat;
      lng = geo.lng;
      formattedAddress = geo.formattedAddress;
      geocodedState = geo.state;
      geocodedCounty = geo.county;
    } catch (e) {
      console.error("[lookup-parcel] geocoding failed:", e);
      return json({ error: `Geocoding failed: ${(e as Error).message}` }, 422);
    }

    // ── Step 2: NC OneMap boundary lookup ────────────────────────────────────
    console.log("[lookup-parcel] step 2: NC1Map lookup at", lat, lng);
    let parcelData: NCParcelResult | null = null;
    let hasBoundary = false;

    try {
      parcelData = await resolveParcel(rawQuery, lat, lng);
      hasBoundary = parcelData?.boundary != null;
      console.log("[lookup-parcel] NC1Map result:", parcelData ? `found (boundary=${hasBoundary})` : "not found");
    } catch (e) {
      console.warn("[lookup-parcel] NC1Map lookup threw:", (e as Error).message);
    }

    const finalAddress = parcelData?.siteAddress
      ? `${parcelData.siteAddress}${parcelData.county ? `, ${parcelData.county} County, NC` : ""}`
      : formattedAddress;

    const state = geocodedState ?? "NC";
    const county = (parcelData?.county ?? geocodedCounty ?? null)?.replace(/ County$/i, "");

    // Build geometry: real boundary or 0.001° bbox fallback
    const boundary: Record<string, unknown> = parcelData?.boundary ?? buildBboxFallback(lat, lng);
    const boundarySource = hasBoundary ? "nc1map" : "bbox_fallback";
    console.log("[lookup-parcel] boundary source:", boundarySource, "county:", county);

    // ── Step 3: Save parcel ──────────────────────────────────────────────────
    console.log("[lookup-parcel] step 3: saving parcel");
    const { data: parcel, error: parcelErr } = await serviceClient
      .from("parcels")
      .insert({
        user_id: user.id,
        address: finalAddress,
        apn: parcelData?.apn ?? null,
        lat,
        lng,
        state,
        county,
        acreage: parcelData?.acreage ?? null,
        owner: parcelData?.owner ?? null,
        boundary_geojson: boundary,
      })
      .select()
      .single();

    if (parcelErr) {
      console.error("[lookup-parcel] parcel insert failed:", parcelErr);
      return json({ error: `Failed to save parcel: ${parcelErr.message}` }, 500);
    }

    // ── Step 4: Create report ────────────────────────────────────────────────
    console.log("[lookup-parcel] step 4: creating report");
    const { data: report, error: reportErr } = await serviceClient
      .from("reports")
      .insert({ user_id: user.id, parcel_id: parcel.id, status: "processing" })
      .select()
      .single();

    if (reportErr) {
      console.error("[lookup-parcel] report insert failed:", reportErr);
      return json({ error: `Failed to create report: ${reportErr.message}` }, 500);
    }

    // ── Step 5: Background soil analysis ────────────────────────────────────
    console.log("[lookup-parcel] step 5: kicking off background analysis for report", report.id);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const fnHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          console.log("[bg] calling soil-query for report", report.id);
          const soilResp = await fetch(`${supabaseUrl}/functions/v1/soil-query`, {
            method: "POST",
            headers: fnHeaders,
            body: JSON.stringify({
              report_id: report.id,
              geometry: boundary,
              boundary_source: boundarySource,
              has_boundary: hasBoundary,
            }),
          });

          const soilText = await soilResp.text();
          console.log("[bg] soil-query status:", soilResp.status, "body:", soilText.slice(0, 300));

          if (!soilResp.ok) {
            const e = JSON.parse(soilText) as { error?: string };
            throw new Error(e.error ?? `soil-query HTTP ${soilResp.status}`);
          }

          console.log("[bg] calling calculate-score for report", report.id);
          const scoreResp = await fetch(`${supabaseUrl}/functions/v1/calculate-score`, {
            method: "POST",
            headers: fnHeaders,
            body: JSON.stringify({ report_id: report.id }),
          });

          const scoreText = await scoreResp.text();
          console.log("[bg] calculate-score status:", scoreResp.status, "body:", scoreText.slice(0, 300));

          if (!scoreResp.ok) {
            const e = JSON.parse(scoreText) as { error?: string };
            throw new Error(e.error ?? `calculate-score HTTP ${scoreResp.status}`);
          }

          console.log("[bg] pipeline complete for report", report.id);
        } catch (err) {
          console.error("[bg] background analysis failed:", err);
          await serviceClient
            .from("reports")
            .update({ status: "failed" })
            .eq("id", report.id);
        }
      })()
    );

    return json({
      parcel_id: parcel.id,
      report_id: report.id,
      address: finalAddress,
      lat,
      lng,
      state,
      county,
      apn: parcelData?.apn ?? null,
      acreage: parcelData?.acreage ?? null,
      owner: parcelData?.owner ?? null,
      has_boundary: hasBoundary,
      boundary_source: boundarySource,
      status: "processing",
    });
  } catch (err) {
    console.error("[lookup-parcel] unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
