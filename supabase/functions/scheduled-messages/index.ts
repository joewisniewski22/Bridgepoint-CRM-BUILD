// Scheduled messages + watchdog (Joe 2026-10-15, weakness #6: "move reminders and the daily tasks off the Claude app so they don't depend on it being open").
// pg_cron calls this every minute (shared-secret auth, same as followup-engine). It does two things:
//  1. SEND: texts/emails queued in public.scheduled_messages whose send_at has passed (reminders, "notify the LOs tomorrow morning", etc.), each claimed
//     atomically so an overlapping run can't double-send; failures retry up to 3 times.
//  2. WATCHDOG (every 15 minutes): texts Joe once a day if something that quietly depends on a person or the Claude app has stopped:
//     the daily ad-optimizer run, the next day of scheduled social posts, and the A&D / HomeXpress rate snapshots (an expired lender login).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const OWNER_PHONE = "6312356723"; // Joe's cell (staff alerts only)
const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: JSON_HEADERS });

async function callFn(fn: string, payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(SUPABASE_URL + "/functions/v1/" + fn, { method: "POST", headers: { ...JSON_HEADERS, Authorization: "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j && j.ok !== false && !j.error, detail: r.ok ? JSON.stringify(j).slice(0, 160) : "http " + r.status };
  } catch (e) { return { ok: false, detail: String(e).slice(0, 160) }; }
}

async function sendDue(): Promise<{ sent: number; failed: number }> {
  // Messages stuck in "sending" for 10+ minutes (a crashed run) go back to pending.
  await sb.from("scheduled_messages").update({ status: "pending" }).eq("status", "sending").lt("claimed_at", new Date(Date.now() - 10 * 60000).toISOString());
  const { data: due } = await sb.from("scheduled_messages").select("id").eq("status", "pending").lte("send_at", new Date().toISOString()).order("send_at").limit(25);
  let sent = 0, failed = 0;
  for (const row of due || []) {
    const { data: claimed } = await sb.from("scheduled_messages").update({ status: "sending", claimed_at: new Date().toISOString() }).eq("id", row.id).eq("status", "pending").select("*").maybeSingle();
    if (!claimed) continue; // another run took it
    const attempts = (claimed.attempts || 0) + 1;
    const res = claimed.channel === "email"
      ? await callFn("send-email", { to: claimed.to_email, subject: claimed.subject || "Reminder", text: claimed.body, fromName: claimed.from_name || "Bridgepoint CRM", fromAddress: claimed.from_address || "leads@bplending.com" })
      : await callFn("send-text", { to: claimed.to_phone, text: claimed.body, fromName: claimed.from_name || "Bridgepoint" });
    if (res.ok) { await sb.from("scheduled_messages").update({ status: "sent", sent_at: new Date().toISOString(), attempts, error: null }).eq("id", claimed.id); sent++; }
    else { await sb.from("scheduled_messages").update({ status: attempts >= 3 ? "failed" : "pending", attempts, error: res.detail }).eq("id", claimed.id); if (attempts >= 3) failed++; }
  }
  return { sent, failed };
}

async function alertOnce(key: string, text: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data: recent } = await sb.from("scheduled_messages").select("id").eq("dedupe_key", key).gte("created_at", since).limit(1);
  if (recent && recent.length) return false;
  await sb.from("scheduled_messages").insert({ send_at: new Date().toISOString(), channel: "sms", to_phone: OWNER_PHONE, body: text, created_by: "watchdog", dedupe_key: key });
  return true;
}

function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false, weekday: "short" }).formatToParts(d);
  const hour = Number((f.find((p) => p.type === "hour") || {}).value) % 24;
  const wd = (f.find((p) => p.type === "weekday") || {}).value || "";
  return { hour, weekday: !["Sat", "Sun"].includes(wd) };
}

async function watchdog(): Promise<string[]> {
  const raised: string[] = [];
  const { hour, weekday } = etParts();
  const hoursAgo = (iso?: string | null) => iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : 9999;
  if (hour >= 9) {
    const { data: o } = await sb.from("ad_optimizer_log").select("ts").order("ts", { ascending: false }).limit(1);
    if (hoursAgo(o && o[0] && o[0].ts) > 30 && await alertOnce("wd-ad-optimizer", "Heads-up from your assistant: the daily Facebook ad check hasn't run in over 30 hours. The Claude app may be closed. Open it to catch up.")) raised.push("ad-optimizer");
  }
  if (hour >= 8) {
    const { count } = await sb.from("social_posts").select("id", { count: "exact", head: true }).eq("status", "scheduled").gte("scheduled_at", new Date().toISOString()).lte("scheduled_at", new Date(Date.now() + 36 * 3600000).toISOString());
    if ((count || 0) < 2 && await alertOnce("wd-social", "Heads-up from your assistant: fewer than 2 Facebook/Instagram posts are scheduled for the next 36 hours. Open the Claude app so the daily social task can queue more.")) raised.push("social");
  }
  if (weekday && hour >= 11) {
    const { data: ad } = await sb.from("lender_pricing_snapshots").select("captured_at").eq("lender", "ad").order("captured_at", { ascending: false }).limit(1);
    if (hoursAgo(ad && ad[0] && ad[0].captured_at) > 30 && await alertOnce("wd-ad-rates", "Heads-up from your assistant: A&D rates are more than a day old. Please sign in to their portal in the Claude browser so the refresh can run.")) raised.push("ad-rates");
    const { data: hx } = await sb.from("lender_pricing_snapshots").select("captured_at").eq("lender", "homex").order("captured_at", { ascending: false }).limit(1);
    if (hoursAgo(hx && hx[0] && hx[0].captured_at) > 54 && await alertOnce("wd-homex", "Heads-up from your assistant: HomeXpress rates are stale. Their login may have expired (it needs an email code every 14 days).")) raised.push("homex-rates");
  }
  return raised;
}

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const sent = await sendDue();
  const runWatchdog = body.watchdog === true || new Date().getUTCMinutes() % 15 === 0;
  const raised = runWatchdog ? await watchdog() : [];
  return json({ ok: true, ...sent, watchdog: runWatchdog ? raised : "skipped" });
});
