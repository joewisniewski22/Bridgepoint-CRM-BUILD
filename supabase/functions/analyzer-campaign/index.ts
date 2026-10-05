// "Check out the free Deal Analyzer" campaign to people already in the CRM, sent from each person's own loan officer.
// Controlled by site_config:
//   analyzer_campaign_mode = off | shadow | live   (default off)
//       off    -> does nothing
//       shadow -> returns who WOULD be contacted and the exact messages; sends and logs nothing
//       live   -> sends, Mon-Fri 10am-5pm Eastern only, small batches per run (called hourly by pg_cron)
//   analyzer_campaign_sms  = on | off              (default off; texts are ALSO limited to people with recorded text consent
//                                                   or who have texted us first -- same rule as the follow-up engine)
// Every message points to the loan officer assigned to that person. Each person gets each channel at most once.
// Never contacts: spam/lost/test/partner leads, files already in process (processing, docs, ctc, approved, underwriting),
// anyone who opted out (sms_opt_out, nurture_off), anyone contacted in the last 3 days, or anyone who already used the analyzer.
// Email carries a working unsubscribe link (-> email-unsubscribe) and the company address.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
type Row = Record<string, any>;

const EMAIL_BATCH = 20, TEXT_BATCH = 8;
const SKIP_STAGES = ["processing", "docs", "ctc", "approved", "underwriting", "lost"];
const ADDRESS = "BridgePoint Lending LLC, 1898 Merchants Row Blvd Unit 7, Tallahassee, FL 32311";

