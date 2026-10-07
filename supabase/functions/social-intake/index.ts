// Social lead capture (Joe 2026-10-07: "for 2 3 4 i want to actually capture the lead
// automatically in the system"). Turns social posts into scored prospects with an AI-drafted
// reply, and converts them into CRM leads.
//
// Actions (POST JSON):
//   reddit-scan { secret }                 -- cron: searches investor subreddits for financing
//                                             questions (Reddit app-only OAuth; needs
//                                             REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET)
//   paste { platform, text, handle?, url? } -- staff: a Facebook-group (or any) post pasted in
//   convert { prospectId }                 -- staff: create a CRM lead from a prospect
//   classify { text }                      -- staff/test: score + draft only
//
// Never posts on anyone's behalf: Reddit bans automated promotion and Facebook groups have no
// API, so replies are drafted for a person to post. Facebook/Instagram comments and DMs on
// OUR page are captured fully automatically in meta-leads-webhook.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const REDDIT_CLIENT_ID = Deno.env.get("REDDIT_CLIENT_ID") || "";
const REDDIT_CLIENT_SECRET = Deno.env.get("REDDIT_CLIENT_SECRET") || "";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

// Where investors ask financing questions, and what they say when they need a lender.
const SUBREDDITS = ["realestateinvesting", "RealEstate", "flipping", "Landlord", "realestatefinance", "HardMoneyLenders", "BiggerPockets"];
const QUERIES = ["hard money lender", "fix and flip loan", "DSCR loan", "rental property loan LLC", "bridge loan investment property", "need financing flip", "ground up construction loan", "cash out refinance rental"];

export type Classified = { intent: "high" | "medium" | "low" | "none"; loan_type: string | null; summary: string; reply: string; spanish?: boolean };

export async function classify(text: string, platform: string): Promise<Classified> {
  const fallback: Classified = { intent: "low", loan_type: null, summary: text.slice(0, 140), reply: "" };
  if (!ANTHROPIC_API_KEY) return fallback;
  const prompt = "You screen social media posts for Bridgepoint Lending, a lender for real estate INVESTORS only (business-purpose: fix & flip, bridge, ground-up construction, DSCR rental loans, portfolio). Not owner-occupied home mortgages.\n" +
    "Score how likely this person is a real investor who needs (or will soon need) that kind of financing: high = actively looking for a lender/loan now; medium = investor discussing a deal where financing is relevant; low = investor but no financing need; none = homeowner/consumer, spam, a lender/broker advertising, or off-topic.\n" +
    "Then draft a short, genuinely helpful reply (2-3 sentences, plain, no emojis, no rates, no promises of approval, no hard sell) that answers their actual question and offers to run numbers. For Reddit, NEVER include links or company promotion beyond a light 'happy to help, DM me'. For Facebook/Instagram it may mention Bridgepoint Lending. Reply in Spanish if they wrote in Spanish.\n" +
    "Platform: " + platform + "\nPost:\n\"\"\"" + text.slice(0, 3000) + "\"\"\"\n\n" +
    'Return ONLY JSON: {"intent":"high|medium|low|none","loan_type":"Fix & Flip|Bridge|Ground Up Construction|DSCR|Portfolio/Blanket|null","summary":"one sentence: who they are and what they need","reply":"the drafted reply","spanish":true|false}';
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    const d = await r.json();
    const raw = (d.content || []).find((c: Record<string, unknown>) => c.type === "text")?.text || "";
    const m = raw.match(/\{[\s\S]*\}/);
    const p = JSON.parse(m ? m[0] : raw);
    const intent = ["high", "medium", "low", "none"].includes(p.intent) ? p.intent : "low";
    const lt = ["Fix & Flip", "Bridge", "Ground Up Construction", "DSCR", "Portfolio/Blanket"].includes(p.loan_type) ? p.loan_type : null;
    return { intent, loan_type: lt, summary: String(p.summary || "").slice(0, 300), reply: String(p.reply || "").slice(0, 1200), spanish: !!p.spanish };
  } catch (_e) { return fallback; }
}

async function staffFrom(req: Request): Promise<{ id: string; name: string; role: string } | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  if (token === SERVICE_ROLE_KEY) return { id: "owner", name: "System", role: "owner" };
  const { data } = await sb.auth.getUser(token).catch(() => ({ data: null as any }));
  const authId = data && data.user && data.user.id;
  if (!authId) return null;
  const { data: u } = await sb.from("users").select("id,name,role").eq("auth_id", authId).maybeSingle();
  return u || null;
}

async function redditToken(): Promise<string> {
  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "Authorization": "Basic " + btoa(REDDIT_CLIENT_ID + ":" + REDDIT_CLIENT_SECRET), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "web:bridgepoint-crm:1.0 (by /u/bridgepointlending)" },
    body: "grant_type=client_credentials",
  });
  const d = await r.json().catch(() => ({}));
  return d.access_token || "";
}

