// Social engagement engine (Joe 2026-10-14: "take control of both platforms with posts and engagement" -- the goal is CLOSED DEALS, not
// followers). Every ~20 minutes, replies to new comments on the Page's Facebook posts and the Instagram account's posts, hides spam,
// and escalates anything a person should handle. Every reply moves the commenter toward a conversation (message us / call / Deal
// Analyzer). Real leads are already captured and privately messaged by meta-leads-webhook (handleSocial); when a commenter was captured
// as a lead, the public reply just says a private message is on its way.
//
// Guardrails (hard): never quote or promise a rate, approval, timeline or fee; no lender names; no borrower personal/financial details in
// public; investor / business-purpose property only (consumer mortgage questions get a polite redirect); never argue; complaints, legal
// threats, press and anything about a specific loan go to a human; at most `daily_cap` replies a day and `max_per_run` per run.
// social_engage_config.mode = 'draft' only logs what it would send; 'live' posts. enabled=false stops it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = (Deno.env.get("META_SOCIAL_TOKEN") || Deno.env.get("META_ACCESS_TOKEN"))!;
const PAGE_ID = Deno.env.get("META_PAGE_ID")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-haiku-4-5-20251001";
const G = "https://graph.facebook.com/v21.0";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

async function g(path: string, params: Record<string, string> = {}, method: "GET" | "POST" = "GET", token = TOKEN) {
  const url = new URL(G + path);
  let res: Response;
  if (method === "GET") {
    url.searchParams.set("access_token", token);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    res = await fetch(url.toString());
  } else {
    res = await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...params, access_token: token }) });
  }
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

const RULES = `You manage replies to public comments for BridgePoint Lending, a private lender that makes BUSINESS-PURPOSE loans to real estate INVESTORS: DSCR rental loans, fix & flip, bridge, ground-up construction, portfolio. The goal of every reply is to start a real conversation that can become a funded loan -- not to look popular.
Reply style: 1-2 short, friendly, human sentences (max 220 characters). At most one emoji. No hashtags. Vary the wording; never sound like a bot or a template.
Always end by moving them toward the next step, using ONE of: "message us here", "call (850) 279-8588", or the free Deal Analyzer at bplending.com/deal-analyzer.
HARD RULES: never state or hint at a rate, price, approval, closing time or fee; never guarantee anything; never name any other lender or company; never ask for or accept SSN, account numbers or other sensitive details in public; do not discuss owner-occupied/consumer home mortgages (politely say we focus on investor loans); never argue or get defensive; no legal or tax advice.
Actions: "reply" (normal question, interest, praise, or a comment worth a friendly answer); "hide" (spam, scams, promotions, crypto/forex, adult, hate, obvious bots, links to other businesses); "ignore" (emoji-only, one-word reactions, tagging a friend, off-topic chatter that needs no answer); "escalate" (complaint, anger, legal threat, press, accusations, something about a specific existing loan, a current borrower, a request for specific rates or terms on a real deal where a person should respond, or anything you are unsure about -- for escalate also write a safe holding reply like "Thanks for reaching out -- please message us here so our team can help directly.").
Return ONLY JSON: {"action":"reply|hide|ignore|escalate","category":"question|interest|praise|rates|spam|negative|other","reply":"text or empty","reason":"short"}.`;

async function decide(post: string, comment: string, author: string, platform: string): Promise<{ action: string; category: string; reply: string; reason: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, system: RULES,
      messages: [{ role: "user", content: "Platform: " + platform + "\nOur post: " + String(post || "").slice(0, 600) + "\n\nComment from " + (author || "someone") + ": " + String(comment).slice(0, 800) + "\n\nJSON only." }],
    }),
  });
  const d = await res.json().catch(() => null);
  const raw = (d && d.content && d.content[0] && d.content[0].text) || "";
  try {
    const p = JSON.parse((raw.match(/\{[\s\S]*\}/) || [raw])[0]);
    const action = ["reply", "hide", "ignore", "escalate"].includes(p.action) ? p.action : "escalate";
    return { action, category: String(p.category || "other"), reply: String(p.reply || "").slice(0, 300), reason: String(p.reason || "").slice(0, 200) };
  } catch (_) {
    return { action: "escalate", category: "other", reply: "", reason: "could not parse the model's answer" };
  }
}

