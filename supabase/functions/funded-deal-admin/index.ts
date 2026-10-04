// Owner-only helpers for the "Website Posts" screen (funded-loan posts on bplending.com).
//   action "draft": writes a headline + short summary for a funded deal with AI (facts only; no names or street addresses)
//   action "image": fetches the Street View photo of the property once, stores it in public storage, returns its URL
// The caller must be signed in as the owner. Nothing here publishes anything -- approval happens in the CRM and is
// gated on the owner confirming the borrower's permission (funded_deals.borrower_ok).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MAPS_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") || "";
const MAPS_REFERER = "https://bridgepoint-crm-build.vercel.app/"; // the referrer this key is authorized for (our own CRM)
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

async function isOwner(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await sb.auth.getUser(token).catch(() => ({ data: null }));
  if (!data || !data.user) return false;
  const { data: u } = await sb.from("users").select("role").eq("auth_id", data.user.id).maybeSingle();
  return !!u && u.role === "owner";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await isOwner(req))) return json({ error: "not_authorized" }, 403);
  try {
    const b = await req.json();
    const { data: deal } = await sb.from("funded_deals").select("*").eq("id", String(b.dealId || "")).maybeSingle();
    if (!deal) return json({ error: "not_found" }, 404);

    if (b.action === "draft") {
      const { data: lead } = deal.lead_id ? await sb.from("leads").select("loan_type,property_type,transaction_type,term_months,purchase_price,rehab_budget,arv,experience_deals").eq("id", deal.lead_id).maybeSingle() : { data: null };
      const facts: string[] = [];
      if (deal.loan_type) facts.push("Loan program: " + deal.loan_type);
      if (deal.property_type) facts.push("Property type: " + deal.property_type);
      if (deal.city || deal.state) facts.push("Location: " + [deal.city, deal.state].filter(Boolean).join(", "));
      if (deal.show_amount && deal.loan_amount) facts.push("Loan amount: $" + Math.round(deal.loan_amount).toLocaleString("en-US"));
      if (deal.funded_date) facts.push("Funded: " + deal.funded_date);
      if (lead?.transaction_type) facts.push("Purpose: " + ({ purchase: "purchase", ratetermrefi: "rate/term refinance", cashout: "cash-out refinance" } as Record<string, string>)[lead.transaction_type] || lead.transaction_type);
      if (lead?.term_months) facts.push("Term: " + lead.term_months + " months");
      const prompt = "You write short funded-loan posts for BridgePoint Lending's website (business-purpose real estate investor loans). " +
        "Write a headline (max 70 characters) and a summary of 70-110 words in plain, factual, friendly language, using ONLY the facts below. " +
        "Rules: never name the borrower; never give a street address; do not state an interest rate, points, fees or approval promises; do not invent numbers, timelines, results or quotes; " +
        "no superlatives like 'best' or 'fastest'; do not use the word 'broker'; mention the city and state; end by inviting investors with a similar deal to get a quote. " +
        "Return ONLY JSON: {\"headline\":\"...\",\"summary\":\"...\"}\n\nFacts:\n- " + facts.join("\n- ");
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] }) });
      const d = await r.json();
      const txt: string = d?.content?.[0]?.text || "";
      const m = txt.match(/\{[\s\S]*\}/);
      if (!r.ok || !m) return json({ error: "ai_failed" }, 502);
      const out = JSON.parse(m[0]);
      return json({ ok: true, headline: String(out.headline || "").slice(0, 120), summary: String(out.summary || "").slice(0, 1200) });
    }

    if (b.action === "image") {
      if (!MAPS_KEY) return json({ error: "no_maps_key", detail: "Google Maps key is not configured for the website." }, 400);
      if (!deal.lead_id) return json({ error: "no_lead" }, 400);
      const { data: lead } = await sb.from("leads").select("property_address").eq("id", deal.lead_id).maybeSingle();
      const addr = lead?.property_address;
      if (!addr) return json({ error: "no_address" }, 400);
      const meta = await fetch("https://maps.googleapis.com/maps/api/streetview/metadata?location=" + encodeURIComponent(addr) + "&key=" + MAPS_KEY, { headers: { Referer: MAPS_REFERER } }).then((r) => r.json()).catch(() => null);
      if (!meta || meta.status !== "OK") return json({ error: "no_coverage", detail: "Google has no Street View photo for this address (" + (meta?.status || "error") + ")." }, 404);
      const img = await fetch("https://maps.googleapis.com/maps/api/streetview?size=1200x750&fov=80&source=outdoor&location=" + encodeURIComponent(addr) + "&key=" + MAPS_KEY, { headers: { Referer: MAPS_REFERER } });
      if (!img.ok) return json({ error: "image_failed", detail: "Google returned " + img.status }, 502);
      const bytes = new Uint8Array(await img.arrayBuffer());
      const path = "funded/" + deal.id + ".jpg";
      const up = await sb.storage.from("public-assets").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) return json({ error: "upload_failed", detail: up.error.message }, 500);
      return json({ ok: true, url: SUPABASE_URL + "/storage/v1/object/public/public-assets/" + path + "?v=" + Date.now() });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("funded-deal-admin", String(e));
    return json({ error: "server_error" }, 500);
  }
});
