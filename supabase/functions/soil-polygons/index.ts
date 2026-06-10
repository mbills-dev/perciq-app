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

// ── WKT parser (paren-nesting, no regex shortcuts) ────────────────────────────

// Split a string on commas that are at paren-nesting depth 0.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(p => p.length > 0);
}

// Strip exactly one leading '(' and one trailing ')'.
function stripOneParen(s: string): string {
  s = s.trim();
  if (s.startsWith('(') && s.endsWith(')')) return s.slice(1, -1).trim();
  return s;
}

// Parse a ring string "x1 y1, x2 y2, ..." (no outer parens) into coordinates.
function parseRingStr(s: string): number[][] {
  const coords = s.split(',').map(pair => {
    const parts = pair.trim().split(/\s+/).map(Number);
    return [parts[0], parts[1]];
  }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
  if (coords.length >= 3) {
    const [x0, y0] = coords[0], [xn, yn] = coords[coords.length - 1];
    if (x0 !== xn || y0 !== yn) coords.push([x0, y0]);
  }
  return coords;
}

// Parse WKT (POLYGON or MULTIPOLYGON) into one GeoJSON Polygon geometry per sub-polygon.
// A MULTIPOLYGON with two disjoint patches yields two Polygon geometries.
// Correctly preserves hole rings within each polygon.
function wktToPolygonGeometries(wkt: string): { type: "Polygon"; coordinates: number[][][] }[] {
  try {
    const upper = wkt.trimStart().toUpperCase();
    const isMulti = upper.startsWith("MULTIPOLYGON");

    const parenStart = wkt.indexOf('(');
    const parenEnd = wkt.lastIndexOf(')');
    if (parenStart < 0 || parenEnd < 0) return [];

    // Content between the outermost geometry parens.
    // POLYGON((ring),(hole))       → outerContent = "(ring),(hole)"
    // MULTIPOLYGON(((r1),(h1)),((r2))) → outerContent = "((r1),(h1)),((r2))"
    const outerContent = wkt.slice(parenStart + 1, parenEnd).trim();

    if (isMulti) {
      // Each top-level group is one polygon: "((ring),(hole))" or "((ring))"
      const polyGroups = splitTopLevel(outerContent);
      const results: { type: "Polygon"; coordinates: number[][][] }[] = [];
      for (const group of polyGroups) {
        // Strip one paren level → "(ring),(hole)" or "(ring)"
        const polyContent = stripOneParen(group);
        const ringGroups = splitTopLevel(polyContent);
        const rings: number[][][] = [];
        for (const rg of ringGroups) {
          const coords = parseRingStr(stripOneParen(rg));
          if (coords.length >= 3) rings.push(coords);
        }
        if (rings.length > 0) results.push({ type: "Polygon", coordinates: rings });
      }
      return results;
    } else {
      // POLYGON: outerContent = "(ring),(hole),..."
      const ringGroups = splitTopLevel(outerContent);
      const rings: number[][][] = [];
      for (const rg of ringGroups) {
        const coords = parseRingStr(stripOneParen(rg));
        if (coords.length >= 3) rings.push(coords);
      }
      if (rings.length === 0) return [];
      return [{ type: "Polygon", coordinates: rings }];
    }
  } catch {
    return [];
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
    const geometries = wktToPolygonGeometries(wktGeom);
    for (const geometry of geometries) {
      features.push({ type: "Feature", properties: { mukey, musym, muname }, geometry });
    }
    if (geometries.length > 1) {
      console.log(`[sda-tabular] mukey ${mukey} split into ${geometries.length} sub-polygon features`);
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
