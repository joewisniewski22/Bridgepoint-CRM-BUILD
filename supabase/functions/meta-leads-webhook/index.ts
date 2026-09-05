// Facebook/Instagram Lead Ads -> CRM. Meta's webhook only ever sends a
// leadgen_id, never the actual answers -- this fetches the real field data
// from the Graph API using the Page Access Token, then creates a real loan
// file. Source-based routing to specific LOs (Spanish-language ads ->
// David/Fanis, Connected Investors/PrivateLenders -> Joe/Fiore) is a
// deliberate follow-up, not built here -- every lead lands on the owner
// until that's wired in, matching how manual/import lead creation has
// always defaulted ("default to me until I change it").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN")!;
const META_PAGE_ACCESS_TOKEN = Deno.env.get("META_PAGE_ACCESS_TOKEN") || "";
const GRAPH_VERSION = "v21.0";
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function fieldValue(fieldData: Array<{ name: string; values: string[] }>, ...names: string[]): string | null {
  for (const n of names) {
    const f = fieldData.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (f && f.values && f.values.length) return f.values[0];
  }
  return null;
}

async function processLeadgenId(leadgenId: string, pageId: string, formId: string, adId: string) {
  if (!META_PAGE_ACCESS_TOKEN) {
    console.error("meta-leads-webhook: META_PAGE_ACCESS_TOKEN not set, cannot fetch lead", leadgenId);
    return;
  }
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}?access_token=${encodeURIComponent(META_PAGE_ACCESS_TOKEN)}`
  );
  const data = await res.json();
  if (!res.ok || !data.field_data) {
    console.error("meta-leads-webhook: graph API fetch failed", leadgenId, JSON.stringify(data));
    return;
  }

  const fields: Array<{ name: string; values: string[] }> = data.field_data;
  const fullName = fieldValue(fields, "full_name") ||
    [fieldValue(fields, "first_name"), fieldValue(fields, "last_name")].filter(Boolean).join(" ") ||
    "Facebook Lead";
  const email = fieldValue(fields, "email");
  const phone = fieldValue(fields, "phone_number", "phone");

  // Everything else Meta collected, in case the form has custom questions
  // with no dedicated CRM field yet -- kept as one readable note, not a
  // raw dump, matching how the HighLevel webhook handles the same problem.
  const dedicated = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "phone"]);
  const extraAnswers = fields.filter((f) => !dedicated.has(f.name.toLowerCase()) && f.values && f.values.length)
    .map((f) => f.name + ": " + f.values.join(", ")).join(" · ");

  const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const activity: Record<string, string>[] = [
    { date: today, type: "note", text: "Lead captured from Facebook/Instagram Lead Ad (form " + formId + ", ad " + adId + ")", author: "System" },
  ];
  if (extraAnswers) activity.push({ date: today, type: "note", text: "Form answers — " + extraAnswers, author: "System" });
  const row = {
    id, name: fullName, email: email || null, phone: phone || null,
    source: "Meta Ads", loan_type: null, stage: "new", status: "active",
    assigned_to: "owner", created_at: today,
    // Enrolls this lead in the same AI conversion-texting automation every
    // other inbound source uses (see index.html's startAiEngagement / the
    // highlevel-leads-webhook) -- routing here still defaults everyone to
    // owner (see file header), so this stays English-first like any other
    // non-Spanish-specific source; the automation asks language itself if
    // the assignee ever becomes a bilingual LO.
    ai_stage: "engaging",
    entity_type: "LLC", application_token: crypto.randomUUID(),
    activity,
  };

  const { error } = await sb.from("leads").insert(row);
  if (error) {
    console.error("meta-leads-webhook: lead insert failed", leadgenId, error.message);
    return;
  }

  const link = CRM_URL + "?lead=" + id;
  const alertText = "🔥 New Facebook lead: " + fullName + " — open & dial: " + link;
  await sb.from("notifications").insert({
    id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: id,
    kind: "hot-lead", text: alertText, date: today, read: false,
  });
  const { data: owner } = await sb.from("users").select("phone,email,quo_phone_number").eq("id", "owner").single();
  if (owner?.phone) {
    fetch(SUPABASE_URL + "/functions/v1/send-text", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ to: owner.phone, text: alertText, fromName: "Bridgepoint CRM" }),
    }).catch(() => {});
  }
  if (owner?.email) {
    fetch(SUPABASE_URL + "/functions/v1/send-email", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ to: owner.email, subject: "New Facebook lead: " + fullName, text: alertText, fromName: "Bridgepoint CRM" }),
    }).catch(() => {});
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const url = new URL(req.url);

  if (req.method === "GET") {
    // Meta's one-time webhook verification handshake.
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === META_VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json();
    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const v = change.value || {};
        if (!v.leadgen_id) continue;
        // Don't await inline -- Meta expects a fast 200 OK, process after.
        processLeadgenId(v.leadgen_id, v.page_id, v.form_id, v.ad_id).catch((e) => console.error("meta-leads-webhook: processing error", e));
      }
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("meta-leads-webhook: bad payload", String(err));
    // Still 200 -- Meta will retry aggressively on non-200s, and a bad
    // payload won't parse any better on retry.
    return new Response(JSON.stringify({ ok: true, note: "payload not processed" }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
