import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const WELCOME_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="margin:0 0 16px;">Hey,</p>

    <p style="margin:0 0 16px;">I'm Matt — I built PercIQ.</p>

    <p style="margin:0 0 16px;">I'm a land investor myself, and I got tired of guessing whether a parcel could pass a perc test before I'd already tied up money in it. That's the whole reason PercIQ exists: a fast pre-screen using real soil, flood, and slope data, before you spend on a real perc test.</p>

    <p style="margin:0 0 16px;">You've got 7 days and 3 free analyses to try it out. Here's how to get the most out of them:</p>

    <ol style="margin:0 0 16px;padding-left:24px;">
      <li style="margin-bottom:12px;"><a href="https://app.perciq.co" style="color:#2563eb;text-decoration:underline;">Run your first analysis</a> — drop in an address or parcel ID and you'll get a suitability score in seconds</li>
      <li style="margin-bottom:12px;"><a href="https://perciq.co" style="color:#2563eb;text-decoration:underline;">See how it works</a> — worth a skim so you know what "Viable" vs "Engineering Needed" actually means</li>
      <li style="margin-bottom:12px;">Reply to this email if anything's confusing or broken — I read and answer all of these myself</li>
    </ol>

    <p style="margin:0 0 16px;">P.S.: Ever had a deal die because a perc test failed after you were already under contract? That's exactly what I built this to prevent. Tell me your story — reply anytime.</p>

    <p style="margin:0;">Matt</p>
  </div>
</body>
</html>`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const result = { resend: false, kit: false };

  try {
    const { email, userId } = await req.json() as { email: string; userId: string };

    // (a) Resend welcome email — best effort, never blocks (b)
    try {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (!resendKey) {
        console.error("[welcome-email] RESEND_API_KEY not set — skipping email send", { userId });
      } else {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Matt from PercIQ <hello@mail.perciq.co>",
            to: email,
            subject: "Welcome to PercIQ — here's how to get started",
            html: WELCOME_HTML,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          console.error("[welcome-email] Resend API error", { status: res.status, body, userId });
        } else {
          result.resend = true;
        }
      }
    } catch (err) {
      console.error("[welcome-email] Resend threw", err instanceof Error ? err.message : String(err), { userId });
    }

    // (b) Kit CRM tag — best effort, never blocks (a)
    try {
      const kitKey = Deno.env.get("KIT_API_KEY");
      const kitTagId = Deno.env.get("KIT_TAG_ID");
      if (!kitKey) {
        console.error("[welcome-email] KIT_API_KEY not set — skipping Kit tagging", { userId });
      } else if (!kitTagId) {
        console.error("[welcome-email] KIT_TAG_ID not set — skipping Kit tagging", { userId });
      } else {
        // Create the subscriber first
        const createRes = await fetch("https://api.kit.com/v4/subscribers", {
          method: "POST",
          headers: {
            "X-Kit-Api-Key": kitKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email_address: email,
            state: "active",
            fields: { source: "PercIQ signup" },
          }),
        });
        if (!createRes.ok) {
          const body = await createRes.text();
          console.error("[welcome-email] Kit create subscriber error", { status: createRes.status, body, userId });
        } else {
          const created = await createRes.json() as { subscriber?: { id: number } };
          const subscriberId = created.subscriber?.id;
          if (!subscriberId) {
            console.error("[welcome-email] Kit create returned no subscriber id", { userId });
          } else {
            // Apply the tag
            const tagRes = await fetch(`https://api.kit.com/v4/tags/${kitTagId}/subscribers/${subscriberId}`, {
              method: "POST",
              headers: {
                "X-Kit-Api-Key": kitKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            });
            if (!tagRes.ok) {
              const body = await tagRes.text();
              console.error("[welcome-email] Kit tag subscriber error", { status: tagRes.status, body, userId });
            } else {
              result.kit = true;
            }
          }
        }
      }
    } catch (err) {
      console.error("[welcome-email] Kit threw", err instanceof Error ? err.message : String(err), { userId });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[welcome-email] handler threw", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ ...result, error: "internal" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
