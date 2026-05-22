import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

interface RegridFields {
  parcelnumb?: string;
  owner?: string;
  address?: string;
  ll_gisacre?: number;
  gisacre?: number;
  lat?: number;
  lon?: number;
  ll_lat?: number;
  ll_lon?: number;
  county?: string;
  state2?: string;
  headline?: string;
  [key: string]: unknown;
}

interface RegridFeature {
  properties: RegridFields & { fields?: RegridFields; headline?: string };
  geometry?: {
    type: string;
    coordinates: unknown;
  };
}

interface RegridResponse {
  results?: RegridFeature[];
  parcels?: { features?: RegridFeature[] };
  [key: string]: unknown;
}

function normaliseFeatures(data: RegridResponse): RegridFeature[] {
  if (Array.isArray(data.results) && data.results.length > 0) return data.results;
  if (data.parcels?.features && data.parcels.features.length > 0) return data.parcels.features;
  return [];
}

function extractParcelInfo(f: RegridFeature) {
  // v2 APN responses nest parcel attributes under properties.fields
  const p: RegridFields = (f.properties?.fields as RegridFields) ?? f.properties ?? {};
  return {
    apn: p.parcelnumb ?? null,
    owner: p.owner ?? null,
    address: p.address ?? (f.properties?.headline as string | undefined) ?? null,
    acreage: p.ll_gisacre ?? p.gisacre ?? null,
    lat: p.ll_lat ?? p.lat ?? null,
    lng: p.ll_lon ?? p.lon ?? null,
    county: p.county ?? null,
    state: p.state2 ?? null,
    boundary: f.geometry ?? null,
  };
}

async function fetchRegrid(url: string): Promise<RegridResponse> {
  const resp = await timeout(fetch(url), 12_000);
  if (!resp.ok) throw new Error(`Regrid HTTP ${resp.status}`);
  return resp.json() as Promise<RegridResponse>;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabaseClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json() as {
      mode: "apn" | "owner" | "gps";
      county?: string;
      state?: string;
      apn?: string;
      owner?: string;
      lat?: number | string;
      lng?: number | string;
      lon?: number | string;
      regridToken?: string;
    };

    // Accept token from client (already fetched via get-config) or fall back to env secret
    const regridToken = body.regridToken || Deno.env.get("REGRID_TOKEN");
    if (!regridToken) return json({ error: "Regrid token not configured" }, 500);

    let features: RegridFeature[] = [];

    if (body.mode === "apn") {
      if (!body.county || !body.apn) return json({ error: "county and apn required" }, 400);
      const stateLower = (body.state ?? "nc").toLowerCase();
      const countyLower = body.county.toLowerCase().replace(/\s*county\s*/gi, "").replace(/\s+/g, "-").trim();
      const params = new URLSearchParams({ parcelnumb: body.apn, path: `/us/${stateLower}/${countyLower}`, token: regridToken, limit: "5" });
      const regridUrl = `https://app.regrid.com/api/v2/parcels/apn?${params}`;
      console.log("[regrid-search] apn url:", regridUrl);
      const data = await fetchRegrid(regridUrl);
      console.log("[apn] raw response:", JSON.stringify(data).slice(0, 500));
      console.log("[apn] first result:", data.results?.[0] ?? data.parcels?.features?.[0]);
      features = normaliseFeatures(data).slice(0, 1);

    } else if (body.mode === "owner") {
      if (!body.county || !body.owner) return json({ error: "county and owner required" }, 400);
      const stateAbbr = (body.state ?? "nc").toLowerCase();
      const countySlug = body.county
        .toLowerCase()
        .replace(/\s+county$/i, "")
        .replace(/\s+/g, "-")
        .trim();
      const path = `/us/${stateAbbr}/${countySlug}`;
      const regridUrl =
        `https://app.regrid.com/api/v2/parcels/query` +
        `?fields[owner][ilike]=${encodeURIComponent(body.owner)}` +
        `&path=${encodeURIComponent(path)}` +
        `&limit=10` +
        `&token=${encodeURIComponent(regridToken)}`;
      console.log("[regrid-search] owner url:", regridUrl);
      const data = await fetchRegrid(regridUrl);
      console.log("[owner] raw response:", JSON.stringify(data).slice(0, 500));
      features = normaliseFeatures(data).slice(0, 10);

    } else if (body.mode === "gps") {
      const rawLat = body.lat;
      const rawLon = body.lon ?? body.lng;
      if (rawLat == null || rawLon == null) return json({ error: "lat and lon/lng required" }, 400);
      const lat = parseFloat(String(rawLat)).toFixed(6);
      const lon = parseFloat(String(rawLon)).toFixed(6);
      const regridUrl =
        `https://app.regrid.com/api/v2/parcels/point` +
        `?lat=${lat}&lon=${lon}` +
        `&token=${regridToken}`;
      console.log('[search] Regrid GPS url:', regridUrl);
      const data = await fetchRegrid(regridUrl);
      features = normaliseFeatures(data).slice(0, 1);

    } else {
      return json({ error: "Invalid mode" }, 400);
    }

    const results = features.map(extractParcelInfo);
    return json({ results });
  } catch (e) {
    console.error("[regrid-search] error:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
