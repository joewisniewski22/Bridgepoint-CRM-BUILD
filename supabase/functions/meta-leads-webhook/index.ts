// Facebook/Instagram Lead Ads (Instant Forms) -> CRM, directly -- no HighLevel.
// Joe 2026-10-07: "I don't use HighLevel anymore ... route those Spanish leads directly
// to our system." Meta's webhook only sends a leadgen_id; this fetches the answers from
// the Graph API, then creates the loan file the same way every other inbound source does:
// routed LO, hot-lead alert, and an instant AI first text/email to the borrower.
//
// Routing: Spanish forms (form locale es_* or "Spanish"/"Español" in the form name) ->
// Fanis, preferred_language es. Everything else -> the English ad rotation below.
// Dedupe: a phone/email already on a file from the last 3 days is not re-created (while
// HighLevel is still connected, the same Spanish lead arrives through both paths).
//
// Tokens: uses META_PAGE_ACCESS_TOKEN if set, otherwise derives the page token from the
// system-user token (META_ACCESS_TOKEN) -- needs leads_retrieval + pages_manage_metadata.
//
// POST { action: "setup", secret }  -- subscribes the app webhook + the page to leadgen
// POST { action: "status", secret } -- reports token permissions + subscriptions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const META_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN")!;
const META_PAGE_ACCESS_TOKEN = Deno.env.get("META_PAGE_ACCESS_TOKEN") || "";
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN") || "";
const META_APP_ID = Deno.env.get("META_APP_ID") || "";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const META_PAGE_ID = Deno.env.get("META_PAGE_ID") || "";
const GRAPH = "https://graph.facebook.com/v21.0";
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const CLIENT_URL = "https://app.bplending.com/";
const SPANISH_LO = "lo-fanis";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// English ad-lead routing (Joe, 2026-10-03): 30% to Joe, the rest split evenly
// between Fiore, Taeya and Theresa. Deterministic: each new lead goes to whoever is
// furthest below their target share of the ad leads created since ROUTING_START.
const ROUTING_START = "2026-10-03";
const ROUTE_TARGETS: Array<{ id: string; weight: number }> = [
  { id: "owner", weight: 0.30 },
  { id: "lo-fiore", weight: 0.70 / 3 },
  { id: "lo-taeya", weight: 0.70 / 3 },
  { id: "lo-theresa", weight: 0.70 / 3 },
];
async function pickEnglishAdLO(): Promise<string> {
  const { data } = await sb.from("leads").select("assigned_to")
    .gte("created_at", ROUTING_START).or("source.like.Meta Ads*,source.like.Website*").in("assigned_to", ROUTE_TARGETS.map((r) => r.id));
  const counts: Record<string, number> = {};
  (data || []).forEach((r: Record<string, unknown>) => { counts[r.assigned_to as string] = (counts[r.assigned_to as string] || 0) + 1; });
  const total = (data || []).length;
  let best = ROUTE_TARGETS[0], bestDeficit = -Infinity;
  for (const r of ROUTE_TARGETS) {
    const deficit = r.weight * (total + 1) - (counts[r.id] || 0);
    if (deficit > bestDeficit + 1e-9) { best = r; bestDeficit = deficit; }
  }
  return best.id;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const post = (fn: string, payload: Record<string, unknown>) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload),
}).catch(() => null);

let pageTokenCache: { pageId: string; token: string } | null = null;
async function pageToken(pageId: string): Promise<string> {
  if (META_PAGE_ACCESS_TOKEN) return META_PAGE_ACCESS_TOKEN;
  if (pageTokenCache && pageTokenCache.pageId === pageId) return pageTokenCache.token;
  if (!META_ACCESS_TOKEN || !pageId) return "";
  const r = await fetch(GRAPH + "/" + pageId + "?fields=access_token&access_token=" + encodeURIComponent(META_ACCESS_TOKEN)).then((x) => x.json()).catch(() => null);
  const t = r && r.access_token ? r.access_token : "";
  if (t) pageTokenCache = { pageId, token: t };
  return t;
}

type Field = { name: string; values: string[] };
function fv(fields: Field[], ...names: string[]): string | null {
  for (const n of names) {
    const f = fields.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (f && f.values && f.values.length) return f.values[0];
  }
  return null;
}
// Loan type from the form's own question (our forms ask it) or the form name.
function loanTypeFrom(fields: Field[], formName: string): string | null {
  const ans = (fv(fields, "loan_type", "tipo_de_prestamo", "tipo_de_préstamo", "what_type_of_loan", "deal_type") || "") + " " + formName;
  if (/dscr|rental|renta|alquiler/i.test(ans)) return "DSCR";
  if (/ground|construc/i.test(ans)) return "Ground Up Construction";
  if (/bridge|puente/i.test(ans)) return "Bridge";
  if (/flip|rehab|remodel|compra y venta/i.test(ans)) return "Fix & Flip";
  return null;
}
const digits10 = (s: string | null) => (s || "").replace(/\D/g, "").slice(-10);

