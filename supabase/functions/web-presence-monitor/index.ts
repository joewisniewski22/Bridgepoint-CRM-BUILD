// Daily watchdog + optimizer for bplending.com. Runs from pg_cron (shared-secret guard like the other
// ad/follow-up jobs) or on demand by the owner from the CRM.
//   1. Crawls every page in the sitemap: status, title/description/H1/canonical/schema/word count, and every
//      internal link and asset those pages point to.
//   2. Runs Google PageSpeed (mobile) on the key pages.
//   3. Reads the website funnel from our own data: estimator runs, website/ad/partner leads, this week vs last.
//   4. Asks Claude for the 3-5 most valuable fixes/experiments this week and stores them in marketing_recs.
//   5. Texts the owner if something is actually broken (once a day), and emails a Monday digest.
// Read-only toward the website and Google/Meta: it recommends, it never edits the live site or ads.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const ORIGINS = ["https://bplending.com", "https://bplending-preview.vercel.app"];
const KEY_PAGES = ["/", "/fix-and-flip-loans/", "/estimate/", "/locations/florida/"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
type Row = Record<string, unknown>;

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const get = async (url: string) => { try { const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "BridgePointSiteMonitor/1.0" } }); return { status: r.status, text: r.headers.get("content-type")?.includes("html") || r.headers.get("content-type")?.includes("xml") ? await r.text() : "" }; } catch { return { status: 0, text: "" }; } };

async function authorized(req: Request, body: Row): Promise<boolean> {
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (auth && body.secret === auth.secret) return true;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await sb.auth.getUser(token).catch(() => ({ data: null }));
  if (!data || !data.user) return false;
  const { data: u } = await sb.from("users").select("role").eq("auth_id", data.user.id).maybeSingle();
  return !!u && u.role === "owner";
}

