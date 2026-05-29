import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

async function updateProfileByUserId(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const { error, count } = await supabase
    .from("user_profiles")
    .update(fields)
    .eq("id", userId)
    .select("id", { count: "exact", head: true });
  if (error) {
    console.error(`updateProfileByUserId(${userId}) error:`, JSON.stringify(error));
  } else {
    console.log(`updateProfileByUserId(${userId}) rows affected: ${count}`);
  }
}

async function updateProfileByCustomerId(
  supabase: ReturnType<typeof createClient>,
  customerId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const { error, count } = await supabase
    .from("user_profiles")
    .update(fields)
    .eq("stripe_customer_id", customerId)
    .select("id", { count: "exact", head: true });
  if (error) {
    console.error(`updateProfileByCustomerId(${customerId}) error:`, JSON.stringify(error));
  } else {
    console.log(`updateProfileByCustomerId(${customerId}) rows affected: ${count}`);
  }
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
      try {
        event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
      } catch (sigErr) {
        const msg = sigErr instanceof Error ? sigErr.message : String(sigErr);
        console.error("Webhook signature verification failed:", msg);
        return new Response(JSON.stringify({ error: "Invalid signature" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      console.warn("No webhook secret configured — skipping signature verification");
      event = JSON.parse(body) as Stripe.Event;
    }

    console.log(`Processing event: ${event.type} id=${event.id}`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = session.customer as string;
      const subscriptionId = session.subscription as string | null;

      console.log(`checkout.session.completed: customer=${customerId} subscription=${subscriptionId}`);
      console.log(`session.metadata: ${JSON.stringify(session.metadata)}`);

      // Get userId from session metadata (set directly on session for fallback)
      let userId = session.metadata?.supabase_user_id ?? null;
      let priceId: string | null = null;
      let plan = "free";
      let renewalDate: string | null = null;
      let subscriptionStatus = "active";

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        console.log(`subscription.metadata: ${JSON.stringify(subscription.metadata)}`);
        console.log(`subscription.status: ${subscription.status}`);

        // Prefer userId from subscription metadata (set via subscription_data.metadata in checkout)
        if (!userId && subscription.metadata?.supabase_user_id) {
          userId = subscription.metadata.supabase_user_id;
        }

        priceId = subscription.items.data[0]?.price.id ?? null;
        plan = priceId ? planFromPriceId(priceId) : "free";
        renewalDate = new Date(subscription.current_period_end * 1000).toISOString().split("T")[0];
        subscriptionStatus = subscription.status;

        console.log(`Resolved: userId=${userId} priceId=${priceId} plan=${plan} renewal=${renewalDate}`);
      }

      // If still no userId, look up by customer email
      if (!userId && session.customer_details?.email) {
        const email = session.customer_details.email;
        console.log(`No userId in metadata, looking up by email: ${email}`);
        const { data: authUser } = await supabase.auth.admin.listUsers();
        const matched = authUser?.users?.find((u) => u.email === email);
        if (matched) {
          userId = matched.id;
          console.log(`Found userId by email: ${userId}`);
        }
      }

      const fields = {
        stripe_customer_id: customerId,
        plan,
        subscription_status: subscriptionStatus,
        plan_renewal_date: renewalDate,
      };

      if (userId) {
        await updateProfileByUserId(supabase, userId, fields);
      } else {
        console.log(`Falling back to customer ID lookup: ${customerId}`);
        await updateProfileByCustomerId(supabase, customerId, fields);
      }
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;
      const userId = subscription.metadata?.supabase_user_id ?? null;
      const priceId = subscription.items.data[0]?.price.id ?? null;
      const plan = priceId ? planFromPriceId(priceId) : "free";
      const renewalDate = new Date(subscription.current_period_end * 1000).toISOString().split("T")[0];

      console.log(`customer.subscription.updated: customer=${customerId} userId=${userId} priceId=${priceId} plan=${plan} status=${subscription.status}`);

      const fields = {
        plan,
        subscription_status: subscription.status,
        plan_renewal_date: renewalDate,
      };

      if (userId) {
        await updateProfileByUserId(supabase, userId, fields);
      } else {
        await updateProfileByCustomerId(supabase, customerId, fields);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;
      const userId = subscription.metadata?.supabase_user_id ?? null;

      console.log(`customer.subscription.deleted: customer=${customerId} userId=${userId}`);

      const fields = { plan: "free", subscription_status: "inactive", plan_renewal_date: null };

      if (userId) {
        await updateProfileByUserId(supabase, userId, fields);
      } else {
        await updateProfileByCustomerId(supabase, customerId, fields);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Unhandled webhook error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
