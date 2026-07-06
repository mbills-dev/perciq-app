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

    // Authenticate user from JWT
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

    // Use service role to read and atomically update the counter
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("plan, subscription_status, monthly_analyses_used, analyses_reset_at")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: "Profile not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Require active or trialing subscription
    const status = profile.subscription_status as string | null;
    if (status !== "active" && status !== "trialing") {
      return new Response(JSON.stringify({ error: "No active subscription" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const plan = (profile.plan ?? "free") as string;
    const limit = PLAN_LIMITS[plan] ?? null;

    // Reset counter if it's a new calendar month
    let currentUsed = (profile.monthly_analyses_used ?? 0) as number;
    const resetAt = profile.analyses_reset_at ? new Date(profile.analyses_reset_at as string) : null;
    const now = new Date();
    if (resetAt && (resetAt.getMonth() !== now.getMonth() || resetAt.getFullYear() !== now.getFullYear())) {
      currentUsed = 0;
    }

    // Enforce limit
    if (limit !== null && currentUsed >= limit) {
      return new Response(JSON.stringify({ error: "Monthly analysis limit reached" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Atomically increment
    const newCount = currentUsed + 1;
    const { error: updateError } = await supabase
      .from("user_profiles")
      .update({
        monthly_analyses_used: newCount,
        analyses_reset_at: currentUsed === 0 ? now.toISOString() : profile.analyses_reset_at,
      })
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
