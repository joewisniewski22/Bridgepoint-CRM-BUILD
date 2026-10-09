// Ad monitor + optimizer. Cron every 30 minutes; acts only at fixed Eastern
// times (8:00 morning brief + check, then 11:00, 15:00, 19:00 checks).
//
// Joe (2026-10-03): "I want you actually monitoring live the actual ads and
// making adjustments to maximize performance."
//
// Three modes, stored in ad_optimizer_config (one row):
//   off        - does nothing
//   recommend  - watches everything, alerts Joe, logs what it WOULD change   (default)
//   auto       - also applies the guarded adjustments below
// Joe flips it to auto after the first days of real data.
//
// Scope: it monitors every active campaign, but only ever *changes* campaigns
// whose name starts with MANAGED_PREFIX (the ones built 10/3/26), so the
// Spanish campaigns and anything else Joe runs by hand are never touched.
//
// Guardrails (auto mode): never turns anything ON or creates anything; only
// pauses ads and shifts budget between managed campaigns; total managed daily
// budget never exceeds daily_cap_cents; no edits during the learning period
// (72h of delivery); at least 2 ads always stay active per ad set; every
// change is logged to ad_optimizer_log and texted to Joe.
//
// Attribution: the landing page puts utm_content (the creative) and
// utm_campaign on every ad link; ad-lead-intake records them in the lead's
// first activity note. Down-funnel (called / application / closed) counts
// come from the CRM, so decisions reflect real leads, not just clicks.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN") || "";
const META_ACCT = (Deno.env.get("META_AD_ACCOUNT_ID") || "").replace(/^act_/, "");
const GRAPH = "https://graph.facebook.com/v21.0";
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const MANAGED_PREFIX = "BP Oct-26";
const LAUNCH_DATE = "2026-10-03";
const MIN_AGE_H = 72;          // learning period before any edit
const MIN_SPEND_AD = 60;       // dollars an ad must spend before it can be judged
const LOSER_MULT = 2.5;        // cost per lead this many times the campaign average
const MIN_CTR = 0.5;           // percent
const ZERO_LEAD_SPEND = 100;   // dollars with no CRM leads at all
const SHIFT_PCT = 0.2;         // budget moved per adjustment
const MIN_CAMPAIGN_BUDGET = 2000; // cents (floor per campaign)
const CHECK_HOURS = [8, 11, 15, 19];

type Row = Record<string, any>;
const num = (v: unknown) => { const n = parseFloat(String(v ?? "0")); return isFinite(n) ? n : 0; };
function et(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: parseInt(g("hour"), 10) % 24, minute: parseInt(g("minute"), 10) };
}
async function graph(path: string, params: Record<string, string> = {}, method = "GET") {
  const url = new URL(GRAPH + path);
  const all: Record<string, string> = { access_token: META_TOKEN, ...params };
  let res: Response;
  if (method === "GET") { Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v)); res = await fetch(url.toString()); }
  else res = await fetch(url.toString(), { method, body: new URLSearchParams(all) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Meta " + res.status + ": " + JSON.stringify(data).slice(0, 300));
  return data;
}
const post = (fn: string, payload: Record<string, unknown>) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload),
}).catch(() => null);
async function claim(key: string): Promise<boolean> {
  const { error } = await sb.from("ad_followup_log").insert({ lead_id: "_optimizer", step: key, detail: "" });
  return !error;
}
async function tellJoe(text: string, subject?: string, body?: string) {
  const { data: owner } = await sb.from("users").select("phone,email").eq("id", "owner").single();
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: null, kind: "ads", text: text.slice(0, 240), date: et().date, read: false });
  if (owner?.phone) await post("send-text", { to: owner.phone, text: "Bridgepoint Ads: " + text, fromName: "Bridgepoint CRM" });
  if (subject && owner?.email) await post("send-email", { to: owner.email, subject, text: body || text, fromName: "Bridgepoint CRM" });
}
async function logAction(mode: string, kind: string, entity: string, detail: string) {
  await sb.from("ad_optimizer_log").insert({ mode, kind, entity, detail });
}

