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
    const [xmin, ymin, xmax, ymax] = bbox;
    const bboxStr = `${xmin},${ymin},${xmax},${ymax}`;

    console.log('[fema server route] called with bbox:', bboxStr);

    const makeParams = (where: string) => new URLSearchParams({
      geometry: bboxStr,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where,
      outFields: 'FLD_ZONE,SFHA_TF',
      returnGeometry: 'true',
      outSR: '4326',
      resultRecordCount: '500',
      f: 'geojson',
    });

    // Primary: Esri-hosted ArcGIS REST — CORS-enabled, reliable
    const esriUrl = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0/query?${makeParams("FLD_ZONE IN ('A','AE','AH','AO','VE','V')")}`;
    console.log('[fema server route] trying Esri ArcGIS:', esriUrl.slice(0, 120));
    try {
      const res = await fetch(esriUrl, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const data = await res.json() as { features?: unknown[]; error?: { message?: string } };
        if (!data.error) {
          console.log('[fema server route] Esri features:', data.features?.length ?? 0);
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        console.warn('[fema server route] Esri api error:', data.error?.message);
      } else {
        console.warn('[fema server route] Esri non-ok:', res.status);
      }
    } catch (e) {
      console.warn('[fema server route] Esri fetch error:', (e as Error).message);
    }

    // Fallback: hazards.fema.gov layers 28 then 3
    const makeFemaUrl = (layer: number) =>
      `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/${layer}/query?${makeParams("FLD_ZONE IN ('A','AE','AH','AO','VE','V')")}`;

    for (const layer of [28, 3]) {
      try {
        const url = makeFemaUrl(layer);
        console.log('[fema server route] trying hazards.fema.gov layer', layer);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'PercIQ/1.0', 'Accept': 'application/json', 'Referer': 'https://msc.fema.gov' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) { console.warn('[fema server route] layer', layer, 'status:', res.status); continue; }
        const data = await res.json() as { features?: unknown[]; error?: { message?: string } };
        if (data.error) { console.warn('[fema server route] layer', layer, 'api error:', data.error.message); continue; }
        const count = data.features?.length ?? 0;
        console.log('[fema server route] layer', layer, 'features:', count);
        if (count === 0 && layer === 28) { continue; }
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        console.warn('[fema server route] layer', layer, 'fetch error:', (e as Error).message);
      }
    }

    console.warn('[fema server route] all sources exhausted');
    return new Response(JSON.stringify({ features: [] }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[fema server route] handler error:', (e as Error).message);
    return new Response(JSON.stringify({ features: [], error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
