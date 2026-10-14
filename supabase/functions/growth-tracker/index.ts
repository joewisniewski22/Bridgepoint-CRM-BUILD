// Growth tracker (Joe 2026-10-14: "track everything you need to make sure we hit that goal"). One function, three callers:
//   dashboard  -- signed-in owner / Fiore (JWT): everything the CRM "Growth" screen shows
//   summary    -- cron secret: short pacing lines that the Monday scoreboard email appends
//   snapshot   -- cron secret: stores today's headline numbers in growth_snapshots so trends exist
// The goal itself lives in growth_goals ($ funded per month, N straight months, then the next target). Everything else is computed from real CRM
// outcomes (loans funded, stage reached, first-call speed) and the ad_spend_daily ledger. Names no lenders; owner/Fiore only.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

const ORDER = ["new", "attempting", "qualifying", "app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
const idx = (s: string) => ORDER.indexOf(String(s));
const PIPE_WEIGHT: Record<string, number> = { docs: 0.25, processing: 0.4, underwriting: 0.6, approved: 0.8, ctc: 0.92 };
const FUNDED = (l: any) => l.stage === "closed" || l.stage === "postclosing" || l.status === "closed";

function etNow() {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: p.year + "-" + p.month + "-" + p.day, ym: p.year + "-" + p.month, y: +p.year, m: +p.month, d: +p.day };
}
function group(l: any): string {
  const s = String(l.source || "");
  if (/vietnam/i.test(s) || l.preferred_language === "vi") return "Facebook — Vietnamese";
  if (/^Facebook$/i.test(s) || (/^Meta Ads/i.test(s) && l.preferred_language === "es")) return "Facebook — Spanish";
  if (/^Meta Ads/i.test(s)) return "Facebook — English";
  if (/^Referral/i.test(s)) return "Referral partners";
  if (/^Website/i.test(s)) return "Website / search";
  if (/connected|private ?lenders|cix/i.test(s)) return "Paid lead lists";
  return "Other / self-generated";
}
function campGroup(name: string): string {
  if (/follower|page likes/i.test(name)) return "Followers";
  if (/vietnam/i.test(name)) return "Facebook — Vietnamese";
  if (/spanish|espa/i.test(name)) return "Facebook — Spanish";
  return "Facebook — English";
}
const median = (a: number[]) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function compute(windowDays: number) {
  const now = etNow();
  const { data: goalRow } = await sb.from("growth_goals").select("*").eq("id", "default").maybeSingle();
  const goal = goalRow || { current_target_monthly: 6000000, consecutive_months_required: 3, next_target_monthly: 10000000, goal_start_date: "2026-09-07", target_deadline_months: 6 };
  const target = Number(goal.current_target_monthly), next = Number(goal.next_target_monthly), need = Number(goal.consecutive_months_required || 3);
  const start = new Date(String(goal.goal_start_date) + "T12:00:00Z");
  const deadline = new Date(start); deadline.setUTCMonth(deadline.getUTCMonth() + Number(goal.target_deadline_months || 6));
  const deadlineIso = deadline.toISOString().slice(0, 10);
  const latestStart = new Date(deadline); latestStart.setUTCMonth(latestStart.getUTCMonth() - need);

  const { data: all } = await sb.from("leads").select("id,name,source,stage,status,assigned_to,created_at_ts,created_at,first_attempt_at,lo_dialed_at,application_sent_at,application_taken_at,loan_amount,points_charged,close_date,funded_date,referral_partner_id,preferred_language,loan_type").limit(10000);
  const leads = (all || []).filter((l: any) => l.status !== "spam" && !/^(TEST|ZZ|Sample Borrower)/i.test(String(l.name || "")) && !/^LendingWise/i.test(String(l.source || "")));

  // ---- funded by month ----
  const fundedLeads = leads.filter(FUNDED);
  const ymOf = (l: any) => String(l.funded_date || l.close_date || "").slice(0, 7);
  const months: Record<string, { loans: number; volume: number; origination: number }> = {};
  for (let i = 6; i >= 0; i--) { const d = new Date(Date.UTC(now.y, now.m - 1 - i, 1)); months[d.toISOString().slice(0, 7)] = { loans: 0, volume: 0, origination: 0 }; }
  for (const l of fundedLeads) { const m = ymOf(l); if (months[m]) { months[m].loans++; months[m].volume += Number(l.loan_amount) || 0; months[m].origination += (Number(l.loan_amount) || 0) * (Number(l.points_charged) || 0) / 100; } }
  const monthList = Object.keys(months).sort().map((m) => ({ m, ...months[m], hit: months[m].volume >= target }));
  const cur = months[now.ym] || { loans: 0, volume: 0, origination: 0 };
  // streak of fully completed months at/above target, counted back from last month
  let streak = 0; const prior = monthList.filter((x) => x.m < now.ym).reverse();
  for (const x of prior) { if (x.hit) streak++; else break; }

  // ---- pipeline ----
  const pipe: Record<string, { n: number; volume: number }> = {};
  let weighted = 0;
  for (const l of leads) { if (l.status !== "active" || !PIPE_WEIGHT[l.stage]) continue; const v = Number(l.loan_amount) || 0; pipe[l.stage] = pipe[l.stage] || { n: 0, volume: 0 }; pipe[l.stage].n++; pipe[l.stage].volume += v; weighted += v * PIPE_WEIGHT[l.stage]; }
  const { data: usersPre } = await sb.from("users").select("id,name");
  const preName = (id: string) => String(((usersPre || []).find((u: any) => u.id === id) || { name: id }).name || id).split(/\s+/)[0];
  const pipeDeals = leads.filter((l: any) => l.status === "active" && PIPE_WEIGHT[l.stage]).map((l: any) => ({ id: l.id, name: l.name, stage: l.stage, lo: preName(String(l.assigned_to || "owner")), amount: Number(l.loan_amount) || 0, weighted: Math.round((Number(l.loan_amount) || 0) * PIPE_WEIGHT[l.stage]) })).sort((a: any, b: any) => b.weighted - a.weighted).slice(0, 15);
  const daysInMonth = new Date(Date.UTC(now.y, now.m, 0)).getUTCDate();
  const projectedMonth = cur.volume + weighted;

  // ---- funnel (cohort = leads created in the window) ----
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const cohort = leads.filter((l: any) => String(l.created_at_ts || l.created_at) >= since.slice(0, l.created_at_ts ? undefined : 10) && !/Referral Partner/i.test(String(l.source || "")));
  const called = (l: any) => !!(l.first_attempt_at || l.lo_dialed_at);
  const appSent = (l: any) => idx(l.stage) >= 3 || !!l.application_sent_at || !!l.application_taken_at;
  const appDone = (l: any) => idx(l.stage) >= 4 || !!l.application_taken_at;
  const inProc = (l: any) => idx(l.stage) >= 6;
  const funnelBy: Record<string, any> = {};
  for (const l of cohort) {
    const g = group(l); const f = funnelBy[g] = funnelBy[g] || { source: g, leads: 0, called: 0, appSent: 0, appDone: 0, processing: 0, funded: 0, volume: 0 };
    f.leads++; if (called(l)) f.called++; if (appSent(l)) f.appSent++; if (appDone(l)) f.appDone++; if (inProc(l)) f.processing++; if (FUNDED(l)) { f.funded++; f.volume += Number(l.loan_amount) || 0; }
  }
  const sources = Object.values(funnelBy).sort((a: any, b: any) => b.leads - a.leads);
  const tot = sources.reduce((a: any, f: any) => ({ leads: a.leads + f.leads, called: a.called + f.called, appSent: a.appSent + f.appSent, appDone: a.appDone + f.appDone, processing: a.processing + f.processing, funded: a.funded + f.funded, volume: a.volume + f.volume }), { leads: 0, called: 0, appSent: 0, appDone: 0, processing: 0, funded: 0, volume: 0 });

  // ---- ad spend + cost per outcome ----
  const sinceDay = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const { data: spendRows } = await sb.from("ad_spend_daily").select("day,campaign_name,spend,leads").gte("day", sinceDay);
  const spendBy: Record<string, number> = {}; let spendLeadGen = 0, spendAll = 0;
  for (const r of spendRows || []) { const g = campGroup(String(r.campaign_name || "")); spendBy[g] = (spendBy[g] || 0) + Number(r.spend || 0); spendAll += Number(r.spend || 0); if (g !== "Followers") spendLeadGen += Number(r.spend || 0); }
  for (const f of sources as any[]) { f.spend = Math.round((spendBy[f.source] || 0) * 100) / 100; f.cpl = f.spend && f.leads ? f.spend / f.leads : null; f.costPerApp = f.spend && f.appDone ? f.spend / f.appDone : null; f.costPerFunded = f.spend && f.funded ? f.spend / f.funded : null; }
  const fbLeads = (sources as any[]).filter((f) => /^Facebook/.test(f.source)).reduce((a, f) => ({ leads: a.leads + f.leads, appDone: a.appDone + f.appDone, funded: a.funded + f.funded }), { leads: 0, appDone: 0, funded: 0 });
  const spend = { windowDays, total: Math.round(spendAll), leadGen: Math.round(spendLeadGen), cpl: fbLeads.leads ? spendLeadGen / fbLeads.leads : null, costPerApp: fbLeads.appDone ? spendLeadGen / fbLeads.appDone : null, costPerFunded: fbLeads.funded ? spendLeadGen / fbLeads.funded : null };

  // ---- what it takes (back-solve) ----
  const funded180 = fundedLeads.filter((l: any) => { const m = String(l.funded_date || l.close_date || ""); return m >= new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10) && Number(l.loan_amount) > 0; });
  const avgLoan = funded180.length ? funded180.reduce((s: number, l: any) => s + Number(l.loan_amount), 0) / funded180.length : (fundedLeads.filter((l: any) => Number(l.loan_amount) > 0).reduce((s: number, l: any) => s + Number(l.loan_amount), 0) / Math.max(1, fundedLeads.filter((l: any) => Number(l.loan_amount) > 0).length)) || 300000;
  const thin = tot.funded < 5;
  const appToFunded = tot.appDone >= 5 && tot.funded > 0 ? Math.min(0.9, Math.max(0.05, tot.funded / tot.appDone)) : 0.3;
  const leadToApp = tot.leads >= 30 && tot.appDone > 0 ? Math.max(0.02, tot.appDone / tot.leads) : 0.08;
  const need1 = (t: number) => { const loans = Math.ceil(t / avgLoan), apps = Math.ceil(loans / appToFunded), lds = Math.ceil(apps / leadToApp); return { target: t, loans, apps, leads: lds, adCost: spend.cpl ? Math.round(lds * spend.cpl) : null }; };
  // what the same target needs if conversion improves (speed to lead, follow-up, partners): multiplier on both lead->app and app->funded
  const scenarios = [1, 1.5, 2, 3].map((k) => { const a2f = Math.min(0.6, appToFunded * k), l2a = Math.min(0.4, leadToApp * k); const loans = Math.ceil(target / avgLoan), apps = Math.ceil(loans / a2f), lds = Math.ceil(apps / l2a); return { multiplier: k, appToFunded: a2f, leadToApp: l2a, apps, leads: lds, adCost: spend.cpl ? Math.round(lds * spend.cpl) : null }; });
  const backsolve = { avgLoan: Math.round(avgLoan), appToFunded, leadToApp, thinData: thin, forTarget: need1(target), forNext: need1(next), scenarios };

  // ---- speed to lead ----
  const inboundNew = cohort.filter((l: any) => /^(Facebook|Meta Ads|Website)/i.test(String(l.source || "")));
  const byLo: Record<string, number[]> = {}; const uncalled: Record<string, number> = {};
  for (const l of inboundNew as any[]) {
    const created = Date.parse(l.created_at_ts || "");
    const ts = [l.first_attempt_at, l.lo_dialed_at].filter(Boolean).map((x: string) => Date.parse(x));
    const lo = String(l.assigned_to || "owner");
    if (ts.length && created) (byLo[lo] = byLo[lo] || []).push((Math.min(...ts) - created) / 60000);
    else if (l.status === "active" && idx(l.stage) <= 2 && created && Date.now() - created > 3600000) uncalled[lo] = (uncalled[lo] || 0) + 1;
  }
  const { data: users } = await sb.from("users").select("id,name");
  const nameOf = (id: string) => ((users || []).find((u: any) => u.id === id) || { name: id }).name;
  const speed = Object.keys({ ...byLo, ...uncalled }).map((lo) => { const a = byLo[lo] || []; return { lo: nameOf(lo), called: a.length, medianMinutes: median(a) == null ? null : Math.round(median(a)!), within5: a.length ? Math.round(a.filter((x) => x <= 5).length / a.length * 100) : null, uncalledOver1h: uncalled[lo] || 0 }; });

  // ---- partners ----
  const { data: partners } = await sb.from("referral_partners").select("id,name,company,status");
  const partnerRows = (partners || []).map((p: any) => { const ls = leads.filter((l: any) => l.referral_partner_id === p.id); return { name: p.name, company: p.company, status: p.status, referred: ls.length, apps: ls.filter(appDone).length, funded: ls.filter(FUNDED).length, volume: ls.filter(FUNDED).reduce((s: number, l: any) => s + (Number(l.loan_amount) || 0), 0) }; }).filter((p: any) => p.referred > 0 || p.status === "approved");

  const monthsLeft = Math.max(0, Math.round((deadline.getTime() - Date.now()) / (30.4 * 86400000) * 10) / 10);
  const goalOut = { target, next, streakRequired: need, streak, startDate: goal.goal_start_date, deadline: deadlineIso, monthsLeft, latestStreakStart: latestStart.toISOString().slice(0, 7), notes: goal.notes || null };
  const status = projectedMonth >= target ? "on_pace" : (projectedMonth >= target * 0.6 ? "behind" : "far_behind");
  return { generatedAt: new Date().toISOString(), today: now.date, goal: goalOut, months: monthList, thisMonth: { ym: now.ym, loans: cur.loans, volume: cur.volume, origination: cur.origination, dayOfMonth: now.d, daysInMonth, weightedPipeline: Math.round(weighted), projected: Math.round(projectedMonth), pctOfTarget: target ? cur.volume / target : 0, status },
    pipeline: pipe, pipeDeals, funnel: { windowDays, totals: tot, sources }, spend, backsolve, speed, partners: partnerRows };
}

