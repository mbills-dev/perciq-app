import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

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

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("stripe_customer_id, plan, subscription_status, plan_renewal_date, monthly_analyses_used, analyses_reset_at")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile?.stripe_customer_id) {
      return new Response(JSON.stringify({
        plan: profile?.plan ?? "free",
        subscription_status: "inactive",
        plan_renewal_date: null,
        monthly_analyses_used: profile?.monthly_analyses_used ?? 0,
        analyses_reset_at: profile?.analyses_reset_at ?? null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
    });

    const subscriptions = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "all",
      limit: 1,
    });

    const sub = subscriptions.data[0];
    if (!sub) {
      return new Response(JSON.stringify({
        plan: "free",
        subscription_status: "inactive",
        plan_renewal_date: null,
        monthly_analyses_used: profile.monthly_analyses_used ?? 0,
        analyses_reset_at: profile.analyses_reset_at ?? null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const PRICE_TO_PLAN: Record<string, string> = {
      "price_1TcSpr4HNibJp1qsMmG5ILVz": "starter",
      "price_1TcSps4HNibJp1qskQtKARUe": "starter",
      "price_1TcSps4HNibJp1qsU8qaDGwL": "pro",
      "price_1TcSps4HNibJp1qsoxLHOmAd": "pro",
      "price_1TcSps4HNibJp1qsO3cmZUZS": "unlimited",
      "price_1TcSpr4HNibJp1qsdQ7YHMco": "unlimited",
    };

    const priceId = sub.items.data[0]?.price.id ?? "";
    const plan = PRICE_TO_PLAN[priceId] ?? "free";
    const renewalDate = new Date(sub.current_period_end * 1000).toISOString().split("T")[0];

    // Sync back to Supabase — use update to avoid clobbering other fields
    await supabase.from("user_profiles")
      .update({ plan, subscription_status: sub.status, plan_renewal_date: renewalDate })
      .eq("id", user.id);

    return new Response(JSON.stringify({
      plan,
      subscription_status: sub.status,
      plan_renewal_date: renewalDate,
      cancel_at_period_end: sub.cancel_at_period_end,
      monthly_analyses_used: profile.monthly_analyses_used ?? 0,
      analyses_reset_at: profile.analyses_reset_at ?? null,
    }), {
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