async function redditScan() {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return { ok: false, error: "reddit_not_configured", detail: "Add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in Supabase secrets." };
  const tok = await redditToken();
  if (!tok) return { ok: false, error: "reddit_auth_failed" };
  const seen = new Set<string>();
  const posts: Record<string, any>[] = [];
  for (const q of QUERIES) {
    const url = "https://oauth.reddit.com/r/" + SUBREDDITS.join("+") + "/search?restrict_sr=1&sort=new&t=week&limit=25&q=" + encodeURIComponent(q);
    const d = await fetch(url, { headers: { "Authorization": "Bearer " + tok, "User-Agent": "web:bridgepoint-crm:1.0 (by /u/bridgepointlending)" } }).then((r) => r.json()).catch(() => null);
    for (const c of (d && d.data && d.data.children) || []) {
      const p = c.data; if (!p || seen.has(p.name)) continue; seen.add(p.name);
      if ((Date.now() / 1000 - p.created_utc) > 7 * 86400) continue;
      posts.push(p);
    }
  }
  // Skip anything already captured.
  const ids = posts.map((p) => "reddit:" + p.name);
  const { data: have } = ids.length ? await sb.from("social_prospects").select("external_id").in("external_id", ids) : { data: [] as any[] };
  const known = new Set((have || []).map((h: any) => h.external_id));
  let added = 0, scored = 0;
  for (const p of posts) {
    if (known.has("reddit:" + p.name) || scored >= 40) continue;
    const text = (p.title || "") + "\n\n" + (p.selftext || "");
    const c = await classify(text, "reddit"); scored++;
    if (c.intent !== "high" && c.intent !== "medium") {
      // Remember low-value posts so they aren't re-scored, but keep them out of the list.
      await sb.from("social_prospects").insert({ id: "SP" + crypto.randomUUID().slice(0, 10), platform: "reddit", kind: "post", handle: "u/" + p.author, post_url: "https://www.reddit.com" + p.permalink, external_id: "reddit:" + p.name, text: text.slice(0, 4000), intent: c.intent, status: "dismissed", summary: c.summary });
      continue;
    }
    await sb.from("social_prospects").insert({
      id: "SP" + crypto.randomUUID().slice(0, 10), platform: "reddit", kind: "post", handle: "u/" + p.author, display_name: p.author,
      profile_url: "https://www.reddit.com/user/" + p.author, post_url: "https://www.reddit.com" + p.permalink, external_id: "reddit:" + p.name,
      text: text.slice(0, 4000), intent: c.intent, loan_type: c.loan_type, summary: c.summary, ai_reply: c.reply, status: "new", assigned_to: "owner",
    });
    added++;
  }
  if (added) {
    await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: null, kind: "social", text: "🔎 " + added + " new investor" + (added > 1 ? "s" : "") + " asking about financing on Reddit — replies drafted in Social.", date: new Date().toISOString().slice(0, 10), read: false });
  }
  return { ok: true, found: posts.length, scored, added };
}

async function convert(prospectId: string, staff: { id: string; name: string }) {
  const { data: p } = await sb.from("social_prospects").select("*").eq("id", prospectId).maybeSingle();
  if (!p) return { ok: false, error: "not_found" };
  if (p.lead_id) return { ok: true, leadId: p.lead_id, existing: true };
  const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const label = ({ reddit: "Reddit", x: "X (Twitter)", fb_group: "Facebook Group", facebook: "Facebook", instagram: "Instagram" } as Record<string, string>)[p.platform] || "Social";
  const assignee = p.assigned_to || staff.id || "owner";
  const { error } = await sb.from("leads").insert({
    id, name: p.display_name || p.handle || label + " prospect", source: label, loan_type: p.loan_type, stage: "new", status: "active",
    assigned_to: assignee, created_at: today, created_at_ts: new Date().toISOString(), entity_type: "LLC", application_token: crypto.randomUUID(),
    activity: [
      { date: today, type: "note", author: staff.name, text: "Captured from " + label + (p.handle ? " (" + p.handle + ")" : "") + ": " + (p.summary || "") + (p.post_url ? " — " + p.post_url : "") },
      { date: today, type: "note", author: "System", text: "Their post: " + String(p.text || "").slice(0, 800) },
    ],
  });
  if (error) return { ok: false, error: error.message };
  await sb.from("social_prospects").update({ lead_id: id, status: "converted", updated_at: new Date().toISOString() }).eq("id", prospectId);
  return { ok: true, leadId: id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "reddit-scan") {
      const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
      if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
      return json(await redditScan());
    }
    const staff = await staffFrom(req);
    if (!staff) return json({ error: "not_authorized" }, 403);
    if (body.action === "classify") return json({ ok: true, result: await classify(String(body.text || ""), String(body.platform || "facebook")) });
    if (body.action === "paste") {
      const text = String(body.text || "").trim();
      if (text.length < 15) return json({ error: "too_short" }, 400);
      const platform = ["fb_group", "facebook", "instagram", "reddit", "x"].includes(body.platform) ? body.platform : "fb_group";
      const c = await classify(text, platform === "fb_group" ? "facebook group" : platform);
      const row = { id: "SP" + crypto.randomUUID().slice(0, 10), platform, kind: "pasted", handle: body.handle || null, display_name: body.handle || null, post_url: body.url || null,
        external_id: platform + ":paste:" + crypto.randomUUID().slice(0, 12), text: text.slice(0, 4000), intent: c.intent, loan_type: c.loan_type, summary: c.summary, ai_reply: c.reply, status: "new", assigned_to: staff.id };
      await sb.from("social_prospects").insert(row);
      return json({ ok: true, prospect: row });
    }
    if (body.action === "convert") return json(await convert(String(body.prospectId || ""), staff));
    return json({ error: "unknown_action" }, 400);
  } catch (e) { return json({ error: "server_error", detail: String(e) }, 500); }
});