function leadsFromActions(actions: Row[] | undefined): number {
  const a = actions || [];
  const lead = a.find((x) => x.action_type === "lead") || a.find((x) => /(^|_)leads?$/.test(x.action_type) || /add_meta_leads$/.test(x.action_type));
  return lead ? num(lead.value) : 0;
}

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return new Response(JSON.stringify({ error: "not_authorized" }), { status: 403, headers: { "Content-Type": "application/json" } });

  const t = et();
  const forced = body.force === "run" || body.force === "brief";
  if (!forced && !(CHECK_HOURS.indexOf(t.hour) !== -1 && t.minute < 10)) {
    return new Response(JSON.stringify({ ok: true, skipped: "not_check_time" }), { headers: { "Content-Type": "application/json" } });
  }
  if (!META_TOKEN || !META_ACCT) return new Response(JSON.stringify({ error: "meta_not_configured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  const slotKey = "opt-" + t.date + "-" + t.hour;
  if (!forced && !(await claim(slotKey))) return new Response(JSON.stringify({ ok: true, skipped: "already_ran" }), { headers: { "Content-Type": "application/json" } });

  const { data: cfg } = await sb.from("ad_optimizer_config").select("*").eq("id", 1).single();
  const mode: string = (cfg && cfg.mode) || "recommend";
  const capCents: number = (cfg && cfg.daily_cap_cents) || 10000;
  if (mode === "off") return new Response(JSON.stringify({ ok: true, mode }), { headers: { "Content-Type": "application/json" } });
  const apply = mode === "auto";
  const notes: string[] = [];
  const actions: string[] = [];

  try {
    // ---- Meta state ----
    const camps = (await graph("/act_" + META_ACCT + "/campaigns", { fields: "id,name,status,effective_status,daily_budget", limit: "200" })).data as Row[];
    const adsList = (await graph("/act_" + META_ACCT + "/ads", { fields: "id,name,status,effective_status,created_time,adset_id,campaign_id,creative{object_story_spec}", limit: "500" })).data as Row[];
    const ins7 = (await graph("/act_" + META_ACCT + "/insights", { level: "ad", date_preset: "last_7d", fields: "ad_id,ad_name,campaign_id,campaign_name,spend,impressions,reach,frequency,inline_link_clicks,ctr,actions", limit: "500" })).data as Row[];
    const insY = (await graph("/act_" + META_ACCT + "/insights", { level: "campaign", date_preset: "yesterday", fields: "campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions", limit: "200" })).data as Row[];
    const insToday = (await graph("/act_" + META_ACCT + "/insights", { level: "campaign", date_preset: "today", fields: "campaign_id,campaign_name,spend,inline_link_clicks,actions", limit: "200" })).data as Row[];

    const activeCamps = camps.filter((c) => c.effective_status === "ACTIVE");
    const managed = camps.filter((c) => String(c.name).indexOf(MANAGED_PREFIX) === 0);
    const isManaged = (cid: string) => managed.some((c) => c.id === cid);

    // ---- CRM outcomes by creative (utm_content) over the same 7 days ----
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    // Landing-page and website leads are keyed by utm_content; Facebook instant-form leads
    // (10/8: the English campaign now uses forms) by the Meta ad id written on the lead.
    const { data: crm } = await sb.from("leads").select("id,stage,status,first_attempt_at,call_attempts,activity,created_at_ts").or("source.like.Meta Ads*,source.like.Website*,source.eq.Facebook").neq("status", "spam").gte("created_at_ts", since > LAUNCH_DATE ? since : LAUNCH_DATE);
    const byContent: Record<string, { leads: number; called: number; apps: number; closed: number }> = {};
    for (const l of crm || []) {
      const note = ((l.activity as Row[]) || []).find((a) => typeof a.text === "string" && (a.text.indexOf("Lead captured from") === 0));
      const m = note ? String(note.text).match(/content=([a-z0-9-]+)/) : null;
      const adm = note ? String(note.text).match(/ad_id=(\d+)/) : null;
      const key = adm ? "ad:" + adm[1] : m ? m[1] : "(unknown)";
      const x = (byContent[key] = byContent[key] || { leads: 0, called: 0, apps: 0, closed: 0 });
      x.leads++;
      if ((l.call_attempts || []).length || l.first_attempt_at || (l.stage && l.stage !== "new")) x.called++;
      if (["app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"].indexOf(l.stage) !== -1) x.apps++;
      if (["closed", "postclosing"].indexOf(l.stage) !== -1) x.closed++;
    }
    const contentOfAd = (ad: Row): string => {
      const link = ad.creative?.object_story_spec?.link_data?.link || "";
      const m = String(link).match(/utm_content=([a-z0-9-]+)/);
      return m ? m[1] : "";
    };

    // ---- Alerts that apply to everything (any mode) ----
    for (const ad of adsList) {
      if (["DISAPPROVED", "WITH_ISSUES"].indexOf(ad.effective_status) !== -1 && (await claim("disapproved-" + ad.id))) {
        actions.push(`⚠️ Ad "${ad.name}" is ${ad.effective_status} by Meta — needs a fix before it can run.`);
      }
    }
    for (const c of managed) {
      const td = insToday.find((x) => x.campaign_id === c.id);
      if (c.effective_status === "ACTIVE" && td && c.daily_budget && num(td.spend) > (num(c.daily_budget) / 100) * 1.3) {
        if (await claim("overspend-" + c.id + "-" + t.date)) actions.push(`⚠️ "${c.name}" has spent $${num(td.spend).toFixed(0)} today against a $${(num(c.daily_budget) / 100).toFixed(0)} budget.`);
      }
    }

    // ---- Per-creative scorecard (managed campaigns) ----
    const rows: Array<{ ad: Row; ins: Row | null; key: string; spend: number; clicks: number; imps: number; ctr: number; freq: number; leads: number; cpl: number; ageH: number }> = [];
    for (const ad of adsList.filter((a) => isManaged(a.campaign_id))) {
      const i = ins7.find((x) => x.ad_id === ad.id) || null;
      const key = contentOfAd(ad) || ("ad:" + ad.id);
      const crmx = byContent[key] || byContent["ad:" + ad.id] || { leads: 0, called: 0, apps: 0, closed: 0 };
      const spend = num(i?.spend);
      rows.push({ ad, ins: i, key, spend, clicks: num(i?.inline_link_clicks), imps: num(i?.impressions), ctr: num(i?.ctr), freq: num(i?.frequency), leads: crmx.leads, cpl: crmx.leads ? spend / crmx.leads : Infinity, ageH: (Date.now() - new Date(ad.created_time).getTime()) / 3600000 });
    }
    // Campaign-level averages
    const campStats: Record<string, { spend: number; leads: number; clicks: number }> = {};
    rows.forEach((r) => { const s = (campStats[r.ad.campaign_id] = campStats[r.ad.campaign_id] || { spend: 0, leads: 0, clicks: 0 }); s.spend += r.spend; s.leads += r.leads; s.clicks += r.clicks; });

    // ---- Rule: landing page / tracking broken ----
    for (const c of managed) {
      const s = campStats[c.id];
      if (s && s.clicks >= 40 && s.leads === 0 && (await claim("lp-broken-" + c.id + "-" + t.date))) {
        actions.push(`🚨 "${c.name}": ${s.clicks} link clicks in 7 days but 0 form leads in the CRM. The landing page or lead capture may be broken — check it now.`);
      }
    }

    // ---- Rule: pause clear losers ----
    for (const r of rows) {
      if (r.ad.effective_status !== "ACTIVE" && r.ad.status !== "ACTIVE") continue;
      if (r.ageH < MIN_AGE_H || r.spend < MIN_SPEND_AD) continue;
      const s = campStats[r.ad.campaign_id];
      const avg = s && s.leads ? s.spend / s.leads : null;
      const siblings = rows.filter((x) => x.ad.adset_id === r.ad.adset_id && x.ad.status === "ACTIVE");
      if (siblings.length <= 2) continue; // always keep at least 2 running
      let why = "";
      if (r.leads === 0 && r.spend >= ZERO_LEAD_SPEND) why = `$${r.spend.toFixed(0)} spent, 0 leads`;
      else if (avg && r.leads > 0 && s.leads >= 6 && r.cpl > LOSER_MULT * avg) why = `cost per lead $${r.cpl.toFixed(0)} vs campaign average $${avg.toFixed(0)}`;
      else if (r.imps >= 3000 && r.ctr < MIN_CTR) why = `click-through rate ${r.ctr.toFixed(2)}% on ${Math.round(r.imps)} impressions`;
      if (!why) continue;
      if (apply) {
        try { await graph("/" + r.ad.id, { status: "PAUSED" }, "POST"); await logAction(mode, "pause_ad", r.ad.id, r.ad.name + " — " + why); actions.push(`⏸ Paused ad "${r.ad.name}" (${why}).`); }
        catch (e) { actions.push(`Couldn't pause "${r.ad.name}": ${String(e).slice(0, 120)}`); }
      } else {
        if (await claim("rec-pause-" + r.ad.id + "-" + t.date)) { await logAction(mode, "would_pause_ad", r.ad.id, r.ad.name + " — " + why); actions.push(`Would pause ad "${r.ad.name}" (${why}).`); }
      }
    }

    // ---- Rule: shift budget toward the clearly better managed campaign ----
    const eligible = managed.filter((c) => c.effective_status === "ACTIVE" && campStats[c.id] && campStats[c.id].leads >= 10 && rows.some((r) => r.ad.campaign_id === c.id && r.ageH >= 7 * 24));
    if (eligible.length >= 2) {
      const withCpl = eligible.map((c) => ({ c, cpl: campStats[c.id].spend / campStats[c.id].leads })).sort((a, b) => a.cpl - b.cpl);
      const best = withCpl[0], worst = withCpl[withCpl.length - 1];
      if (best.cpl < 0.6 * worst.cpl) {
        const move = Math.round(num(worst.c.daily_budget) * SHIFT_PCT);
        const newWorst = num(worst.c.daily_budget) - move, newBest = num(best.c.daily_budget) + move;
        const total = managed.filter((c) => c.effective_status === "ACTIVE").reduce((s, c) => s + num(c.daily_budget), 0);
        const wk = "shift-" + t.date.slice(0, 7) + "-" + Math.floor(new Date(t.date + "T12:00:00Z").getTime() / (3 * 86400000));
        if (newWorst >= MIN_CAMPAIGN_BUDGET && total <= capCents && (await claim(wk))) {
          const msg = `Move $${(move / 100).toFixed(0)}/day from "${worst.c.name}" (CPL $${worst.cpl.toFixed(0)}) to "${best.c.name}" (CPL $${best.cpl.toFixed(0)}).`;
          if (apply) {
            try {
              await graph("/" + worst.c.id, { daily_budget: String(newWorst) }, "POST");
              await graph("/" + best.c.id, { daily_budget: String(newBest) }, "POST");
              await logAction(mode, "shift_budget", best.c.id, msg); actions.push("💰 " + msg);
            } catch (e) { actions.push("Couldn't shift budget: " + String(e).slice(0, 120)); }
          } else { await logAction(mode, "would_shift_budget", best.c.id, msg); actions.push("Would: " + msg); }
        }
      }
    }

    // ---- Creative fatigue ----
    for (const r of rows) {
      if (r.freq > 3.5 && (await claim("fatigue-" + r.ad.id + "-" + t.date.slice(0, 7) + "-" + Math.floor(new Date(t.date + "T12:00:00Z").getTime() / (7 * 86400000))))) {
        actions.push(`😴 Ad "${r.ad.name}" has frequency ${r.freq.toFixed(1)} — the same people are seeing it too often. New creative needed.`);
      }
    }

    // ---- Morning brief (8:00 ET) ----
    const isBrief = (t.hour === 8 && !body.force) || body.force === "brief";
    let brief = "";
    if (isBrief) {
      const lines: string[] = [];
      let sp = 0, ld = 0, cl = 0;
      for (const c of insY) {
        const l = leadsFromActions(c.actions); sp += num(c.spend); ld += l; cl += num(c.inline_link_clicks);
        lines.push(`- ${c.campaign_name}: $${num(c.spend).toFixed(0)}, ${num(c.inline_link_clicks)} clicks, ${l} Meta leads${l ? ", $" + (num(c.spend) / l).toFixed(0) + " each" : ""}`);
      }
      const crmLines = Object.entries(byContent).map(([k, v]) => `- ${k}: ${v.leads} leads, ${v.called} called, ${v.apps} past application, ${v.closed} closed`);
      const creative = rows.map((r) => `- ${r.ad.name} [${r.ad.status}]: $${r.spend.toFixed(0)} spent, ${r.clicks} clicks, ${r.leads} CRM leads${r.leads ? ", $" + r.cpl.toFixed(0) + " each" : ""}, CTR ${r.ctr.toFixed(2)}%, freq ${r.freq.toFixed(1)}`);
      brief = `Yesterday: $${sp.toFixed(0)} spent, ${cl} clicks, ${ld} Meta-reported leads${ld ? " ($" + (sp / ld).toFixed(0) + " each)" : ""}.\n\nBy campaign\n${lines.join("\n") || "- no delivery"}\n\nCRM results by creative (last 7 days)\n${crmLines.join("\n") || "- no landing-page leads yet"}\n\nManaged ads (last 7 days)\n${creative.join("\n") || "- none running yet"}\n\nMode: ${mode}. Active managed budget cap: $${(capCents / 100).toFixed(0)}/day.`;
    }

    if (actions.length || brief) {
      const subject = (actions.length ? "Ad alerts" : "Ad brief") + " — " + t.date;
      const text = (actions.length ? "WHAT I FOUND / DID\n" + actions.map((a) => "- " + a).join("\n") + "\n\n" : "") + brief + "\n\n" + CRM_URL;
      await tellJoe((actions[0] || "Morning ad brief sent.") + (actions.length > 1 ? ` (+${actions.length - 1} more, see email)` : ""), subject, text);
    }
    return new Response(JSON.stringify({ ok: true, mode, activeCampaigns: activeCamps.length, managed: managed.length, actions }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("ad-optimizer: error", String(err));
    if (await claim("opt-error-" + t.date + "-" + t.hour)) await tellJoe("The ad optimizer hit an error and couldn't check your ads: " + String(err).slice(0, 160));
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
