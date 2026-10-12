// Nightly call report for Joe (2026-10-12): per loan officer, today's calls and texts, new leads, and how many of
// their active leads have never had a real call. Runs from pg_cron every 10 minutes and only sends inside a
// 10-minute window around 8:00pm Eastern, once per day (the one-shot ledger is lead_handoff_alerts).
// Counts only real LO calls: texts, missed-ring entries and "went unanswered before reaching" auto-rings are excluded.
// A person is credited by the `by` field on the attempt; older attempts with no name go to the lead's assigned LO,
// the same rule the dialer quota uses.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

function easternNow() {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: p.year + "-" + p.month + "-" + p.day, minutes: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday };
}
const isReal = (a: any) => a && a.outcome !== "texted" && !a.staffMissed && !/went unanswered before reaching/i.test(String(a.notes || ""));

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* cron sends a small JSON body */ }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(auth && body.secret === auth.secret) && bearer !== SERVICE_KEY) return json({ error: "not_authorized" }, 403);

  const now = easternNow();
  const force = body.force === true;
  if (!force && !(now.minutes >= 20 * 60 && now.minutes < 20 * 60 + 10)) return json({ ok: true, skipped: "not report time" });
  if (!force) {
    const { error } = await sb.from("lead_handoff_alerts").insert({ lead_id: "daily-call-report", kind: now.date });
    if (error) return json({ ok: true, skipped: "already sent today" });
  }

  const { data: staff } = await sb.from("users").select("id,name,role,phone,email").in("role", ["loan_officer", "owner"]);
  const { data: leads } = await sb.from("leads").select("id,assigned_to,status,created_at,call_attempts,lo_dialed_at").neq("status", "spam");
  const people = (staff || []).filter((u: any) => u.id !== "demo");

  const stat: Record<string, { calls: number; connected: number; texts: number; newLeads: number; never: number; neverRecent: number }> = {};
  people.forEach((u: any) => { stat[u.id] = { calls: 0, connected: 0, texts: 0, newLeads: 0, never: 0, neverRecent: 0 }; });
  const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const l of (leads || []) as any[]) {
    const attempts = Array.isArray(l.call_attempts) ? l.call_attempts : [];
    if (stat[l.assigned_to] && l.created_at === now.date) stat[l.assigned_to].newLeads++;
    for (const a of attempts) {
      if (!a || a.date !== now.date) continue;
      const who = a.by || l.assigned_to;
      if (!stat[who]) continue;
      if (a.outcome === "texted") stat[who].texts++;
      else if (isReal(a)) { stat[who].calls++; if (a.outcome === "connected") stat[who].connected++; }
    }
    if (l.status === "active" && stat[l.assigned_to] && !l.lo_dialed_at && !attempts.some(isReal)) {
      stat[l.assigned_to].never++;
      if (String(l.created_at) >= sevenAgo) stat[l.assigned_to].neverRecent++;
    }
  }

  const label = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
  const lines = people.map((u: any) => {
    const s = stat[u.id];
    return u.name.split(" ")[0] + ": " + s.calls + " calls (" + s.connected + " connected), " + s.texts + " texts, " + s.newLeads + " new" +
      (s.never ? (", " + s.never + " never called (" + s.neverRecent + " from the last 7 days)") : "");
  });
  const text = "Call report " + label + "\n" + lines.join("\n") + "\nDetails: " + CRM_URL;
  const owner = people.find((u: any) => u.id === "owner");
  const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY };
  if (owner && owner.phone) await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers, body: JSON.stringify({ to: owner.phone, text, fromName: "Bridgepoint CRM" }) }).catch(() => null);
  if (owner && owner.email) await fetch(SUPABASE_URL + "/functions/v1/send-email", { method: "POST", headers, body: JSON.stringify({ to: owner.email, subject: "Call report " + label, text, fromName: "Bridgepoint CRM" }) }).catch(() => null);
  return json({ ok: true, sent: true, text });
});
