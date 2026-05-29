import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Maps real Stripe price IDs to plan names
const PRICE_TO_PLAN: Record<string, string> = {
  "price_1TcSpr4HNibJp1qsMmG5ILVz": "starter",
  "price_1TcSps4HNibJp1qskQtKARUe": "starter",
  "price_1TcSps4HNibJp1qsU8qaDGwL": "pro",
  "price_1TcSps4HNibJp1qsoxLHOmAd": "pro",
  "price_1TcSps4HNibJp1qsO3cmZUZS": "unlimited",
  "price_1TcSpr4HNibJp1qsdQ7YHMco": "unlimited",
};

function planFromPriceId(priceId: string): string {
  return PRICE_TO_PLAN[priceId] ?? "free";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2024-06-20",
    });

    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const signature = req.headers.get("stripe-signature");
    const body = await req.text();

    let event: Stripe.Event;
    if (webhookSecret && signature) {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    } else {
      event = JSON.parse(body) as Stripe.Event;
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = session.customer as string;

      // Retrieve the subscription to get price ID and metadata
      if (!session.subscription) {
        console.log("No subscription on session, skipping.");
        return new Response(JSON.stringify({ received: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
      const priceId = subscription.items.data[0]?.price.id ?? "";
      const plan = planFromPriceId(priceId);
      const renewalDate = new Date(subscription.current_period_end * 1000).toISOString().split("T")[0];

      // userId can be on the session metadata OR subscription metadata
      const userId =
        session.metadata?.supabase_user_id ??
        subscription.metadata?.supabase_user_id;

      console.log(`checkout.session.completed: customerId=${customerId} userId=${userId} priceId=${priceId} plan=${plan}`);

      if (userId) {
        const { error } = await supabase.from("user_profiles").upsert({
          id: userId,
          stripe_customer_id: customerId,
          plan,
          subscription_status: subscription.status,
          plan_renewal_date: renewalDate,
          monthly_analyses_used: 0,
          analyses_reset_at: new Date().toISOString(),
        }, { onConflict: "id" });
        if (error) console.error("upsert by userId error:", error);
      } else {
        // Fallback: look up user by stripe_customer_id
        console.log(`No userId in metadata, falling back to stripe_customer_id lookup: ${customerId}`);
        const { error } = await supabase.from("user_profiles")
          .update({
            stripe_customer_id: customerId,
            plan,
            subscription_status: subscription.status,
            plan_renewal_date: renewalDate,
            monthly_analyses_used: 0,
            analyses_reset_at: new Date().toISOString(),
          })
          .eq("stripe_customer_id", customerId);
        if (error) console.error("update by customerId error:", error);
      }
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price.id ?? "";
      const plan = planFromPriceId(priceId);
      const renewalDate = new Date(subscription.current_period_end * 1000).toISOString().split("T")[0];
      const customerId = subscription.customer as string;
      const userId = subscription.metadata?.supabase_user_id;

      console.log(`customer.subscription.updated: customerId=${customerId} userId=${userId} priceId=${priceId} plan=${plan}`);

      if (userId) {
        const { error } = await supabase.from("user_profiles").upsert({
          id: userId,
          plan,
          subscription_status: subscription.status,
          plan_renewal_date: renewalDate,
        }, { onConflict: "id" });
        if (error) console.error("upsert error:", error);
      } else {
        const { error } = await supabase.from("user_profiles")
          .update({ plan, subscription_status: subscription.status, plan_renewal_date: renewalDate })
          .eq("stripe_customer_id", customerId);
        if (error) console.error("update error:", error);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;
      const userId = subscription.metadata?.supabase_user_id;

      console.log(`customer.subscription.deleted: customerId=${customerId} userId=${userId}`);

      if (userId) {
        const { error } = await supabase.from("user_profiles").upsert({
          id: userId,
          plan: "free",
          subscription_status: "inactive",
          plan_renewal_date: null,
        }, { onConflict: "id" });
        if (error) console.error("upsert error:", error);
      } else {
        const { error } = await supabase.from("user_profiles")
          .update({ plan: "free", subscription_status: "inactive", plan_renewal_date: null })
          .eq("stripe_customer_id", customerId);
        if (error) console.error("update error:", error);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("Webhook error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
