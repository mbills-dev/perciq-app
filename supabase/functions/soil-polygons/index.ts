import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const WFS_BASE = "https://SDMDataAccess.sc.egov.usda.gov/Spatial/SDMWGS84GEOGRAPHIC.wfs";
const SDA_TABULAR_URL = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest";

function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

interface GeoJSONFeature {
  type: "Feature";
  properties: Record<string, string | null>;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

// Parse GML from SDMWGS84GEOGRAPHIC.wfs — returns plain lat/lon coordinates
function parseGMLToGeoJSON(gml: string): GeoJSONFeature[] {
  const features: GeoJSONFeature[] = [];

  // Split on feature boundaries
  const featureBlocks = gml.split("<ms:mapunitpolyextended").slice(1);
  console.log("[wfs] feature blocks found:", featureBlocks.length);

  for (const block of featureBlocks) {
    const mukey  = block.match(/<ms:mukey>(\d+)<\/ms:mukey>/)?.[1] ?? null;
    const musym  = block.match(/<ms:musym>([^<]+)<\/ms:musym>/)?.[1] ?? null;
    const muname = block.match(/<ms:muname>([^<]+)<\/ms:muname>/)?.[1] ?? null;

    if (!mukey) continue;

    // Try gml:coordinates first (space-separated lon,lat pairs)
    const coordStr = block.match(/<gml:coordinates[^>]*>([^<]+)<\/gml:coordinates>/)?.[1];
    if (coordStr) {
      const coords = coordStr.trim().split(/\s+/).map(pair => {
        const parts = pair.split(",");
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        return [lon, lat];
      }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));

      if (coords.length >= 3) {
        const first = coords[0], last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
        features.push({
          type: "Feature",
          properties: { mukey, musym, muname },
          geometry: { type: "Polygon", coordinates: [coords] },
        });
        continue;
      }
    }

    // Try gml:posList (space-separated flat sequence: lon lat lon lat ...)
    const posListStr = block.match(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/)?.[1];
    if (posListStr) {
      const nums = posListStr.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
      const coords: number[][] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        coords.push([nums[i], nums[i + 1]]);
      }
      if (coords.length >= 3) {
        const first = coords[0], last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
        features.push({
          type: "Feature",
          properties: { mukey, musym, muname },
          geometry: { type: "Polygon", coordinates: [coords] },
        });
      }
    }
  }

  return features;
}

function wktStringToGeojsonPolygon(wkt: string): { type: "Polygon"; coordinates: number[][][] } | null {
  try {
    // Handle MULTIPOLYGON — use first ring of first polygon
    const isMulti = wkt.trimStart().toUpperCase().startsWith("MULTIPOLYGON");
    let inner: string;
    if (isMulti) {
      const m = wkt.match(/MULTIPOLYGON\s*\(\(\((.+?)\)\)/i);
      if (!m) return null;
      inner = m[1];
    } else {
      const m = wkt.match(/POLYGON\s*\(\((.+?)\)\)/i);
      if (!m) return null;
      inner = m[1];
    }
    const coords = inner.split(",").map(pair => {
      const [lng, lat] = pair.trim().split(/\s+/).map(Number);
      return [lng, lat];
    }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
    if (coords.length < 3) return null;
    // Close ring if needed
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
    return { type: "Polygon", coordinates: [coords] };
  } catch {
    return null;
  }
}

// Proxy the SDA tabular polygon query — called with { wkt: string, bbox?: [minLng, minLat, maxLng, maxLat] }
async function handleTabularQuery(wkt: string, bbox?: [number, number, number, number]): Promise<Response> {
  // When bbox is provided, add a spatial envelope filter so the server only returns polygons
  // that intersect the parcel bbox — prevents hitting the server's maxFeatures row cap.
  const bboxFilter = bbox
    ? ` AND mpp.mupolygongeo.STIntersects(geometry::STGeomFromText('POLYGON((${bbox[0]} ${bbox[1]}, ${bbox[2]} ${bbox[1]}, ${bbox[2]} ${bbox[3]}, ${bbox[0]} ${bbox[3]}, ${bbox[0]} ${bbox[1]}))', 4326)) = 1`
    : '';
  const query = `SELECT mu.mukey, mu.musym, mu.muname, mpp.mupolygongeo.STAsText() as wkt_geometry FROM mapunit mu JOIN mupolygon mpp ON mu.mukey = mpp.mukey WHERE mu.mukey IN (SELECT DISTINCT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}'))${bboxFilter}`;

  console.log("[sda-tabular] posting query, wkt length:", wkt.length, "bbox filter:", !!bbox);

  const params = new URLSearchParams();
  params.append("query", query);
  params.append("format", "JSON+COLUMNNAME");

  const TIMEOUT_MS = 90_000;
  const resp = await withTimeout(
    fetch(SDA_TABULAR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }),
    TIMEOUT_MS
  );

  const text = await resp.text();
  console.log("[sda-tabular] HTTP status:", resp.status, "body (first 300):", text.slice(0, 300));

  if (!resp.ok) {
    return jsonResp({ error: `SDA HTTP ${resp.status}`, features: [] }, 502);
  }

  let sdaJson: { Table?: string[][] };
  try {
    sdaJson = JSON.parse(text);
  } catch {
    return jsonResp({ error: "SDA response not valid JSON", features: [] }, 502);
  }

  const rows = (sdaJson.Table ?? []).slice(1);
  console.log("[sda-tabular] rows:", rows.length);

  const features: GeoJSONFeature[] = [];
  for (const row of rows) {
    const [mukey, musym, muname, wktGeom] = row as string[];
    if (!wktGeom || !mukey) continue;
    const geometry = wktStringToGeojsonPolygon(wktGeom);
    if (geometry) {
      features.push({ type: "Feature", properties: { mukey, musym, muname }, geometry });
    }
  }

  console.log("[sda-tabular] parsed features:", features.length);
  return jsonResp({ type: "FeatureCollection", features });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json() as { bbox?: [number, number, number, number]; wkt?: string };

    // SDA tabular mode — proxy the mupolygon WKT query
    if (body.wkt) {
      return await handleTabularQuery(body.wkt, body.bbox);
    }

    if (!body.bbox || body.bbox.length !== 4) {
      return jsonResp({ error: "bbox [minLng, minLat, maxLng, maxLat] required or wkt string required", features: [] }, 400);
    }

    const [minLng, minLat, maxLng, maxLat] = body.bbox;

    // WGS84 Geographic WFS expects lat/lon order: minLat,minLon,maxLat,maxLon
    const bboxParam = `${minLat},${minLng},${maxLat},${maxLng}`;
    const wfsUrl = `${WFS_BASE}?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=mapunitpolyextended&BBOX=${bboxParam}&SRSNAME=EPSG:4326`;

    console.log("[wfs] fetching:", wfsUrl);

    const resp = await withTimeout(
      fetch(wfsUrl, { headers: { Accept: "application/xml, text/xml, */*" } }),
      30_000
    );

    console.log("[wfs] HTTP status:", resp.status);
    const text = await resp.text();
    console.log("[wfs] raw response:", text.slice(0, 500));

    if (!resp.ok) {
      console.error("[wfs] non-OK response:", text.slice(0, 300));
      return jsonResp({ type: "FeatureCollection", features: [], fallback: true });
    }

    const features = parseGMLToGeoJSON(text);
    console.log("[wfs] parsed features:", features.length);

    return jsonResp({ type: "FeatureCollection", features });

  } catch (err) {
    console.error("[soil-polygons] unhandled error:", err);
    return jsonResp({ error: (err as Error).message, features: [], fallback: true });
  }
});