async function processLeadgenId(leadgenId: string, pageId: string, formId: string, adId: string) {
  const token = await pageToken(pageId || META_PAGE_ID);
  if (!token) { console.error("meta-leads-webhook: no page token (needs leads_retrieval on the system user token)", leadgenId); return; }
  const data = await fetch(GRAPH + "/" + leadgenId + "?fields=field_data,created_time,ad_name,campaign_name,form_id,is_organic&access_token=" + encodeURIComponent(token)).then((r) => r.json()).catch(() => null);
  if (!data || !data.field_data) { console.error("meta-leads-webhook: lead fetch failed", leadgenId, JSON.stringify(data)); return; }
  const form = await fetch(GRAPH + "/" + (formId || data.form_id) + "?fields=name,locale&access_token=" + encodeURIComponent(token)).then((r) => r.json()).catch(() => ({}));
  const formName: string = (form && form.name) || "";
  const spanish = /^es/i.test((form && form.locale) || "") || /spanish|español|espanol/i.test(formName);

  const fields: Field[] = data.field_data;
  const name = fv(fields, "full_name", "nombre_completo") || [fv(fields, "first_name"), fv(fields, "last_name")].filter(Boolean).join(" ") || "Facebook Lead";
  const email = fv(fields, "email", "correo_electrónico", "correo_electronico");
  const phone = fv(fields, "phone_number", "phone", "número_de_teléfono");
  const state = fv(fields, "state", "estado", "property_state");
  const loanType = loanTypeFrom(fields, formName);
  const dedicated = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "phone", "nombre_completo"]);
  const answers = fields.filter((f) => !dedicated.has(f.name.toLowerCase()) && f.values && f.values.length).map((f) => f.name.replace(/_/g, " ") + ": " + f.values.join(", "));
  const today = new Date().toISOString().slice(0, 10);
  const label = spanish ? "Facebook" : "Meta Ads — " + (loanType || "Lead Form");

  // Already on file (same phone/email in the last 3 days)? Note it, don't duplicate.
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const { data: recent } = await sb.from("leads").select("id, phone, email, activity, assigned_to").gte("created_at_ts", since);
  const dup = (recent || []).find((l: Record<string, unknown>) => (phone && digits10(l.phone as string) === digits10(phone)) || (email && String(l.email || "").toLowerCase() === email.toLowerCase()));
  if (dup) {
    const act = ((dup.activity as unknown[]) || []).concat([{ date: today, type: "note", author: "System", text: "Same person submitted a Facebook lead form (" + (formName || formId) + ") — already on this file." }]);
    await sb.from("leads").update({ activity: act }).eq("id", dup.id as string);
    return;
  }

  const assignee = spanish ? SPANISH_LO : await pickEnglishAdLO();
  const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
  const activity: Record<string, string>[] = [
    { date: today, type: "note", author: "System", text: "Lead captured from Facebook Instant Form \"" + (formName || formId) + "\"" + (data.campaign_name ? " · campaign " + data.campaign_name : "") + (data.ad_name ? " · ad " + data.ad_name : "") + " — routed to " + assignee + (spanish ? " (Spanish)" : "") },
    // Our forms carry the text/call consent disclaimer; the follow-up engine keys off this note.
    { date: today, type: "note", author: "System", text: "TCPA consent recorded — agreed to the contact disclaimer on Facebook form \"" + (formName || formId) + "\"" },
  ];
  if (answers.length) activity.push({ date: today, type: "note", author: "System", text: (spanish ? "Respuestas del formulario — " : "Form answers — ") + answers.join(" · ") });
  const row: Record<string, unknown> = {
    id, name, email: email || null, phone: phone || null, source: label, loan_type: loanType, stage: "new", status: "active",
    assigned_to: assignee, created_at: today, created_at_ts: new Date().toISOString(),
    preferred_language: spanish ? "es" : "en", ai_stage: "engaging", entity_type: "LLC", application_token: crypto.randomUUID(), activity,
  };
  void state; // the state answer stays in the form-answers note
  const { error } = await sb.from("leads").insert(row);
  if (error) { console.error("meta-leads-webhook: insert failed", leadgenId, error.message); return; }

  // Hot-lead alert to the LO.
  const alertText = "🔥 New Facebook lead" + (spanish ? " (Spanish)" : "") + ": " + name + (loanType ? " · " + loanType : "") + " — open & dial: " + CRM_URL + "?lead=" + id;
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: assignee, lead_id: id, kind: "hot-lead", text: alertText, date: today, read: false });
  const { data: lo } = await sb.from("users").select("id,name,email,phone,photo_url").eq("id", assignee).single();
  if (lo?.phone) await post("send-text", { to: lo.phone, text: alertText, fromName: "Bridgepoint CRM" });
  if (lo?.email) await post("send-email", { to: lo.email, subject: "New Facebook lead: " + name, text: alertText, fromName: "Bridgepoint CRM" });

  // Instant AI first contact to the borrower, from their LO.
  if (lo && ANTHROPIC_API_KEY && (phone || email)) {
    try {
      const booking = CLIENT_URL + "?book=" + assignee;
      const first = name.split(/\s+/)[0];
      const prompt = spanish
        ? "Eres " + lo.name + ", oficial de préstamos de Bridgepoint Lending (préstamos de negocio para inversionistas de bienes raíces, no residenciales). Un cliente acaba de llenar nuestro formulario de Facebook. Escríbele un primer mensaje corto (máximo 3-4 oraciones), cálido, en ESPAÑOL, sin emojis, sin prometer aprobación ni tasas. Agradécele por su nombre, muestra que leíste sus respuestas e invítalo a agendar una llamada rápida aquí: " + booking + " — o que responda con la dirección de la propiedad.\n\nNombre: " + first + "\nRespuestas:\n- " + (answers.join("\n- ") || "(ninguna)") + "\n\nResponde SOLO con el texto del mensaje."
        : "You are " + lo.name + ", a loan officer at Bridgepoint Lending (business-purpose real estate investor loans — not consumer mortgages). A real estate investor just filled out our Facebook form" + (loanType ? " for a " + loanType + " loan" : "") + ". Write a short first text (max 3 sentences, plain, friendly, no emojis, no promises of approval, no rates). Thank them by first name, show you read their answers, and invite them to grab a quick call here: " + booking + " — or just reply with the property address and you'll run numbers.\n\nFirst name: " + first + "\nTheir answers:\n- " + (answers.join("\n- ") || "(none)") + "\n\nReply with ONLY the message text.";
      const ai = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
      });
      const aj = await ai.json();
      const message: string = ai.ok ? (aj.content?.[0]?.text || "").trim() : "";
      if (message) {
        if (phone) await post("send-text", { leadId: id, to: phone, text: message, fromName: lo.name, initiatedBy: "ai" });
        if (email) await post("send-email", { leadId: id, to: email, subject: spanish ? "Bridgepoint Lending — Su solicitud de préstamo" : "Your loan request — Bridgepoint Lending", text: message, fromName: lo.name, fromAddress: lo.email, fromUserId: lo.id, fromPhotoUrl: lo.photo_url || null, initiatedBy: "ai" });
      }
    } catch (e) { console.error("meta-leads-webhook: AI first contact failed", String(e)); }
  }
}

