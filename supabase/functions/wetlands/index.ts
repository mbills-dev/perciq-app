import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { bbox } = await req.json() as { bbox: [number, number, number, number] };
    const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
    console.log('[nwi server route] called with bbox:', bboxStr);

    const makeParams = () => new URLSearchParams({
      geometry: bboxStr,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where: '1=1',
      outFields: 'ATTRIBUTE,WETLAND_TYPE',
      returnGeometry: 'true',
      outSR: '4326',
      resultRecordCount: '500',
      f: 'geojson',
    });

    // Primary: Esri-hosted ArcGIS REST — CORS-enabled, reliable
    const esriUrl = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Wetlands/FeatureServer/0/query?${makeParams()}`;
    // Fallback endpoints
    const fallbackUrls = [
      `https://fwspublicservices.wim.usgs.gov/server/rest/services/Wetlands/MapServer/0/query?${makeParams()}`,
      `https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query?${makeParams()}`,
    ];

    for (const url of [esriUrl, ...fallbackUrls]) {
      try {
        console.log('[nwi server route] trying:', url.slice(0, 120));
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        console.log('[nwi server route] status:', res.status);
        if (!res.ok) { console.warn('[nwi server route] non-ok, trying next'); continue; }

        const data = await res.json() as { features?: unknown[] };
        const count = data.features?.length ?? 0;
        console.log('[nwi server route] features:', count);

        if (count === 0) { console.warn('[nwi server route] 0 features, trying next'); continue; }

        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        console.warn('[nwi server route] fetch error:', (e as Error).message);
      }
    }

    console.warn('[nwi server route] all endpoints exhausted');
    return new Response(JSON.stringify({ features: [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[nwi server route] handler error:', (e as Error).message);
    return new Response(JSON.stringify({ features: [], error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
