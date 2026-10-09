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
function translateAnswers(fields: Field[], questions: any[]): Field[] {
  const byKey: Record<string, Record<string, string>> = {};
  for (const q of questions || []) if (q && q.key && Array.isArray(q.options)) byKey[String(q.key).toLowerCase()] = Object.fromEntries(q.options.map((o: any) => [String(o.key), String(o.value)]));
  return (fields || []).map((f) => {
    const opts = byKey[String(f.name || "").toLowerCase()];
    return opts ? { ...f, values: (f.values || []).map((v) => opts[String(v)] || v) } : f;
  });
}
// Real Meta ad ids are long numbers; anything else (e.g. "1" from a test/organic event) is ignored.
const realAdId = (...ids: unknown[]) => ids.map((x) => String(x || "")).find((x) => /^\d{10,}$/.test(x)) || "";

async function processLeadgenId(leadgenId: string, pageId: string, formId: string, adId: string) {
  const token = await pageToken(pageId || META_PAGE_ID);
  if (!token) { console.error("meta-leads-webhook: no page token (needs leads_retrieval on the system user token)", leadgenId); return; }
  const data = await fetch(GRAPH + "/" + leadgenId + "?fields=field_data,created_time,ad_id,ad_name,campaign_name,form_id,is_organic&access_token=" + encodeURIComponent(token)).then((r) => r.json()).catch(() => null);
  if (!data || !data.field_data) { console.error("meta-leads-webhook: lead fetch failed", leadgenId, JSON.stringify(data)); return; }
  const form = await fetch(GRAPH + "/" + (formId || data.form_id) + "?fields=name,locale,questions&access_token=" + encodeURIComponent(token)).then((r) => r.json()).catch(() => ({}));
  const formName: string = (form && form.name) || "";
  const spanish = /^es/i.test((form && form.locale) || "") || /spanish|español|espanol/i.test(formName);

  // Multiple-choice answers come back as the option KEY (e.g. "o4"), not its text (10/9:
  // Smithie Lu's file read "credit score: o4"). Translate keys to the option text.
  const fields: Field[] = translateAnswers(data.field_data, (form && form.questions) || []);
  const name = fv(fields, "full_name", "nombre_completo") || [fv(fields, "first_name"), fv(fields, "last_name")].filter(Boolean).join(" ") || "Facebook Lead";
  const email = fv(fields, "email", "correo_electrónico", "correo_electronico");
  const phone = fv(fields, "phone_number", "phone", "número_de_teléfono");
  const state = fv(fields, "state", "estado", "property_state");
  const loanType = loanTypeFrom(fields, formName);
  const dedicated = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "phone", "nombre_completo"]);
  const answers = fields.filter((f) => !dedicated.has(f.name.toLowerCase()) && f.values && f.values.length).map((f) => f.name.replace(/_/g, " ") + ": " + f.values.join(", "));
  const today = new Date().toISOString().slice(0, 10);
  const label = spanish ? "Facebook" : "Meta Ads — " + (loanType || "Lead Form");

  // Meta test leads (Lead Ads Testing Tool / POST {form}/test_leads) carry placeholder
  // answers like "<test lead: dummy data for email>". Record them so the pipe can be
  // verified end to end, but as spam with automation off: no LO alert, no texts, no AI.
  const isTest = fields.some((f) => (f.values || []).some((v) => /test lead|dummy data/i.test(String(v))));
  if (isTest) {
    await sb.from("leads").insert({
      id: "LTEST" + crypto.randomUUID().slice(0, 6).toUpperCase(), name: "TEST — Facebook form " + (formName || formId), source: label, loan_type: loanType,
      stage: "spam", status: "spam", assigned_to: "owner", created_at: today, created_at_ts: new Date().toISOString(),
      preferred_language: spanish ? "es" : "en", automation_paused: true, entity_type: "LLC", application_token: crypto.randomUUID(),
      activity: [{ date: today, type: "note", author: "System", text: "Meta TEST lead (leadgen " + leadgenId + ") — pipe verified; would have routed to " + (spanish ? SPANISH_LO : "the English rotation") + ". No alerts or messages sent." }],
    });
    return;
  }

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
    // ad_id= lets the ad optimizer score each ad on real CRM outcomes (apps, closings).
    { date: today, type: "note", author: "System", text: "Lead captured from Facebook Instant Form \"" + (formName || formId) + "\"" + (data.campaign_name ? " · campaign " + data.campaign_name : "") + (data.ad_name ? " · ad " + data.ad_name : "") + (realAdId(data.ad_id, adId) ? " · ad_id=" + realAdId(data.ad_id, adId) : "") + " — routed to " + assignee + (spanish ? " (Spanish)" : "") },
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