async function authorized(body: Record<string, unknown>): Promise<boolean> {
  const { data } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  return !!(data && body.secret && body.secret === data.secret);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (req.method === "GET") {
    // Meta's webhook verification handshake.
    const mode = url.searchParams.get("hub.mode"), token = url.searchParams.get("hub.verify_token"), challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === META_VERIFY_TOKEN && challenge) return new Response(challenge, { status: 200, headers: { ...CORS, "Content-Type": "text/plain" } });
    return new Response("forbidden", { status: 403, headers: CORS });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_) { return json({ ok: true, note: "payload not processed" }); }

  // ---- admin actions (shared secret) ----
  if (body.action === "status" || body.action === "setup") {
    if (!(await authorized(body))) return json({ error: "not_authorized" }, 403);
    const appToken = META_APP_ID + "|" + META_APP_SECRET;
    const out: Record<string, unknown> = {};
    const perms = await fetch(GRAPH + "/me/permissions?access_token=" + encodeURIComponent(META_ACCESS_TOKEN)).then((r) => r.json()).catch(() => null);
    out.permissions = perms && perms.data ? perms.data.filter((p: any) => p.status === "granted").map((p: any) => p.permission) : perms;
    const pt = await pageToken(META_PAGE_ID);
    out.pageToken = pt ? "ok" : "missing";
    if (body.action === "setup") {
      const cb = SUPABASE_URL + "/functions/v1/meta-leads-webhook";
      out.appSubscription = await fetch(GRAPH + "/" + META_APP_ID + "/subscriptions", { method: "POST", body: new URLSearchParams({ object: "page", callback_url: cb, fields: "leadgen", verify_token: META_VERIFY_TOKEN, include_values: "true", access_token: appToken }) }).then((r) => r.json()).catch((e) => String(e));
      if (pt) out.pageSubscription = await fetch(GRAPH + "/" + META_PAGE_ID + "/subscribed_apps", { method: "POST", body: new URLSearchParams({ subscribed_fields: "leadgen", access_token: pt }) }).then((r) => r.json()).catch((e) => String(e));
    }
    out.appSubscriptions = await fetch(GRAPH + "/" + META_APP_ID + "/subscriptions?access_token=" + encodeURIComponent(appToken)).then((r) => r.json()).catch(() => null);
    if (pt) out.pageSubscribedApps = await fetch(GRAPH + "/" + META_PAGE_ID + "/subscribed_apps?access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch(() => null);
    const app = await fetch(GRAPH + "/" + META_APP_ID + "?fields=name&access_token=" + encodeURIComponent(appToken)).then((r) => r.json()).catch(() => null);
    out.app = app;
    return json(out);
  }

  // ---- Meta leadgen webhook ----
  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        const v = change.value || {};
        if (!v.leadgen_id) continue;
        // Process before answering (edge functions can stop once the response is sent).
        await processLeadgenId(v.leadgen_id, v.page_id, v.form_id, v.ad_id).catch((e) => console.error("meta-leads-webhook: processing error", e));
      }
    }
  } catch (err) { console.error("meta-leads-webhook: bad payload", String(err)); }
  return json({ ok: true });
});
