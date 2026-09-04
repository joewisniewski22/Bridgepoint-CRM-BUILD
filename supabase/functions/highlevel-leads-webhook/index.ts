// GoHighLevel -> CRM. HighLevel's own "Webhook" workflow action can POST a
// contact's data straight here the moment a lead comes in from whatever
// form/source is configured in HighLevel -- no OAuth, no developer app,
// just a URL. Field names aren't perfectly standardized across HighLevel
// accounts/workflow configs, so this checks several common variants and
// always preserves the full raw payload in the activity log, so nothing is
// silently lost even for fields we don't have a dedicated mapping for yet.
//
// Same deliberate choice as the Meta webhook: no LO routing here, every
// lead defaults to the owner until the source-based routing rule is
// actually built (see [[project-lead-routing-rules]] equivalent).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("HIGHLEVEL_WEBHOOK_TOKEN")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function firstOf(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token !== WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();

    const firstName = firstOf(body, "first_name", "firstName");
    const lastName = firstOf(body, "last_name", "lastName");
    const fullName = firstOf(body, "full_name", "fullName", "name", "contact_name") ||
      [firstName, lastName].filter(Boolean).join(" ") || "HighLevel Lead";
    const email = firstOf(body, "email", "email_address");
    const phone = firstOf(body, "phone", "phone_number", "phoneNumber");
    const sourceTag = firstOf(body, "source", "lead_source", "contact_source") || "Website";

    const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const row = {
      id, name: fullName, email: email || null, phone: phone || null,
      source: sourceTag, loan_type: null, stage: "new", status: "active",
      assigned_to: "owner", created_at: today,
      entity_type: "LLC", application_token: crypto.randomUUID(),
      activity: [
        { date: today, type: "note", text: "Lead captured from GoHighLevel via webhook", author: "System" },
        { date: today, type: "note", text: "Raw payload: " + JSON.stringify(body), author: "System" },
      ],
    };

    const { error } = await sb.from("leads").insert(row);
    if (error) {
      console.error("highlevel-leads-webhook: insert failed", error.message);
      return new Response(JSON.stringify({ error: "insert_failed", detail: error.message }), { status: 500, headers: CORS_HEADERS });
    }

    const link = CRM_URL + "?lead=" + id;
    const alertText = "🔥 New HighLevel lead: " + fullName + " — open & dial: " + link;
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: id,
      kind: "hot-lead", text: alertText, date: today, read: false,
    });
    const { data: owner } = await sb.from("users").select("phone,email").eq("id", "owner").single();
    if (owner?.phone) {
      fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: owner.phone, text: alertText, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    if (owner?.email) {
      fetch(SUPABASE_URL + "/functions/v1/send-email", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: owner.email, subject: "New HighLevel lead: " + fullName, text: alertText, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, leadId: id }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
