import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const { lat, lng, county, state } = await req.json();

    const regridToken = Deno.env.get("REGRID_TOKEN");
    console.log("[regrid] token present:", !!regridToken);
    console.log("[regrid] token prefix:", regridToken?.slice(0, 15));

    // STEP 1: Try Regrid
    if (regridToken) {
      try {
        const regridUrl = `https://app.regrid.com/api/v1/parcel/point?lat=${lat}&lon=${lng}&token=${regridToken}&return_geometry=true`;
        console.log("[regrid] calling point API");

        const regridRes = await fetch(regridUrl);
        console.log("[regrid] HTTP status:", regridRes.status);

        const regridText = await regridRes.text();
        console.log("[regrid] response preview:", regridText.slice(0, 200));

        if (regridRes.status === 200) {
          const regridData = JSON.parse(regridText);
          const features = regridData.features || [];
          console.log("[regrid] features found:", features.length);

          if (features.length > 0) {
            const feature = features[0];
            const geometry = feature.geometry;
            const props = feature.properties?.fields || feature.properties || {};

            console.log("[regrid] geometry type:", geometry?.type);

            if (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") {
              console.log("[regrid] SUCCESS - returning real boundary");
              return new Response(JSON.stringify({
                geometry,
                source: "regrid",
                isApproximate: false,
                apn: props.parcelnumb || null,
                acreage: props.ll_gisacre || props.gisacre || null,
                owner: props.owner || null,
              }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
        }
      } catch (regridErr) {
        console.log("[regrid] error:", (regridErr as Error).message);
      }
    } else {
      console.log("[regrid] NO TOKEN FOUND - skipping");
    }

    // STEP 2: FCC fallback
    console.log("[fcc] trying fallback");
    try {
      const fccUrl = `https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lng}&format=json&showall=true`;
      const fccRes = await fetch(fccUrl);
      const fccData = await fccRes.json();

      if (fccData.Block?.bbox) {
        const [minLng, minLat, maxLng, maxLat] = fccData.Block.bbox;
        console.log("[fcc] returning bbox fallback");
        return new Response(JSON.stringify({
          geometry: {
            type: "Polygon",
            coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]],
          },
          source: "fcc-census-block",
          isApproximate: true,
          apn: null, acreage: null, owner: null,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    } catch (fccErr) {
      console.log("[fcc] error:", (fccErr as Error).message);
    }

    // STEP 3: tiny bbox final fallback
    const d = 0.002;
    console.log("[fallback] using tiny bbox");
    return new Response(JSON.stringify({
      geometry: {
        type: "Polygon",
        coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]],
      },
      source: "point-fallback",
      isApproximate: true,
      apn: null, acreage: null, owner: null,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.log("[parcel-boundary] fatal error:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
