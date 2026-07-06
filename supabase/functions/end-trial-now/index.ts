import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PRICE_IDS: Record<string, Record<string, string>> = {
  starter: {
    monthly: "price_1TcSpr4HNibJp1qsMmG5ILVz",
    annual: "price_1TcSps4HNibJp1qskQtKARUe",
  },
  pro: {
    monthly: "price_1TcSps4HNibJp1qsU8qaDGwL",
    annual: "price_1TcSps4HNibJp1qsoxLHOmAd",
  },
  unlimited: {
    monthly: "price_1TcSps4HNibJp1qsO3cmZUZS",
    annual: "price_1TcSpr4HNibJp1qsdQ7YHMco",
  },
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

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    const customerId = profile?.stripe_customer_id as string | null;
    if (!customerId) {
      return new Response(JSON.stringify({ error: "No Stripe customer found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
    });

    // Find the trialing subscription for this customer
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "trialing",
      limit: 1,
    });

    const subscription = subscriptions.data[0];
    if (!subscription) {
      return new Response(JSON.stringify({ error: "No trialing subscription found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse optional plan change from request body
    let newPriceId: string | null = null;
    try {
      const body = await req.json() as { plan?: string; interval?: string };
      if (body.plan && body.interval) {
        const priceId = PRICE_IDS[body.plan]?.[body.interval];
        if (!priceId) {
          return new Response(JSON.stringify({ error: "Invalid plan or interval" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        newPriceId = priceId;
      }
    } catch {
      // Empty body is fine — just ending trial without plan change
    }

    const currentItemId = subscription.items.data[0]?.id;

    const updateParams: Stripe.SubscriptionUpdateParams = { trial_end: "now" };
    if (newPriceId && currentItemId) {
      updateParams.items = [{ id: currentItemId, price: newPriceId }];
      // Prorate the plan change so the customer pays the new plan price immediately
      updateParams.proration_behavior = "create_prorations";
    }

    await stripe.subscriptions.update(subscription.id, updateParams);

    // Do NOT write to user_profiles here — the stripe-webhook customer.subscription.updated
    // event handles the profile update and counter reset (trialing→active transition).

    return new Response(JSON.stringify({ success: true }), {
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