function analyze(html: string) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "";
  const desc = (html.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || "";
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  const canon = /<link rel="canonical"/i.test(html);
  const ld = /application\/ld\+json/i.test(html);
  const noindex = /<meta name="robots" content="[^"]*noindex/i.test(html);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  const links = Array.from(html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)).map((m) => m[1]);
  return { title, desc, h1, canon, ld, noindex, words, links };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const body = (await req.json().catch(() => ({}))) as Row;
  if (!(await authorized(req, body))) return json({ error: "not_authorized" }, 403);
  const started = Date.now();
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (!body.force) {
      const { data: done } = await sb.from("web_health_log").select("id").gte("checked_at", today + "T00:00:00Z").limit(1);
      if (done && done.length) return json({ ok: true, skipped: "already ran today" });
    }

    // --- 1. Crawl -------------------------------------------------------
    let origin = ORIGINS[ORIGINS.length - 1], sitemap = "";
    for (const o of ORIGINS) {
      const s = await get(o + "/sitemap.xml");
      if (s.status === 200 && s.text.includes("<urlset") && s.text.includes("/dscr-loans/")) { origin = o; sitemap = s.text; break; }
    }
    const paths = Array.from(sitemap.matchAll(/<loc>https:\/\/bplending\.com([^<]*)<\/loc>/g)).map((m) => m[1] || "/");
    const issues: Row[] = [];
    const linkSet = new Set<string>();
    const pageInfo = await pool(paths, 10, async (p) => {
      const r = await get(origin + p);
      const a = analyze(r.text);
      a.links.forEach((l) => linkSet.add(l));
      const tool = /estimate|calculator|get-quote|thank-you|privacy|terms|^\/$|locations\/$|blog\/$|loan-programs|contact/.test(p);
      if (r.status !== 200) issues.push({ path: p, type: "http_" + r.status, sev: "high" });
      else {
        if (!a.title) issues.push({ path: p, type: "missing_title", sev: "high" });
        else if (a.title.length > 70 || a.title.length < 25) issues.push({ path: p, type: "title_length_" + a.title.length, sev: "low" });
        if (!a.desc) issues.push({ path: p, type: "missing_description", sev: "med" });
        else if (a.desc.length > 170 || a.desc.length < 60) issues.push({ path: p, type: "description_length_" + a.desc.length, sev: "low" });
        if (a.h1 !== 1) issues.push({ path: p, type: "h1_count_" + a.h1, sev: "med" });
        if (!a.canon) issues.push({ path: p, type: "missing_canonical", sev: "med" });
        if (!tool && a.words < 250) issues.push({ path: p, type: "thin_content_" + a.words + "_words", sev: "low" });
      }
      return { p, status: r.status, words: a.words };
    });
    const linkTargets = Array.from(linkSet).filter((l) => !l.startsWith("/api/"));
    const linkStatus = await pool(linkTargets, 12, async (l) => ({ l, s: (await get(origin + l)).status }));
    linkStatus.filter((x) => x.s !== 200).forEach((x) => issues.push({ path: x.l, type: "broken_link_" + x.s, sev: "high" }));
    const highs = issues.filter((i) => i.sev === "high");

    // --- 2. PageSpeed (mobile) -----------------------------------------
    const speed: Row[] = [];
    for (const kp of KEY_PAGES) {
      if (Date.now() - started > 100000) break;
      try {
        const r = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices&url=" + encodeURIComponent(origin + kp));
        if (!r.ok) { speed.push({ path: kp, error: "psi_" + r.status }); continue; }
        const d = await r.json();
        const c = d.lighthouseResult?.categories || {}, au = d.lighthouseResult?.audits || {};
        speed.push({ path: kp, performance: c.performance?.score, seo: c.seo?.score, accessibility: c.accessibility?.score, bestPractices: c["best-practices"]?.score, lcpMs: Math.round(au["largest-contentful-paint"]?.numericValue || 0), cls: au["cumulative-layout-shift"]?.numericValue });
      } catch { speed.push({ path: kp, error: "psi_failed" }); }
    }
    const perfs = speed.map((s) => s.performance as number).filter((x) => typeof x === "number");
    const minPerf = perfs.length ? Math.min(...perfs) : null;

    // --- 3. Funnel from our own data -------------------------------------
    const d7 = new Date(Date.now() - 7 * 86400000).toISOString(), d14 = new Date(Date.now() - 14 * 86400000).toISOString();
    const count = async (table: string, f: (q: any) => any) => { const { count } = await f(sb.from(table).select("*", { count: "exact", head: true })); return count || 0; };
    const funnel = {
      estimates_7d: await count("public_estimate_hits", (q) => q.gte("at", d7)),
      estimates_prev7d: await count("public_estimate_hits", (q) => q.gte("at", d14).lt("at", d7)),
      website_leads_7d: await count("leads", (q) => q.gte("created_at_ts", d7).like("source", "Website%Quote Form")),
      website_leads_prev7d: await count("leads", (q) => q.gte("created_at_ts", d14).lt("created_at_ts", d7).like("source", "Website%Quote Form")),
      ad_leads_7d: await count("leads", (q) => q.gte("created_at_ts", d7).like("source", "Meta Ads%")),
      ad_leads_prev7d: await count("leads", (q) => q.gte("created_at_ts", d14).lt("created_at_ts", d7).like("source", "Meta Ads%")),
      partner_signups_7d: await count("leads", (q) => q.gte("created_at_ts", d7).like("source", "Website - Referral Partner")),
      funded_posts_live: await count("funded_deals", (q) => q.eq("status", "approved")),
      funded_drafts_waiting: await count("funded_deals", (q) => q.eq("status", "draft")),
    };

    // --- 4. Recommendations ----------------------------------------------
    const { data: openRecs } = await sb.from("marketing_recs").select("title").eq("status", "open");
    const facts = { site: origin, pages: paths.length, high_issues: highs.slice(0, 15), issue_counts: issues.reduce((a: Record<string, number>, i) => { const k = String(i.type).replace(/_\d+.*/, ""); a[k] = (a[k] || 0) + 1; return a; }, {}), speed, funnel, open_recs: (openRecs || []).map((r: Row) => r.title) };
    const goal = "Goal: make BridgePoint Lending (business-purpose real estate investor loans: fix & flip, bridge, construction, DSCR, portfolio, commercial) the #1 investor lender online and pass Kiavi. Primary KPI: qualified investor leads that close, at low cost.";
    const prompt = goal + "\n\nHere is today's website health and funnel data as JSON:\n" + JSON.stringify(facts) + "\n\nGive the 3-5 highest-value, specific actions for THIS WEEK (technical fixes first if anything is broken, then conversion/SEO/content experiments). " +
      "Rules: do not repeat anything already in open_recs; no vague advice; each must say exactly what to change and why it should move leads or rankings; never suggest fabricating reviews, stats or testimonials; Bridgepoint is a business-purpose lender, never use the word 'broker'. " +
      "Return ONLY JSON: [{\"area\":\"site|seo|content|conversion|ads|reputation\",\"priority\":1-3,\"title\":\"...\",\"detail\":\"...\"}]";
    let recs: Row[] = [];
    try {
      const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }) });
      const ad = await ar.json();
      const m = (ad?.content?.[0]?.text || "").match(/\[[\s\S]*\]/);
      if (m) recs = JSON.parse(m[0]);
    } catch (e) { console.error("recs", String(e)); }
    const open = new Set((openRecs || []).map((r: Row) => String(r.title).toLowerCase()));
    const fresh = recs.filter((r) => r.title && !open.has(String(r.title).toLowerCase())).slice(0, 5);
    if (fresh.length) await sb.from("marketing_recs").insert(fresh.map((r) => ({ area: String(r.area || "site").slice(0, 20), priority: Math.min(3, Math.max(1, Number(r.priority) || 2)), title: String(r.title).slice(0, 160), detail: String(r.detail || "").slice(0, 1500) })));

    // --- 5. Log + alerts ---------------------------------------------------
    const summary = { origin, pages: paths.length, issues: issues.length, high: highs.length, minPerf };
    await sb.from("web_health_log").insert({ pages: paths.length, issues, speed, funnel, summary });
    const post = (fn: string, payload: Row) => fetch(SUPABASE_URL + "/functions/v1/" + fn, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload) }).catch(() => null);
    const { data: owner } = await sb.from("users").select("phone,email").eq("id", "owner").single();
    const broken = highs.length > 0 || (minPerf !== null && minPerf < 0.4);
    if (broken && owner?.phone && !body.quiet) await post("send-text", { to: owner.phone, text: "Website check: " + highs.length + " broken page/link(s)" + (minPerf !== null && minPerf < 0.4 ? ", mobile speed score " + Math.round(minPerf * 100) : "") + ". Details are in the CRM under Website Posts > Site health.", fromName: "Bridgepoint CRM" });
    if (new Date().getUTCDay() === 1 && owner?.email && !body.quiet) {
      const lines = ["Weekly website report", "", "Pages checked: " + paths.length + " | Issues: " + issues.length + " (" + highs.length + " serious)", "Estimator runs: " + funnel.estimates_7d + " (last week " + funnel.estimates_prev7d + ")", "Website leads: " + funnel.website_leads_7d + " (last week " + funnel.website_leads_prev7d + ")", "Ad leads: " + funnel.ad_leads_7d + " (last week " + funnel.ad_leads_prev7d + ")", "Partner sign-ups: " + funnel.partner_signups_7d, "Funded posts live: " + funnel.funded_posts_live + " | waiting for your OK: " + funnel.funded_drafts_waiting, "", "This week's recommendations:"].concat(fresh.map((r, i) => (i + 1) + ". " + r.title + " - " + r.detail));
      await post("send-email", { to: owner.email, subject: "Weekly website report - BridgePoint Lending", text: lines.join("\n"), fromName: "Bridgepoint CRM" });
    }
    return json({ ok: true, ...summary, funnel, newRecs: fresh.length });
  } catch (e) {
    console.error("web-presence-monitor", String(e));
    return json({ error: "server_error", detail: String(e) }, 500);
  }
});