async function authorized(req: Request, body: Row): Promise<boolean> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token && token === SERVICE_ROLE_KEY) return true;
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (auth && body.secret && body.secret === auth.secret) return true;
  if (!token) return false;
  const { data } = await sb.auth.getUser(token).catch(() => ({ data: null }));
  if (!data || !data.user) return false;
  const { data: u } = await sb.from("users").select("role").eq("auth_id", data.user.id).maybeSingle();
  return !!u && u.role === "owner";
}
function et() {
  const p = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, weekday: "short", timeZone: "America/New_York" }).formatToParts(new Date());
  return { hour: Number(p.find((x) => x.type === "hour")!.value) % 24, wd: p.find((x) => x.type === "weekday")!.value };
}
async function sha(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function unsubToken(leadId: string) { return (await sha(leadId + ":unsub:" + SERVICE_ROLE_KEY)).slice(0, 24); }

const act = (l: Row): Row[] => Array.isArray(l.activity) ? l.activity : [];
const hasConsent = (l: Row) => act(l).some((a) => typeof a.text === "string" && a.text.indexOf("TCPA consent recorded") === 0);
const hasInboundText = (l: Row) => act(l).some((a) => a.type === "text" && typeof a.text === "string" && /^Received \(via/.test(a.text));
const usedAnalyzer = (l: Row) => /Deal Analyzer/i.test(l.source || "") || act(l).some((a) => typeof a.text === "string" && /Deal Analyzer/i.test(a.text) && !/^Emailed|^Texted/.test(a.text));

function url(medium: string) { return "https://bplending.com/deal-analyzer/?utm_source=crm&utm_medium=" + medium + "&utm_campaign=analyzer-crm"; }
function emailCopy(first: string, lo: Row, unsub: string) {
  const loFirst = String(lo.name || "your loan officer").split(/\s+/)[0];
  const phone = lo.phone ? String(lo.phone) : "";
  const subject = "Looking at a deal? Run the numbers first";
  const text = "Hi " + first + ",\n\n" +
    "It's " + loFirst + " at Bridgepoint Lending. Are you looking at a property and haven't pulled the trigger yet? Let's take the guesswork out.\n\n" +
    "We built a free Deal Analyzer for investors. Enter the address and it pulls recent closed sales nearby, estimates your rehab with real materials costs, and shows your profit and return with and without financing, plus a stress test. You can download the whole thing as a PDF.\n\n" +
    "Run your numbers: " + url("email") + "\n\n" +
    "If the deal works, or you just want a second set of eyes on it, reply to this email" + (phone ? " or call or text me at " + phone : "") + ". I'll help you structure it and get you real terms.\n\n" +
    loFirst + "\nBridgepoint Lending\n\n" +
    "-- \nDon't want emails like this? Unsubscribe: " + unsub + "\n" + ADDRESS;
  return { subject, text };
}
function textCopy(first: string, lo: Row) {
  const loFirst = String(lo.name || "your loan officer").split(/\s+/)[0];
  return "Hi " + first + ", it's " + loFirst + " at Bridgepoint Lending. Looking at a deal? Run it through our free Deal Analyzer and see your profit before you pull the trigger: " + url("sms") + " Questions? Just reply here, it comes straight to me. Reply STOP to opt out.";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: Row = {};
  try { body = await req.json(); } catch (_) { /* empty body is fine */ }
  if (!(await authorized(req, body))) return json({ error: "not_authorized" }, 403);
  try {
    const { data: cfgRows } = await sb.from("site_config").select("key,value").in("key", ["analyzer_campaign_mode", "analyzer_campaign_sms"]);
    const cfg: Record<string, string> = {};
    (cfgRows || []).forEach((r: Row) => { cfg[r.key] = r.value || ""; });
    const mode = cfg.analyzer_campaign_mode || "off", smsOn = (cfg.analyzer_campaign_sms || "off") === "on";
    if (mode === "off") return json({ ok: true, skipped: "mode is off" });

    const { data: leads } = await sb.from("leads")
      .select("id,name,email,phone,assigned_to,source,stage,status,sms_opt_out,nurture_off,last_contact_at,preferred_language,activity")
      .in("status", ["active", "cold", "closed"]).limit(2000);
    const { data: logRows } = await sb.from("analyzer_campaign_log").select("lead_id,channel");
    const done = new Set((logRows || []).map((r: Row) => r.lead_id + "|" + r.channel));
    const { data: users } = await sb.from("users").select("id,name,email,phone,photo_url,role");
    const userOf = (id: string) => (users || []).find((u: Row) => u.id === id) || (users || []).find((u: Row) => u.id === "owner") || { id: "owner", name: "Joseph" };
    const cutoff = Date.now() - 3 * 86400000;

    const eligible = (leads || []).filter((l: Row) => {
      if (l.nurture_off || l.status === "spam" || SKIP_STAGES.includes(l.stage || "")) return false;
      if (/test|demo|fake/i.test(l.name || "") || /^test$|partner/i.test(l.source || "")) return false;
      if (usedAnalyzer(l)) return false;
      if ((l.preferred_language || "en") !== "en") return false; // the analyzer is English-only for now
      if (l.last_contact_at && new Date(l.last_contact_at).getTime() > cutoff) return false;
      const lo = userOf(l.assigned_to || "owner");
      return !!lo && lo.id !== "demo";
    });
    const emailOk = (l: Row) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(l.email || "").trim()) && !/example\.com|@bplending\.com$/i.test(l.email || "") && !done.has(l.id + "|email");
    const textOk = (l: Row) => smsOn && !l.sms_opt_out && String(l.phone || "").replace(/\D/g, "").length >= 10 && (hasConsent(l) || hasInboundText(l)) && !done.has(l.id + "|text");

    const emailPool = eligible.filter(emailOk), textPool = eligible.filter(textOk);
    const summary = { eligiblePeople: eligible.length, emailPending: emailPool.length, textPending: textPool.length,
      textNote: smsOn ? "texts go only to people with recorded text consent or who texted us first" : "texts are off (analyzer_campaign_sms = off)" };

    const buildEmail = async (l: Row) => {
      const lo = userOf(l.assigned_to || "owner");
      const unsub = SUPABASE_URL + "/functions/v1/email-unsubscribe?l=" + encodeURIComponent(l.id) + "&t=" + (await unsubToken(l.id));
      const first = String(l.name || "").split(/\s+/)[0] || "there";
      return { lo, ...emailCopy(first, lo, unsub) };
    };

    if (mode === "shadow") {
      const sampleE = [];
      for (const l of emailPool.slice(0, 3)) { const e = await buildEmail(l); sampleE.push({ to: l.email, name: l.name, from: e.lo.name, subject: e.subject, body: e.text }); }
      const byLo: Record<string, number> = {};
      emailPool.forEach((l: Row) => { const n = userOf(l.assigned_to || "owner").name; byLo[n] = (byLo[n] || 0) + 1; });
      return json({ ok: true, mode, ...summary, emailsByLoanOfficer: byLo, sampleEmails: sampleE,
        sampleTexts: textPool.slice(0, 3).map((l: Row) => ({ to: l.phone, name: l.name, text: textCopy(String(l.name || "").split(/\s+/)[0] || "there", userOf(l.assigned_to || "owner")) })) });
    }
    if (mode !== "live") return json({ ok: true, skipped: "unknown mode" });

    const t = et();
    if (["Sat", "Sun"].includes(t.wd) || t.hour < 10 || t.hour >= 17) return json({ ok: true, skipped: "outside Mon-Fri 10am-5pm Eastern", ...summary });

    const post = (fn: string, payload: Row) => fetch(SUPABASE_URL + "/functions/v1/" + fn, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload) });
    const sent = { emails: 0, texts: 0, errors: 0 };
    for (const l of emailPool.slice(0, EMAIL_BATCH)) {
      const e = await buildEmail(l);
      await sb.from("analyzer_campaign_log").upsert({ lead_id: l.id, channel: "email", sent_at: new Date().toISOString(), ok: false, detail: "sending" });
      const r = await post("send-email", { leadId: l.id, to: String(l.email).trim(), subject: e.subject, text: e.text, fromName: e.lo.name + " at Bridgepoint Lending", fromUserId: e.lo.id, fromPhotoUrl: e.lo.photo_url || null, initiatedBy: "ai" }).catch(() => null);
      const ok = !!(r && r.ok);
      await sb.from("analyzer_campaign_log").upsert({ lead_id: l.id, channel: "email", sent_at: new Date().toISOString(), ok, detail: ok ? "sent" : "send failed" });
      if (ok) sent.emails++; else sent.errors++;
    }
    for (const l of textPool.slice(0, TEXT_BATCH)) {
      const lo = userOf(l.assigned_to || "owner");
      await sb.from("analyzer_campaign_log").upsert({ lead_id: l.id, channel: "text", sent_at: new Date().toISOString(), ok: false, detail: "sending" });
      const r = await post("send-text", { leadId: l.id, to: l.phone, text: textCopy(String(l.name || "").split(/\s+/)[0] || "there", lo), fromName: lo.name, initiatedBy: "ai" }).catch(() => null);
      const ok = !!(r && r.ok);
      await sb.from("analyzer_campaign_log").upsert({ lead_id: l.id, channel: "text", sent_at: new Date().toISOString(), ok, detail: ok ? "sent" : "send failed" });
      if (ok) sent.texts++; else sent.errors++;
    }
    return json({ ok: true, mode, sent, ...summary });
  } catch (e) {
    console.error("analyzer-campaign", String(e));
    return json({ error: "server_error", detail: String(e) }, 500);
  }
});