function summaryLines(d: any): string[] {
  const g = d.goal, t = d.thisMonth, b = d.backsolve;
  return [
    "GOAL PACING (goal: " + money(g.target) + " funded per month for " + g.streakRequired + " months in a row, then " + money(g.next) + "; deadline " + g.deadline + ")",
    "- This month so far: " + money(t.volume) + " funded (" + t.loans + " loans) = " + Math.round(t.pctOfTarget * 100) + "% of target. Weighted pipeline " + money(t.weightedPipeline) + " -> projected " + money(t.projected) + " (" + (t.status === "on_pace" ? "ON PACE" : t.status === "behind" ? "BEHIND" : "FAR BEHIND") + ").",
    "- Months in a row at target: " + g.streak + " of " + g.streakRequired + ". To finish by the deadline the streak must start by " + g.latestStreakStart + ".",
    "- To hit " + money(g.target) + "/month at your average " + money(b.avgLoan) + " loan you need about " + b.forTarget.loans + " funded loans a month, which means ~" + b.forTarget.apps + " completed applications and ~" + b.forTarget.leads + " leads (using " + Math.round(b.appToFunded * 100) + "% application-to-funded and " + Math.round(b.leadToApp * 100) + "% lead-to-application" + (b.thinData ? "; those rates are thin-data estimates" : "") + ")." + (b.forTarget.adCost ? " At today's cost per lead that is roughly " + money(b.forTarget.adCost) + " a month in ads." : ""),
  ];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* ok */ }
  const mode = String(body.mode || "dashboard");
  const windowDays = [30, 60, 90, 180].includes(Number(body.windowDays)) ? Number(body.windowDays) : 90;
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  const cronOk = !!(auth && body.secret === auth.secret);
  if (mode === "dashboard") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = token ? await sb.auth.getUser(token).catch(() => ({ data: null as any })) : { data: null as any };
    if (!u || !u.user) return json({ error: "not_authorized" }, 403);
    const { data: me } = await sb.from("users").select("id").eq("auth_id", u.user.id).maybeSingle();
    if (!me || !["owner", "lo-fiore"].includes(String(me.id))) return json({ error: "not_authorized" }, 403);
    return json({ ok: true, ...(await compute(windowDays)) });
  }
  if (!cronOk) return json({ error: "not_authorized" }, 403);
  const d = await compute(90);
  if (mode === "summary") return json({ ok: true, lines: summaryLines(d) });
  if (mode === "full") return json({ ok: true, ...d });
  if (mode === "snapshot") {
    const slim = { thisMonth: d.thisMonth, goal: d.goal, totals: d.funnel.totals, spend: d.spend, backsolve: { avgLoan: d.backsolve.avgLoan, appToFunded: d.backsolve.appToFunded, leadToApp: d.backsolve.leadToApp }, pipeline: d.pipeline };
    const { error } = await sb.from("growth_snapshots").upsert({ day: d.today, data: slim }, { onConflict: "day" });
    return error ? json({ error: error.message }, 500) : json({ ok: true, day: d.today });
  }
  return json({ error: "unknown_mode" }, 400);
});
