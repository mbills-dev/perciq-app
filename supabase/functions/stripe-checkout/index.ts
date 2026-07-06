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
  single_report: {
    one_time: "price_1TcSpt4HNibJp1qsRce7qAkz",
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

    const body = await req.json();
    const { plan, interval = "monthly", successUrl, cancelUrl } = body as {
      plan: string;
      interval: "monthly" | "annual" | "one_time";
      successUrl: string;
      cancelUrl: string;
    };

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
    });

    // Get or create Stripe customer
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    let customerId = profile?.stripe_customer_id as string | undefined;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await supabase
        .from("user_profiles")
        .upsert({ id: user.id, stripe_customer_id: customerId }, { onConflict: "id" });
    }

    const isSingleReport = plan === "single_report";
    const resolvedInterval = isSingleReport ? "one_time" : interval;
    const priceId = PRICE_IDS[plan]?.[resolvedInterval];
    if (!priceId) {
      return new Response(JSON.stringify({ error: "Invalid plan or interval" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      customer: customerId,
      client_reference_id: user.id,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: isSingleReport ? "payment" : "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
    };

    if (!isSingleReport) {
      sessionParams.subscription_data = {
        trial_period_days: 7,
        metadata: { supabase_user_id: user.id, plan },
      };
    } else {
      sessionParams.payment_intent_data = {
        metadata: { supabase_user_id: user.id, plan },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return new Response(JSON.stringify({ url: session.url }), {
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