// Last-line safety check on any text we are about to post, whatever the model said.
function unsafe(t: string): string | null {
  if (/\b\d{1,2}(\.\d+)?\s?%/.test(t)) return "mentions a percentage/rate";
  if (/\b(guarantee|guaranteed|approved?|approval|pre-?approved|lowest|best rate|no fee|zero fee|same[- ]day)\b/i.test(t)) return "promise/guarantee language";
  if (/\b(kiavi|rcn|velocity|dominion|nextres|lend investors|a&d|homexpress|constructive|roc capital|anchor)\b/i.test(t)) return "names another company";
  if (/\bssn\b|social security|account number|routing/i.test(t)) return "asks for sensitive info";
  return null;
}

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* cron sends a body */ }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const { data: cfg } = await sb.from("social_engage_config").select("*").eq("id", 1).single();
  if (!cfg || !cfg.enabled) return json({ ok: true, skipped: "disabled" });
  const live = body.forceMode ? body.forceMode === "live" : cfg.mode === "live";

  const since = new Date(Date.now() - 4 * 86400000).toISOString();
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const { count: repliedToday } = await sb.from("social_engagement_log").select("ext_id", { count: "exact", head: true }).eq("status", "replied").gte("created_at", dayStart.toISOString());
  let budget = Math.max(0, Math.min(cfg.max_per_run, cfg.daily_cap - (repliedToday || 0)));

  const pg = await g("/" + PAGE_ID, { fields: "access_token,instagram_business_account{id,username}" });
  const pt: string = pg.data && pg.data.access_token;
  if (!pt) return json({ ok: false, error: "no_page_token", detail: pg.data && pg.data.error ? pg.data.error.message : null }, 502);
  const igId: string | null = pg.data.instagram_business_account ? pg.data.instagram_business_account.id : null;
  const igName: string = pg.data.instagram_business_account ? String(pg.data.instagram_business_account.username || "") : "";

  if (body.debug) {
    const ps = await g("/" + PAGE_ID + "/posts", { fields: "id,created_time,comments.summary(true).limit(3){id,message,from,created_time}", limit: "8" }, "GET", pt);
    const media = igId ? await g("/" + igId + "/media", { fields: "id,timestamp,comments_count,like_count,comments.limit(3){id,text,username,timestamp}", limit: "8" }, "GET", pt) : null;
    return json({ igId, igName, fbError: ps.data && ps.data.error ? ps.data.error : null, fbPosts: ((ps.data && ps.data.data) || []).map((p: any) => ({ t: p.created_time, total: p.comments && p.comments.summary ? p.comments.summary.total_count : null, got: p.comments && p.comments.data ? p.comments.data.length : 0 })), igError: media && media.data && media.data.error ? media.data.error : null, igMedia: media && media.data && media.data.data ? media.data.data.map((m: any) => ({ t: m.timestamp, comments_count: m.comments_count, got: m.comments && m.comments.data ? m.comments.data.length : 0 })) : null });
  }
  type Cand = { ext: string; platform: "facebook" | "instagram"; id: string; postId: string; post: string; text: string; author: string; authorId: string };
  const cands: Cand[] = [];
  // Facebook: comments on the Page's own recent posts.
  const posts = await g("/" + PAGE_ID + "/posts", { fields: "id,message,created_time", limit: "12" }, "GET", pt);
  for (const p of (posts.data && posts.data.data) || []) {
    const cs = await g("/" + p.id + "/comments", { fields: "id,message,from{id,name},created_time", filter: "toplevel", order: "reverse_chronological", limit: "30" }, "GET", pt);
    for (const c of (cs.data && cs.data.data) || []) {
      if (!c.message || (c.from && String(c.from.id) === PAGE_ID) || c.created_time < since) continue;
      cands.push({ ext: "fb:" + c.id, platform: "facebook", id: c.id, postId: p.id, post: p.message || "", text: c.message, author: (c.from && c.from.name) || "", authorId: (c.from && String(c.from.id)) || "" });
    }
  }
  // Instagram: comments on the account's recent media.
  if (igId) {
    const media = await g("/" + igId + "/media", { fields: "id,caption,timestamp", limit: "12" }, "GET", pt);
    for (const m of (media.data && media.data.data) || []) {
      const cs = await g("/" + m.id + "/comments", { fields: "id,text,username,timestamp", limit: "30" }, "GET", pt);
      for (const c of (cs.data && cs.data.data) || []) {
        if (!c.text || String(c.username || "").toLowerCase() === igName.toLowerCase() || c.timestamp < since) continue;
        cands.push({ ext: "ig:" + c.id, platform: "instagram", id: c.id, postId: m.id, post: m.caption || "", text: c.text, author: c.username || "", authorId: c.username || "" });
      }
    }
  }
  // Comments Meta pushed to the webhook (no read-comments permission needed): Facebook and Instagram.
  const { data: inbox } = await sb.from("social_engagement_inbox").select("*").gte("created_at", since).limit(200);
  for (const r of inbox || []) {
    if (cands.some((c) => c.ext === r.ext_id)) continue;
    cands.push({ ext: r.ext_id, platform: r.platform, id: String(r.ext_id).replace(/^(fb|ig):/, ""), postId: r.post_id || "", post: "", text: r.text || "", author: r.author || "", authorId: r.author_id || "" });
  }
  // What this token may do: public Facebook replies and hiding need pages_manage_engagement.
  const perms = await g("/me/permissions");
  const granted: string[] = ((perms.data && perms.data.data) || []).filter((p: any) => p.status === "granted").map((p: any) => p.permission);
  const canFbReply = granted.includes("pages_manage_engagement");
  let blockedFb = 0;
  if (!canFbReply) { const before = cands.length; for (let i = cands.length - 1; i >= 0; i--) if (cands[i].platform === "facebook") cands.splice(i, 1); blockedFb = before - cands.length; }
  if (!cands.length) return json({ ok: true, live, found: 0, blockedFacebookNeedsPermission: blockedFb, fbReadError: posts.data && posts.data.error ? posts.data.error.message : null });
  const { data: seen } = await sb.from("social_engagement_log").select("ext_id").in("ext_id", cands.map((c) => c.ext));
  const seenSet = new Set((seen || []).map((r: any) => r.ext_id));
  const fresh = cands.filter((c) => !seenSet.has(c.ext)).sort((a, b) => a.ext.localeCompare(b.ext));
  const out = { ok: true, live, found: cands.length, fresh: fresh.length, blockedFacebookNeedsPermission: blockedFb, replied: 0, drafted: 0, hidden: 0, ignored: 0, escalated: 0, failed: 0, deferred: 0, sample: [] as unknown[] };
  const escalations: string[] = [];

  for (const c of fresh) {
    // Anything a lead-capture already handled gets a short public pointer to the private message.
    const { data: prospect } = await sb.from("social_prospects").select("lead_id").eq("external_id", c.ext).maybeSingle();
    let d = await decide(c.post, c.text, c.author, c.platform);
    if (prospect && prospect.lead_id && (d.action === "reply" || d.action === "escalate")) d = { action: "reply", category: "interest", reply: "Thanks for reaching out! We just sent you a private message with next steps.", reason: "lead already captured" };
    if (d.action === "reply" || d.action === "escalate") {
      const bad = unsafe(d.reply);
      if (bad && d.action === "reply") d = { action: "escalate", category: d.category, reply: "Thanks for reaching out -- please message us here so our team can help directly.", reason: "blocked by safety check: " + bad };
    }
    const row: Record<string, unknown> = { ext_id: c.ext, platform: c.platform, post_id: c.postId, author: c.author, author_id: c.authorId, text: c.text.slice(0, 1000), category: d.category, action: d.action, reply: d.reply || null, lead_id: prospect ? prospect.lead_id : null, status: "ignored" };
    const needsSend = (d.action === "reply" || d.action === "escalate") && d.reply;
    if (needsSend && budget <= 0) { out.deferred++; continue; } // over today's / this run's cap: pick it up next run
    if (d.action === "ignore") { row.status = "ignored"; out.ignored++; }
    else if (d.action === "hide") {
      if (live) {
        const r = c.platform === "facebook" ? await g("/" + c.id, { is_hidden: "true" }, "POST", pt) : await g("/" + c.id, { hide: "true" }, "POST", pt);
        row.status = r.ok ? "hidden" : "failed"; if (!r.ok) row.error = JSON.stringify(r.data).slice(0, 300);
        r.ok ? out.hidden++ : out.failed++;
      } else { row.status = "drafted"; out.drafted++; }
    } else if (needsSend) {
      if (live) {
        const r = c.platform === "facebook" ? await g("/" + c.id + "/comments", { message: d.reply }, "POST", pt) : await g("/" + c.id + "/replies", { message: d.reply }, "POST", pt);
        if (r.ok) { row.status = d.action === "escalate" ? "escalated" : "replied"; budget--; out.replied++; if (c.platform === "facebook") await g("/" + c.id + "/likes", {}, "POST", pt); }
        else { row.status = "failed"; row.error = JSON.stringify(r.data).slice(0, 300); out.failed++; }
      } else { row.status = d.action === "escalate" ? "escalated" : "drafted"; out.drafted++; budget--; }
      if (d.action === "escalate") { out.escalated++; escalations.push((c.platform === "facebook" ? "Facebook" : "Instagram") + " — " + (c.author || "someone") + ": \"" + c.text.slice(0, 160) + "\" (" + d.reason + ")"); }
    } else if (d.action === "escalate") {
      row.status = "escalated"; out.escalated++; escalations.push((c.platform === "facebook" ? "Facebook" : "Instagram") + " — " + (c.author || "someone") + ": \"" + c.text.slice(0, 160) + "\" (" + d.reason + ")");
    }
    await sb.from("social_engagement_log").upsert(row, { onConflict: "ext_id" });
    if (out.sample.length < 12) out.sample.push({ platform: c.platform, author: c.author, text: c.text.slice(0, 140), action: d.action, category: d.category, reply: d.reply, status: row.status, reason: d.reason });
  }
  if (escalations.length) {
    await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: null, kind: "social", text: "💬 Social needs a person (" + escalations.length + "): " + escalations.slice(0, 3).join(" | "), date: new Date().toISOString().slice(0, 10), read: false });
  }
  return json(out);
});
