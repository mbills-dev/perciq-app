import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PLAN_LIMITS: Record<string, number | null> = {
  free: 3,
  starter: 15,
  pro: 50,
  unlimited: null,
};

const PERIOD_DAYS = 30;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("plan, subscription_status, monthly_analyses_used, usage_period_start")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: "Profile not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const status = profile.subscription_status as string | null;
    if (status !== "active" && status !== "trialing") {
      return new Response(JSON.stringify({ error: "No active subscription" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const plan = (profile.plan ?? "free") as string;
    const limit = PLAN_LIMITS[plan] ?? null;
    const now = new Date();

    // Lazily reset counter if usage_period_start is null or more than 30 days old
    const periodStart = profile.usage_period_start
      ? new Date(profile.usage_period_start as string)
      : null;
    const periodAgeMs = periodStart ? now.getTime() - periodStart.getTime() : Infinity;
    const needsReset = periodAgeMs > PERIOD_DAYS * 24 * 60 * 60 * 1000;

    let currentUsed = needsReset ? 0 : (profile.monthly_analyses_used ?? 0) as number;
    const newPeriodStart = needsReset ? now.toISOString() : (profile.usage_period_start as string | null);

    // Enforce limit after reset
    if (limit !== null && currentUsed >= limit) {
      return new Response(JSON.stringify({ error: "Monthly analysis limit reached" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newCount = currentUsed + 1;
    const updateFields: Record<string, unknown> = { monthly_analyses_used: newCount };
    if (needsReset) updateFields.usage_period_start = newPeriodStart;

    const { error: updateError } = await supabase
      .from("user_profiles")
      .update(updateFields)
      .eq("id", user.id);

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ monthly_analyses_used: newCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