// ---------------------------------------------------------------------------
// Comments + DMs on OUR Facebook page and Instagram (Joe 2026-10-07: capture social leads
// automatically). AI scores intent (bots, spam, brokers, consumer home-buyers -> ignored);
// real investors become leads, the LO is alerted, and they get ONE private reply with a
// Deal Analyzer link tied to their file (their submission fills in phone/email).
// ---------------------------------------------------------------------------
const BOT_RE = /(dm me|check (my|our) (bio|page)|whats ?app|telegram|crypto|bitcoin|forex|investment opportunity|earn \$|guaranteed (approval|funding)|we (fund|lend)|click (the )?link)/i;
type SocialEvt = { platform: "facebook" | "instagram"; kind: "comment" | "dm"; externalId: string; fromId: string; name?: string | null; username?: string | null; text: string; commentId?: string | null; pageId: string };

async function socialClassify(text: string, platform: string) {
  const r = await fetch(SUPABASE_URL + "/functions/v1/social-intake", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify({ action: "classify", text, platform }) }).then((x) => x.json()).catch(() => null);
  return (r && r.result) || { intent: "low", loan_type: null, summary: text.slice(0, 140), reply: "" };
}
async function sendPageMessage(pageId: string, recipient: Record<string, string>, text: string): Promise<boolean> {
  const token = await pageToken(pageId);
  if (!token) return false;
  const r = await fetch(GRAPH + "/" + pageId + "/messages?access_token=" + encodeURIComponent(token), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient, messaging_type: "RESPONSE", message: { text: text.slice(0, 1900) } }),
  }).then((x) => x.json()).catch(() => null);
  if (!r || r.error) { console.error("meta-leads-webhook: reply failed", JSON.stringify(r)); return false; }
  return true;
}
async function handleSocial(e: SocialEvt) {
  const text = (e.text || "").trim();
  if (!text || e.fromId === e.pageId) return;
  const today = new Date().toISOString().slice(0, 10);
  const label = (e.platform === "facebook" ? "Facebook" : "Instagram") + (e.kind === "dm" ? " DM" : " comment");
  // Ongoing DM conversation with someone already on file: add to their file, alert the LO.
  const { data: prior } = await sb.from("social_prospects").select("id, lead_id, status").eq("external_id", e.externalId).maybeSingle();
  if (prior && prior.lead_id) {
    const { data: l } = await sb.from("leads").select("id, name, activity, assigned_to").eq("id", prior.lead_id).maybeSingle();
    if (l) {
      const act = ((l.activity as unknown[]) || []).concat([{ date: today, at: new Date().toISOString(), type: "note", author: l.name, text: "Messaged us on " + label.replace(/ (DM|comment)$/, "") + ": " + text.slice(0, 600) }]);
      await sb.from("leads").update({ activity: act }).eq("id", l.id);
      if (l.assigned_to) await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: l.assigned_to, lead_id: l.id, kind: "social", text: "💬 " + l.name + " messaged on " + label + ": " + text.slice(0, 120), date: today, read: false });
    }
    return;
  }
  if (prior) return; // already screened out
  // Cheap bot / spam screen before spending an AI call.
  const urlChars = (text.match(/https?:\/\/\S+/g) || []).join("").length;
  if (text.length < 12 || BOT_RE.test(text) || urlChars > text.length * 0.4) {
    await sb.from("social_prospects").insert({ id: "SP" + crypto.randomUUID().slice(0, 10), platform: e.platform, kind: e.kind, handle: e.username || e.name || null, display_name: e.name || e.username || null, external_id: e.externalId, text: text.slice(0, 4000), intent: "none", status: "dismissed", summary: "Filtered as bot/spam" });
    return;
  }
  const c = await socialClassify(text, e.platform);
  if (c.intent !== "high" && c.intent !== "medium") {
    await sb.from("social_prospects").insert({ id: "SP" + crypto.randomUUID().slice(0, 10), platform: e.platform, kind: e.kind, handle: e.username || e.name || null, display_name: e.name || e.username || null, external_id: e.externalId, text: text.slice(0, 4000), intent: c.intent, status: "dismissed", summary: c.summary });
    return;
  }
  // A real investor: create the lead.
  let name = e.name || e.username || null;
  if (!name && e.kind === "dm") {
    const token = await pageToken(e.pageId);
    const prof = token ? await fetch(GRAPH + "/" + e.fromId + "?fields=name,username&access_token=" + encodeURIComponent(token)).then((x) => x.json()).catch(() => null) : null;
    name = (prof && (prof.name || prof.username)) || null;
  }
  name = name || label + " lead";
  const spanish = !!c.spanish;
  const assignee = spanish ? SPANISH_LO : await pickEnglishAdLO();
  const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
  await sb.from("leads").insert({
    id, name, source: "Meta Ads — " + label, loan_type: c.loan_type, stage: "new", status: "active", assigned_to: assignee,
    created_at: today, created_at_ts: new Date().toISOString(), preferred_language: spanish ? "es" : "en", entity_type: "LLC", application_token: crypto.randomUUID(),
    activity: [
      { date: today, type: "note", author: "System", text: "Captured from a " + label + (e.username ? " (@" + e.username + ")" : "") + " — " + c.summary },
      { date: today, at: new Date().toISOString(), type: "note", author: name, text: "Their " + (e.kind === "dm" ? "message" : "comment") + ": " + text.slice(0, 800) },
    ],
  });
  await sb.from("social_prospects").insert({ id: "SP" + crypto.randomUUID().slice(0, 10), platform: e.platform, kind: e.kind, handle: e.username || name, display_name: name, external_id: e.externalId, text: text.slice(0, 4000), intent: c.intent, loan_type: c.loan_type, summary: c.summary, ai_reply: c.reply, status: "converted", lead_id: id, assigned_to: assignee });
  // One private reply with a Deal Analyzer link tied to their file.
  const link = "https://bplending.com/deal-analyzer/?ref=" + id + "&utm_source=" + e.platform + "&utm_medium=social&utm_campaign=" + e.kind + "-capture";
  const msg = (c.reply || (spanish ? "¡Gracias por escribirnos! Con gusto le ayudamos con el financiamiento." : "Thanks for reaching out — happy to help with financing on this.")) +
    "\n\n" + (spanish ? "Calcule su préstamo en 2 minutos (nosotros le damos seguimiento): " : "Run your numbers in 2 minutes and we'll follow up with real terms: ") + link;
  const sent = await sendPageMessage(e.pageId, e.kind === "comment" && e.commentId ? { comment_id: e.commentId } : { id: e.fromId }, msg);
  const { data: lead } = await sb.from("leads").select("activity").eq("id", id).single();
  const act = ((lead && lead.activity) as unknown[] || []).concat([{ date: today, at: new Date().toISOString(), type: "note", author: "System", text: sent ? "Auto-replied privately on " + label.replace(/ (DM|comment)$/, "") + " with a Deal Analyzer link (their submission adds phone/email here)." : "Couldn't auto-reply on " + label + " — reply by hand: " + c.reply }]);
  await sb.from("leads").update({ activity: act }).eq("id", id);
  const alert = "🔥 New " + label + " lead: " + name + (c.loan_type ? " · " + c.loan_type : "") + " — " + c.summary + " " + CRM_URL + "?lead=" + id;
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: assignee, lead_id: id, kind: "hot-lead", text: alert, date: today, read: false });
  const { data: lo } = await sb.from("users").select("phone").eq("id", assignee).single();
  if (lo?.phone) await post("send-text", { to: lo.phone, text: alert, fromName: "Bridgepoint CRM" });
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
  // forms: list the Page's lead forms. test-lead: fire a Meta test lead on one form
  // (replaces any earlier test lead on it) so the whole pipe can be checked.
  // stats: follower counts for the growth plan (Page + linked Instagram).
  if (body.action === "stats") {
    if (!(await authorized(body))) return json({ error: "not_authorized" }, 403);
    const pt = await pageToken(META_PAGE_ID);
    const page = await fetch(GRAPH + "/" + META_PAGE_ID + "?fields=name,fan_count,followers_count,instagram_business_account{username,followers_count,follows_count,media_count}&access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch((e) => String(e));
    const posts = await fetch(GRAPH + "/" + META_PAGE_ID + "/posts?fields=created_time,message,shares&limit=25&access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch((e) => String(e));
    return json({ page, recentPosts: posts && posts.data ? posts.data.map((p: any) => ({ t: p.created_time, shares: p.shares ? p.shares.count : 0, msg: String(p.message || "").slice(0, 80) })) : posts });
  }
  // create-form: a new instant form on the Page from a full spec (name, questions, privacy
  // URL, consent disclaimer, thank-you page). Forms don't spend money or show to anyone
  // until an ad uses them.
  if (body.action === "create-form") {
    if (!(await authorized(body))) return json({ error: "not_authorized" }, 403);
    const pt = await pageToken(META_PAGE_ID);
    if (!pt) return json({ error: "no_page_token" }, 500);
    const spec = body.spec || {};
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec)) params[k] = typeof v === "string" ? v : JSON.stringify(v);
    params.access_token = pt;
    const made = await fetch(GRAPH + "/" + META_PAGE_ID + "/leadgen_forms", { method: "POST", body: new URLSearchParams(params) }).then((r) => r.json()).catch((e) => String(e));
    return json(made);
  }
  // repair-answers: rewrite "Form answers / Respuestas" notes saved with option keys
  // ("option_2", "o4") into the option text, using the form's own questions.
  if (body.action === "repair-answers") {
    if (!(await authorized(body))) return json({ error: "not_authorized" }, 403);
    const pt = await pageToken(META_PAGE_ID);
    const forms = await fetch(GRAPH + "/" + META_PAGE_ID + "/leadgen_forms?fields=id,name,questions&limit=50&access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch(() => null);
    const byLabel: Record<string, Record<string, string>> = {};
    for (const fm of (forms && forms.data) || []) for (const q of fm.questions || []) {
      if (!q || !q.key || !Array.isArray(q.options)) continue;
      byLabel[String(q.key).replace(/_/g, " ").toLowerCase()] = Object.fromEntries(q.options.map((o: any) => [String(o.key), String(o.value)]));
    }
    const { data: leads } = await sb.from("leads").select("id, activity").or("source.eq.Facebook,source.like.Meta Ads*");
    let fixed = 0;
    for (const l of leads || []) {
      let changed = false;
      const act = ((l.activity as any[]) || []).map((a) => {
        const t = String(a && a.text || "");
        const m = t.match(/^(Form answers — |Respuestas del formulario — )(.*)$/s);
        if (!m) return a;
        const parts = m[2].split(" · ").map((p) => {
          const i = p.lastIndexOf(": ");
          if (i < 0) return p;
          const opts = byLabel[p.slice(0, i).toLowerCase()];
          if (!opts) return p;
          const vals = p.slice(i + 2).split(", ").map((v) => opts[v] || v).join(", ");
          return p.slice(0, i) + ": " + vals;
        });
        const nt = m[1] + parts.join(" · ");
        if (nt !== t) { changed = true; return { ...a, text: nt }; }
        return a;
      });
      if (changed) { await sb.from("leads").update({ activity: act }).eq("id", l.id); fixed++; }
    }
    return json({ questionsMapped: Object.keys(byLabel).length, leadsFixed: fixed });
  }
  if (body.action === "forms" || body.action === "test-lead" || body.action === "backfill") {
    if (!(await authorized(body))) return json({ error: "not_authorized" }, 403);
    const pt = await pageToken(META_PAGE_ID);
    if (!pt) return json({ error: "no_page_token" }, 500);
    if (body.action === "forms" && /^\d+$/.test(String(body.formId || ""))) {
      const one = await fetch(GRAPH + "/" + body.formId + "?fields=name,status,locale,questions,privacy_policy_url,legal_content,context_card,thank_you_page,is_optimized_for_quality,leads_count&access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch((e) => String(e));
      return json(one);
    }
    if (body.action === "forms") {
      const f = await fetch(GRAPH + "/" + META_PAGE_ID + "/leadgen_forms?fields=id,name,locale,status,leads_count,created_time&limit=50&access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch((e) => String(e));
      return json(f);
    }
    const formId = String(body.formId || "");
    if (!/^\d+$/.test(formId)) return json({ error: "formId required" }, 400);
    if (body.action === "backfill") {
      // Joe 2026-10-08: "have the facebook leads all land directly to our crm including the
      // existing spanish ones". Pull the form's lead history from Meta and compare with every
      // file in the CRM (any age) by phone/email. dryRun lists what's missing; otherwise the
      // missing ones are imported QUIETLY: no LO alert, no AI text (they're old), routed the
      // same way as live leads, with a note saying they came from the form history.
      const all: any[] = [];
      let next = GRAPH + "/" + formId + "/leads?fields=id,created_time,field_data,ad_name,campaign_name,is_organic&limit=100&access_token=" + encodeURIComponent(pt);
      for (let i = 0; next && i < 30; i++) {
        const pg = await fetch(next).then((r) => r.json()).catch(() => null);
        if (!pg || !pg.data) break;
        all.push(...pg.data);
        next = pg.paging && pg.paging.next ? pg.paging.next : "";
      }
      const form = await fetch(GRAPH + "/" + formId + "?fields=name,locale,questions&access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch(() => ({}));
      const formName: string = (form && form.name) || "";
      const spanish = /^es/i.test((form && form.locale) || "") || /spanish|español|espanol/i.test(formName);
      const { data: crm } = await sb.from("leads").select("id, phone, email");
      const phones = new Set((crm || []).map((l: any) => digits10(l.phone)).filter((d: string) => d && d.length === 10));
      const emails = new Set((crm || []).map((l: any) => String(l.email || "").toLowerCase()).filter(Boolean));
      const missing = all.filter((ld) => {
        const f: Field[] = ld.field_data || [];
        if (f.some((x) => (x.values || []).some((v) => /test lead|dummy data/i.test(String(v))))) return false;
        const p = digits10(fv(f, "phone_number", "phone", "número_de_teléfono") || ""), e = String(fv(f, "email", "correo_electrónico", "correo_electronico") || "").toLowerCase();
        return !((p && p.length === 10 && phones.has(p)) || (e && emails.has(e)));
      });
      const summary = { form: formName, spanish, totalAtMeta: all.length, alreadyInCrm: all.length - missing.length, missing: missing.length,
        oldest: all.length ? all[all.length - 1].created_time : null, newest: all.length ? all[0].created_time : null,
        missingList: missing.map((ld) => { const f: Field[] = ld.field_data || []; return { created: ld.created_time, name: fv(f, "full_name", "nombre_completo") || "", hasPhone: !!fv(f, "phone_number", "phone"), hasEmail: !!fv(f, "email") }; }) };
      if (body.dryRun !== false) return json(summary);
      const today = new Date().toISOString().slice(0, 10);
      const imported: string[] = [];
      for (const ld of missing.slice().reverse()) {
        const f: Field[] = translateAnswers(ld.field_data || [], (form && form.questions) || []);
        const name = fv(f, "full_name", "nombre_completo") || [fv(f, "first_name"), fv(f, "last_name")].filter(Boolean).join(" ") || "Facebook Lead";
        const email = fv(f, "email", "correo_electrónico", "correo_electronico"), phone = fv(f, "phone_number", "phone", "número_de_teléfono");
        const dedicated = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "phone", "nombre_completo"]);
        const answers = f.filter((x) => !dedicated.has(x.name.toLowerCase()) && x.values && x.values.length).map((x) => x.name.replace(/_/g, " ") + ": " + x.values.join(", "));
        const assignee = spanish ? SPANISH_LO : await pickEnglishAdLO();
        const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
        const submitted = String(ld.created_time || "").slice(0, 10);
        const activity: Record<string, string>[] = [
          { date: today, type: "note", author: "System", text: "Imported from Facebook form history (\"" + formName + "\", submitted " + submitted + (ld.campaign_name ? ", campaign " + ld.campaign_name : "") + ") — this lead never reached the CRM. Routed to " + assignee + ". No automatic messages sent; reach out personally." },
          { date: today, type: "note", author: "System", text: "TCPA consent recorded — agreed to the contact disclaimer on Facebook form \"" + formName + "\" on " + submitted },
        ];
        if (answers.length) activity.push({ date: today, type: "note", author: "System", text: (spanish ? "Respuestas del formulario — " : "Form answers — ") + answers.join(" · ") });
        const { error } = await sb.from("leads").insert({
          id, name, email: email || null, phone: phone || null, source: spanish ? "Facebook" : "Meta Ads — Lead Form", loan_type: loanTypeFrom(f, formName),
          stage: "new", status: "active", assigned_to: assignee, created_at: submitted || today, created_at_ts: ld.created_time ? new Date(ld.created_time).toISOString() : new Date().toISOString(),
          preferred_language: spanish ? "es" : "en", automation_paused: true, entity_type: "LLC", application_token: crypto.randomUUID(), activity,
        });
        if (!error) imported.push(id);
      }
      if (imported.length) {
        const assignee = spanish ? SPANISH_LO : "owner";
        await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: assignee, lead_id: imported[0], kind: "hot-lead", text: imported.length + " older Facebook leads that never reached the CRM were just added to your list (marked \"Imported from Facebook form history\") — no automatic messages were sent.", date: today, read: false });
      }
      return json({ ...summary, missingList: undefined, imported: imported.length });
    }
    const existing = await fetch(GRAPH + "/" + formId + "/test_leads?access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch(() => null);
    for (const t of (existing && existing.data) || []) await fetch(GRAPH + "/" + t.id + "?access_token=" + encodeURIComponent(pt), { method: "DELETE" }).catch(() => null);
    const made = await fetch(GRAPH + "/" + formId + "/test_leads", { method: "POST", body: new URLSearchParams({ access_token: pt }) }).then((r) => r.json()).catch((e) => String(e));
    return json({ deletedOld: ((existing && existing.data) || []).length, created: made });
  }
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
      out.appSubscription = await fetch(GRAPH + "/" + META_APP_ID + "/subscriptions", { method: "POST", body: new URLSearchParams({ object: "page", callback_url: cb, fields: "leadgen,feed,messages", verify_token: META_VERIFY_TOKEN, include_values: "true", access_token: appToken }) }).then((r) => r.json()).catch((e) => String(e));
      out.igSubscription = await fetch(GRAPH + "/" + META_APP_ID + "/subscriptions", { method: "POST", body: new URLSearchParams({ object: "instagram", callback_url: cb, fields: "comments,messages", verify_token: META_VERIFY_TOKEN, include_values: "true", access_token: appToken }) }).then((r) => r.json()).catch((e) => String(e));
      // Messenger ("messages") needs pages_messaging, which the token doesn't have (10/8) --
      // subscribe what it can: lead forms + page comments. Pass body.fields to override.
      const pageFields = typeof body.fields === "string" && /^[a-z_,]+$/.test(body.fields) ? body.fields : "leadgen,feed";
      if (pt) out.pageSubscription = await fetch(GRAPH + "/" + META_PAGE_ID + "/subscribed_apps", { method: "POST", body: new URLSearchParams({ subscribed_fields: pageFields, access_token: pt }) }).then((r) => r.json()).catch((e) => String(e));
    }
    out.appSubscriptions = await fetch(GRAPH + "/" + META_APP_ID + "/subscriptions?access_token=" + encodeURIComponent(appToken)).then((r) => r.json()).catch(() => null);
    if (pt) out.pageSubscribedApps = await fetch(GRAPH + "/" + META_PAGE_ID + "/subscribed_apps?access_token=" + encodeURIComponent(pt)).then((r) => r.json()).catch(() => null);
    const app = await fetch(GRAPH + "/" + META_APP_ID + "?fields=name&access_token=" + encodeURIComponent(appToken)).then((r) => r.json()).catch(() => null);
    out.app = app;
    return json(out);
  }

  // ---- Meta webhooks: lead forms, page comments, Messenger, Instagram ----
  try {
    const isIg = body.object === "instagram";
    for (const entry of body.entry || []) {
      const pageId = isIg ? META_PAGE_ID : String(entry.id || META_PAGE_ID);
      for (const change of entry.changes || []) {
        const v = change.value || {};
        // Process before answering (edge functions can stop once the response is sent).
        if (change.field === "leadgen" && v.leadgen_id) {
          await processLeadgenId(v.leadgen_id, v.page_id, v.form_id, v.ad_id).catch((e) => console.error("meta-leads-webhook: processing error", e));
        } else if (!isIg && change.field === "feed" && v.item === "comment" && v.verb === "add" && v.from) {
          await handleSocial({ platform: "facebook", kind: "comment", externalId: "fb:" + v.comment_id, fromId: String(v.from.id), name: v.from.name || null, text: v.message || "", commentId: v.comment_id, pageId }).catch((e) => console.error("social fb comment", e));
        } else if (isIg && change.field === "comments" && v.from) {
          await handleSocial({ platform: "instagram", kind: "comment", externalId: "ig:" + v.id, fromId: String(v.from.id), username: v.from.username || null, text: v.text || "", commentId: v.id, pageId }).catch((e) => console.error("social ig comment", e));
        }
      }
      for (const m of entry.messaging || []) {
        if (!m.message || m.message.is_echo || !m.message.text || !m.sender) continue;
        await handleSocial({ platform: isIg ? "instagram" : "facebook", kind: "dm", externalId: (isIg ? "igdm:" : "fbdm:") + m.sender.id, fromId: String(m.sender.id), text: m.message.text, pageId }).catch((e) => console.error("social dm", e));
      }
    }
  } catch (err) { console.error("meta-leads-webhook: bad payload", String(err)); }
  return json({ ok: true });
});
