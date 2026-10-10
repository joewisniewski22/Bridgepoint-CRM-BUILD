// Monday scoreboard (growth plan item 4, 10/9/26): the five numbers from the plan plus a per-LO
// table, emailed to Joe every Monday morning. Cron hits it; it runs once per Monday ~8:30am ET.
// Owner-only content (names LOs' performance); no lender names.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN") || "";
const META_ACCT = (Deno.env.get("META_AD_ACCOUNT_ID") || "").replace(/^act_/, "");
const META_PAGE_ID = Deno.env.get("META_PAGE_ID") || "1074182725781807";
const GRAPH = "https://graph.facebook.com/v21.0";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const APP_STAGES = ["app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
const INBOUND = /^(Facebook|Meta Ads|Website|Connected Investors|Private ?Lenders)/i;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + "%" : "-");
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

function etParts(d = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { dow: p.weekday, date: p.year + "-" + p.month + "-" + p.day, hour: +p.hour % 24 };
}
async function graph(path: string, params: Record<string, string> = {}) {
  const u = new URL(GRAPH + path);
  Object.entries({ access_token: META_TOKEN, ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
  return await fetch(u.toString()).then((r) => r.json()).catch(() => ({}));
}

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* cron sends a body */ }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const t = etParts();
  const force = body.force === true;
  if (!force && (t.dow !== "Mon" || t.hour < 8 || t.hour > 10)) return json({ ok: true, skipped: "not_monday_morning" });
  if (!force) {
    const { error } = await sb.from("ad_followup_log").insert({ lead_id: "scoreboard", step: "weekly-" + t.date, detail: "Monday scoreboard email" });
    if (error) return json({ ok: true, skipped: "already_sent" });
  }

  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: leads } = await sb.from("leads").select("id,name,source,assigned_to,stage,status,created_at_ts,first_attempt_at,lo_dialed_at,call_attempts").gte("created_at_ts", since30).neq("status", "spam");
  const inbound = (leads || []).filter((l: any) => INBOUND.test(String(l.source || "")) && !/^TEST/i.test(String(l.name || "")));
  const week = inbound.filter((l: any) => l.created_at_ts >= since7);
  // First real dial: the CRM call log or the phone system (press-1 / in-app), whichever is earlier.
  for (const l of inbound as any[]) { const ts = [l.first_attempt_at, l.lo_dialed_at].filter(Boolean).map((x: string) => Date.parse(x)); l.first_attempt_at = ts.length ? new Date(Math.min(...ts)).toISOString() : null; }
  const reached = (l: any) => (l.call_attempts || []).some((a: any) => a.outcome === "connected" || a.outcome === "callback");
  const fast = (l: any) => l.first_attempt_at && new Date(l.first_attempt_at).getTime() - new Date(l.created_at_ts).getTime() <= 5 * 60000;
  const isApp = (l: any) => APP_STAGES.includes(l.stage);
  const fb30 = inbound.filter((l: any) => /^(Facebook|Meta Ads)/i.test(l.source));

  // Facebook spend (30 days) -> cost per application on Facebook leads from the same 30 days.
  let spend30 = 0;
  if (META_TOKEN && META_ACCT) {
    const ins = await graph("/act_" + META_ACCT + "/insights", { date_preset: "last_30d", fields: "spend" });
    spend30 = Number((ins.data && ins.data[0] && ins.data[0].spend) || 0);
  }
  const fbApps = fb30.filter(isApp).length;
  let followers = "-";
  if (META_TOKEN) {
    const pg = await graph("/" + META_PAGE_ID, { fields: "access_token" });
    if (pg.access_token) {
      const p2 = await fetch(GRAPH + "/" + META_PAGE_ID + "?fields=followers_count,instagram_business_account{followers_count}&access_token=" + encodeURIComponent(pg.access_token)).then((r) => r.json()).catch(() => ({}));
      followers = (p2.followers_count ?? "?") + " Facebook + " + (p2.instagram_business_account?.followers_count ?? "?") + " Instagram";
    }
  }

  const { data: staff } = await sb.from("users").select("id,name,role").in("role", ["loan_officer", "owner"]).neq("id", "demo");
  const rows = (staff || []).map((u: any) => {
    const mine = week.filter((l: any) => l.assigned_to === u.id);
    const mine30 = inbound.filter((l: any) => l.assigned_to === u.id);
    const times = mine.filter((l: any) => l.first_attempt_at).map((l: any) => (new Date(l.first_attempt_at).getTime() - new Date(l.created_at_ts).getTime()) / 60000).sort((a: number, b: number) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    return { name: u.name, leads: mine.length, never: mine.filter((l: any) => !l.first_attempt_at).length, fast: mine.filter(fast).length,
      median: median == null ? "-" : median < 90 ? Math.round(median) + " min" : (median / 60).toFixed(1) + " hrs", reached: pct(mine.filter(reached).length, mine.length), apps30: mine30.filter(isApp).length };
  }).filter((r: any) => r.leads || r.apps30);

  const { count: rings } = await sb.from("lead_ring_log").select("lead_id", { count: "exact", head: true }).gte("created_at", since7);
  const lines = [
    "Bridgepoint weekly scoreboard - week ending " + t.date,
    "",
    "THE FIVE NUMBERS (inbound leads; target in brackets)",
    "1. Called within 5 minutes: " + pct(week.filter(fast).length, week.length) + " of " + week.length + " new leads this week  [80%]",
    "2. Ever reached by phone: " + pct(week.filter(reached).length, week.length) + "  [50%]",
    "3. Facebook lead -> application (30 days): " + pct(fbApps, fb30.length) + " (" + fbApps + " of " + fb30.length + ")  [15%]",
    "4. Facebook cost per application (30 days): " + (fbApps ? money(spend30 / fbApps) : "no applications yet") + " on " + money(spend30) + " spend  [under $150]",
    "5. Followers: " + followers + "  [1,000 by early January]",
    "",
    "Auto-rings sent to LOs this week: " + (rings || 0),
    "",
    "BY LO (this week's new inbound leads; applications = last 30 days)",
    ...rows.map((r: any) => "- " + r.name + ": " + r.leads + " leads, " + r.never + " never called, median first call " + r.median + ", " + r.fast + " within 5 min, reached " + r.reached + ", " + r.apps30 + " applications (30d)"),
  ];
  const text = lines.join("\n");
  const { data: owner } = await sb.from("users").select("email").eq("id", "owner").single();
  const to = (body.to as string) || owner?.email;
  if (to) await fetch(SUPABASE_URL + "/functions/v1/send-email", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify({ to, subject: "Weekly scoreboard - " + t.date, text, fromName: "Bridgepoint CRM" }) }).catch(() => null);
  return json({ ok: true, sentTo: to || null, text });
});
