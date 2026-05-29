import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function planFromPriceId(priceId: string): string {
  if (priceId.includes("starter")) return "starter";
  if (priceId.includes("pro")) return "pro";
  if (priceId.includes("unlimited")) return "unlimited";
  return "free";
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
      const userId = session.metadata?.supabase_user_id ?? session.subscription_data?.metadata?.supabase_user_id;
      const customerId = session.customer as string;

      if (userId && session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
        const priceId = subscription.items.data[0]?.price.id ?? "";
        const plan = session.metadata?.plan ?? planFromPriceId(priceId);
        const renewalDate = new Date(subscription.current_period_end * 1000).toISOString().split("T")[0];

        await supabase.from("user_profiles").upsert({
          id: userId,
          stripe_customer_id: customerId,
          plan,
          subscription_status: subscription.status,
          plan_renewal_date: renewalDate,
          monthly_analyses_used: 0,
          analyses_reset_at: new Date().toISOString(),
        }, { onConflict: "id" });
      }
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.supabase_user_id;
      const priceId = subscription.items.data[0]?.price.id ?? "";
      const plan = planFromPriceId(priceId);
      const renewalDate = new Date(subscription.current_period_end * 1000).toISOString().split("T")[0];

      if (userId) {
        await supabase.from("user_profiles").upsert({
          id: userId,
          plan,
          subscription_status: subscription.status,
          plan_renewal_date: renewalDate,
        }, { onConflict: "id" });
      } else {
        // Fall back to looking up by stripe_customer_id
        const customerId = subscription.customer as string;
        await supabase.from("user_profiles")
          .update({
            plan,
            subscription_status: subscription.status,
            plan_renewal_date: renewalDate,
          })
          .eq("stripe_customer_id", customerId);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.supabase_user_id;
      const customerId = subscription.customer as string;

      if (userId) {
        await supabase.from("user_profiles").upsert({
          id: userId,
          plan: "free",
          subscription_status: "inactive",
          plan_renewal_date: null,
        }, { onConflict: "id" });
      } else {
        await supabase.from("user_profiles")
          .update({ plan: "free", subscription_status: "inactive", plan_renewal_date: null })
          .eq("stripe_customer_id", customerId);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
