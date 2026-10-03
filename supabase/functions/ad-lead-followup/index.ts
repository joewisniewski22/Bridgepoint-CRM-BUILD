// Follow-up engine for Meta-ad leads. Runs every 5 minutes via pg_cron.
// Goal (Joe, 2026-10-03): turn the ad spend into ~7 closed deals per 3 months.
// Four jobs, all idempotent through the ad_followup_log table (a separate table,
// not a flag on the lead, because the CRM client re-saves whole lead rows and
// would overwrite anything written here -- same reason callback_reminders_sent
// is its own table):
//
//  1. SPEED-TO-LEAD NAGGING. A lead nobody has called gets escalating texts to
//     the assigned loan officer (5 min, 15 min, 30 min + Joe, 60 min + Joe, then
//     every 2 hours) until a call attempt is logged.
//  2. BORROWER NURTURE. Landing-page leads (the only ones with recorded text
//     consent) get up to 10 AI-written touches over 30 days under their loan
//     officer's name. It stops the moment they reply recently, say STOP, the
//     LO pauses automation, or the file moves past qualifying.
//  3. LO ACCOUNTABILITY. Three times a day (9:00, 1:00, 4:30 Eastern) each loan
//     officer is texted exactly which ad leads need action; the 4:30 pass also
//     tells Joe who is behind.
//  4. SCOREBOARD. 5:00 Eastern daily text + email to Joe: leads, speed to first
//     call, per-LO activity, applications, and deals closed against the goal.
//
// Staff nags only go 8am-9pm Eastern; borrower touches only 9am-7pm Eastern.
// (The very first text/email on a new lead is sent by ad-lead-intake at any
// hour -- Joe's call.)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const LAUNCH_DATE = "2026-10-03";
const GOAL_DEALS = 7;
const NURTURE_STAGES = ["new", "attempting", "qualifying"];
const MIN_GAP_MS = 20 * 3600 * 1000; // between automated borrower touches

type Row = Record<string, any>;

function et(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: parseInt(g("hour"), 10) % 24, minute: parseInt(g("minute"), 10) };
}
const first = (n: string) => String(n || "").trim().split(/\s+/)[0] || "there";
const post = (fn: string, payload: Record<string, unknown>) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload),
}).catch(() => null);

// Atomically claim a (lead, step). False = already done, so never double-send.
async function claim(leadId: string, step: string, detail = ""): Promise<boolean> {
  const { error } = await sb.from("ad_followup_log").insert({ lead_id: leadId, step, detail });
  return !error;
}

const users: Record<string, Row> = {};
async function loadUsers() {
  const { data } = await sb.from("users").select("id,name,phone,email,photo_url,role");
  (data || []).forEach((u: Row) => { users[u.id] = u; });
}
async function textStaff(userId: string, text: string, leadId: string | null, kind = "nag") {
  const u = users[userId];
  if (!u) return;
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: userId, lead_id: leadId, kind, text: text.slice(0, 240), date: et().date, read: false });
  if (u.phone) await post("send-text", { to: u.phone, text: "Bridgepoint CRM: " + text, fromName: "Bridgepoint CRM" });
}

function hasReplied(l: Row, withinDays: number | null): boolean {
  const today = new Date(et().date + "T12:00:00Z").getTime();
  return ((l.activity as Row[]) || []).some((a) => {
    if (a.type !== "text" || typeof a.text !== "string" || !/^Received \(via/.test(a.text)) return false;
    if (withinDays == null) return true;
    const dt = new Date((a.date || "1970-01-01") + "T12:00:00Z").getTime();
    return (today - dt) / 86400000 < withinDays;
  });
}
function isContacted(l: Row): boolean {
  return ((l.call_attempts as unknown[]) || []).length > 0 || !!l.first_attempt_at || (l.stage && l.stage !== "new");
}
function answersOf(l: Row): string {
  const a = ((l.activity as Row[]) || []).find((x) => typeof x.text === "string" && x.text.indexOf("Landing page answers") === 0);
  return a ? String(a.text).replace("Landing page answers — ", "") : "";
}
function hasConsent(l: Row): boolean {
  return ((l.activity as Row[]) || []).some((a) => typeof a.text === "string" && a.text.indexOf("TCPA consent recorded") === 0);
}

// ---------------------------------------------------------------------------
// Borrower nurture schedule (minutes after the lead was created)
// ---------------------------------------------------------------------------
const TOUCHES: Array<{ k: string; after: number; ch: "text" | "email"; subject?: string; angle: string; stop?: boolean; app?: boolean }> = [
  { k: "t01", after: 120, ch: "text", stop: true, angle: "A friendly quick check-in. You saw their form, you can run numbers on their deal, ask what time is best to talk." },
  { k: "t02", after: 1 * 1440, ch: "text", angle: "Ask ONE easy discovery question about their deal: do they have a property under contract or identified, and what is their timeline." },
  { k: "t03", after: 2 * 1440, ch: "email", subject: "How we'll get your deal funded", angle: "A short helpful email: in 3 plain steps (tell us the deal, we send real numbers, we handle the file to closing). Invite them to reply with the property address." },
  { k: "t04", after: 3 * 1440, ch: "text", stop: true, angle: "A very easy yes/no question: are they still looking to move on a deal? Keep it light." },
  { k: "t05", after: 5 * 1440, ch: "text", angle: "Offer to put together a ballpark loan number if they text the property address." },
  { k: "t06", after: 7 * 1440, ch: "email", subject: "Why speed wins deals", angle: "A brief email on why investors who line up financing early win more deals and negotiate better. No statistics, no promises. Invite a quick call." },
  { k: "t07", after: 10 * 1440, ch: "text", stop: true, angle: "Check whether their timeline has changed or if a different kind of loan would fit better." },
  { k: "t08", after: 14 * 1440, ch: "text", app: true, angle: "Offer the application link: it takes a few minutes to start and gets them a firm quote faster." },
  { k: "t09", after: 21 * 1440, ch: "email", subject: "Still planning a deal?", angle: "A short, warm last-chance style email with the application link and your direct availability. No pressure." },
  { k: "t10", after: 30 * 1440, ch: "text", stop: true, app: true, angle: "A polite break-up message: you'll close their file unless they'd like to move ahead, and they can text back any time in the future." },
];

async function generate(touch: typeof TOUCHES[number], l: Row, lo: Row): Promise<{ subject: string; body: string } | null> {
  const bookingLink = CRM_URL + "?book=" + l.assigned_to;
  const appLink = CRM_URL.replace(/\/$/, "") + "/?apply=" + l.id + "&t=" + (l.application_token || "");
  const prompt = "You are " + lo.name + ", a loan officer at Bridgepoint Lending (business-purpose real estate investor loans, not consumer mortgages). " +
    "Write ONE " + (touch.ch === "text" ? "text message (max 2 short sentences, plain, friendly, no emojis)" : "short email (max 90 words, plain text, no markdown, sign off with just your first name)") + " to " + first(l.name) + ", an investor who filled out our " + (l.loan_type || "loan") + " web form " + Math.max(1, Math.round((Date.now() - new Date(l.created_at_ts).getTime()) / 86400000)) + " day(s) ago and hasn't gone further. " +
    "Goal of this message: " + touch.angle + " " +
    (touch.ch === "text" ? "Include this booking link only if it fits naturally: " + bookingLink + ". " : "Booking link you may include: " + bookingLink + ". ") +
    (touch.app ? "Include this application link: " + appLink + ". " : "") +
    "What they told us on the form: " + (answersOf(l) || "not much") + ". " +
    "Never quote a rate, fee, approval or closing time. Never invent facts or numbers. Do not mention that this is automated. " +
    (touch.ch === "email" ? "Reply with the body text only (no subject line)." : "Reply with ONLY the message text.");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 320, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await res.json();
    let body = res.ok ? String(j.content?.[0]?.text || "").trim() : "";
    if (!body) return null;
    if (touch.ch === "text" && touch.stop && body.length < 240) body += " Reply STOP to opt out.";
    return { subject: touch.subject || "Following up on your loan request", body };
  } catch (_e) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  // Cron / server only: this sends texts, so it must not be triggerable from the open internet.
  // The cron job sends a shared secret kept in the ad_followup_auth table (RLS on,
  // no policies, so only the service role can read it). The service-role key in
  // the pg_cron command isn't byte-identical to this function's env key, so a
  // plain key comparison rejects the cron itself.
  const body = await req.json().catch(() => ({}));
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || !body || body.secret !== auth.secret) {
    return new Response(JSON.stringify({ error: "not_authorized" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  const now = new Date();
  const t = et(now);
  const staffWindow = t.hour >= 8 && t.hour < 21;
  const borrowerWindow = t.hour >= 9 && t.hour < 19;
  const out: Record<string, number> = { sla: 0, touches: 0, nags: 0, escalations: 0, scoreboard: 0 };

  try {
    await loadUsers();
    const since = new Date(Date.now() - 45 * 86400000).toISOString();
    const { data: leadsData, error } = await sb.from("leads")
      .select("id,name,phone,email,loan_type,assigned_to,stage,status,source,created_at_ts,first_attempt_at,call_attempts,last_contact_at,activity,automation_paused,application_token")
      .like("source", "Meta Ads%").gte("created_at_ts", since);
    if (error) throw new Error(error.message);
    const all: Row[] = leadsData || [];
    const active = all.filter((l) => l.status === "active");

    const ids = all.map((l) => l.id as string);
    const logged: Record<string, Record<string, string>> = {};
    if (ids.length) {
      const { data: logRows } = await sb.from("ad_followup_log").select("lead_id,step,sent_at").in("lead_id", ids);
      (logRows || []).forEach((r: Row) => { (logged[r.lead_id] = logged[r.lead_id] || {})[r.step] = r.sent_at; });
    }
    const done = (l: Row, step: string) => !!(logged[l.id] && logged[l.id][step]);

    // ---------------- 1. Speed-to-lead nagging ----------------
    if (staffWindow) {
      for (const l of active) {
        if (isContacted(l)) continue;
        const loId = (l.assigned_to as string) || "owner";
        const lo = users[loId];
        if (!lo) continue;
        const ageMin = (Date.now() - new Date(l.created_at_ts).getTime()) / 60000;
        if (ageMin < 5 || ageMin > 72 * 60) continue;
        const steps: Array<{ k: string; joe?: boolean; msg: (m: number) => string }> = [];
        const link = CRM_URL + "?lead=" + l.id;
        const ph = l.phone ? " " + l.phone : "";
        if (ageMin >= 5) steps.push({ k: "sla05", msg: (m) => `⏰ ${l.name} filled out a ${l.loan_type || ""} form ${m} min ago and nobody has called. Speed wins these — call now${ph}: ${link}` });
        if (ageMin >= 15) steps.push({ k: "sla15", msg: (m) => `🚨 ${l.name} has been waiting ${m} min for a call. The first call is what closes these.${ph} ${link}` });
        if (ageMin >= 30) steps.push({ k: "sla30", joe: true, msg: (m) => `🔴 ${m} min and ${l.name} still hasn't been called.${loId !== "owner" ? " Joe has been notified." : ""}${ph} ${link}` });
        if (ageMin >= 60) steps.push({ k: "sla60", joe: true, msg: (m) => `🔴🔴 ${l.name} has now waited ${Math.round(m / 60 * 10) / 10}h with no call. Call immediately.${ph} ${link}` });
        for (let n = 1; n <= Math.min(36, Math.floor(ageMin / 120)); n++) {
          steps.push({ k: "sla-r" + n, msg: (m) => `📞 ${l.name} is still uncalled after ${Math.round(m / 60)}h.${ph} ${link}` });
        }
        const dueUnsent = steps.filter((s) => !done(l, s.k));
        if (!dueUnsent.length) continue;
        const top = dueUnsent[dueUnsent.length - 1];
        for (const s of dueUnsent) { await claim(l.id, s.k, s === top ? "sent" : "skipped"); }
        const m = Math.round(ageMin);
        await textStaff(loId, top.msg(m), l.id, "nag");
        out.sla++;
        if (top.joe && loId !== "owner") {
          await textStaff("owner", `🔴 ${lo.name} hasn't called ${l.name} (${l.loan_type || "ad lead"}) in ${m} min. ${link}`, l.id, "escalation");
          out.escalations++;
        }
      }
    }

    // ---------------- 2. Borrower nurture ----------------
    if (borrowerWindow) {
      for (const l of active) {
        if (l.created_at_ts < LAUNCH_DATE || l.automation_paused || !hasConsent(l)) continue;
        if (NURTURE_STAGES.indexOf(l.stage) === -1) continue;
        if (hasReplied(l, 7)) continue; // live conversation: the AI replier owns it
        const lo = users[(l.assigned_to as string) || "owner"];
        if (!lo) continue;
        const ageMin = (Date.now() - new Date(l.created_at_ts).getTime()) / 60000;
        const dueTouches = TOUCHES.filter((tc) => tc.after <= ageMin && !done(l, tc.k));
        if (!dueTouches.length) continue;
        const sentTimes = TOUCHES.filter((tc) => done(l, tc.k)).map((tc) => new Date(logged[l.id][tc.k]).getTime());
        if (sentTimes.length && Date.now() - Math.max(...sentTimes) < MIN_GAP_MS) continue;
        const touch = dueTouches[dueTouches.length - 1];
        if (touch.ch === "text" && !l.phone) continue;
        if (touch.ch === "email" && !l.email) continue;
        if (!(await claim(l.id, touch.k, "sent"))) continue;
        for (const skipped of dueTouches.slice(0, -1)) { await claim(l.id, skipped.k, "skipped"); }
        const msg = await generate(touch, l, lo);
        if (!msg) { await sb.from("ad_followup_log").update({ detail: "generation failed" }).eq("lead_id", l.id).eq("step", touch.k); continue; }
        if (touch.ch === "text") {
          await post("send-text", { leadId: l.id, to: l.phone, text: msg.body, fromName: lo.name, initiatedBy: "ai" });
        } else {
          await post("send-email", { leadId: l.id, to: l.email, subject: msg.subject, text: msg.body, fromName: lo.name, fromAddress: lo.email, fromUserId: lo.id, fromPhotoUrl: lo.photo_url || null, initiatedBy: "ai" });
        }
        out.touches++;
      }
    }

    // ---------------- 3. Loan officer accountability (9:00, 13:00, 16:30 ET) ----------------
    const slot = (t.hour === 9 && t.minute < 10) ? "am" : (t.hour === 13 && t.minute < 10) ? "mid" : (t.hour === 16 && t.minute >= 30 && t.minute < 40) ? "pm" : null;
    if (slot) {
      const todayMs = new Date(t.date + "T12:00:00Z").getTime();
      const byLo: Record<string, string[]> = {};
      for (const l of active) {
        const ageMin = (Date.now() - new Date(l.created_at_ts).getTime()) / 60000;
        const loId = (l.assigned_to as string) || "owner";
        let why = "";
        if (!isContacted(l) && ageMin >= 60) why = "not called yet";
        else if (["new", "attempting", "qualifying", "app_sent"].indexOf(l.stage) !== -1) {
          const lastStr = (l.last_contact_at || String(l.created_at_ts).slice(0, 10)) as string;
          const days = Math.floor((todayMs - new Date(lastStr.slice(0, 10) + "T12:00:00Z").getTime()) / 86400000);
          if (days >= 2) why = (l.stage === "app_sent" ? "app sent, " : "") + "no contact in " + days + "d";
        }
        if (why) (byLo[loId] = byLo[loId] || []).push(l.name + " (" + why + ")");
      }
      for (const [loId, items] of Object.entries(byLo)) {
        if (!(await claim("_slot_" + loId, "nag-" + t.date + "-" + slot, String(items.length)))) continue;
        const lo = users[loId]; if (!lo) continue;
        const greeting = slot === "am" ? "Good morning" : slot === "mid" ? "Midday check" : "End of day check";
        const list = items.slice(0, 4).join("; ") + (items.length > 4 ? "; +" + (items.length - 4) + " more" : "");
        await textStaff(loId, `${greeting} ${first(lo.name)} — ${items.length} ad lead${items.length > 1 ? "s" : ""} need action today: ${list}. Open your Today list: ${CRM_URL}`, null, "nag");
        out.nags++;
      }
      if (slot === "pm" && Object.keys(byLo).length) {
        if (await claim("_slot_owner", "behind-" + t.date, "")) {
          const lines = Object.entries(byLo).map(([id, it]) => `${users[id]?.name || id}: ${it.length}`).join(", ");
          await textStaff("owner", `4:30 check — ad leads still needing action: ${lines}. Details are in the 5:00 scoreboard.`, null, "escalation");
        }
      }
    }

    // ---------------- 4. Daily scoreboard to Joe (5:00pm ET) ----------------
    if (t.hour === 17 && t.minute < 10 && (await claim("_slot_owner", "score-" + t.date, ""))) {
      const launched = all.filter((l) => String(l.created_at_ts) >= LAUNCH_DATE);
      const todays = launched.filter((l) => String(l.created_at_ts).slice(0, 10) === t.date);
      const fastCalls = launched.filter((l) => l.first_attempt_at && (new Date(l.first_attempt_at).getTime() - new Date(l.created_at_ts).getTime()) <= 5 * 60000);
      const called = launched.filter((l) => isContacted(l));
      const uncalled = launched.filter((l) => l.status === "active" && !isContacted(l));
      const apps = launched.filter((l) => ["app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"].indexOf(l.stage) !== -1);
      const closed = launched.filter((l) => ["closed", "postclosing"].indexOf(l.stage) !== -1);
      const perLo: Record<string, { n: number; c: number }> = {};
      launched.forEach((l) => { const id = (l.assigned_to as string) || "owner"; const x = (perLo[id] = perLo[id] || { n: 0, c: 0 }); x.n++; if (isContacted(l)) x.c++; });
      const loLine = Object.entries(perLo).map(([id, v]) => `${first(users[id]?.name || id)} ${v.c}/${v.n} called`).join(" · ");
      const summary = `Ad leads today ${todays.length} (total ${launched.length}). Called within 5 min: ${fastCalls.length}/${launched.length}. Still uncalled: ${uncalled.length}. Past application stage: ${apps.length}. Closed: ${closed.length} of ${GOAL_DEALS}-deal goal.`;
      await textStaff("owner", "📊 " + summary + " " + loLine, null, "scoreboard");
      const owner = users["owner"];
      if (owner?.email) {
        const body = "Ad lead scoreboard — " + t.date + "\n\n" + summary + "\n\nBy loan officer (called / assigned): " + loLine +
          (uncalled.length ? "\n\nStill uncalled:\n- " + uncalled.slice(0, 15).map((l) => l.name + " (" + (users[l.assigned_to as string]?.name || l.assigned_to) + ")").join("\n- ") : "") +
          "\n\nOpen the CRM: " + CRM_URL;
        await post("send-email", { to: owner.email, subject: "Ad lead scoreboard — " + t.date, text: body, fromName: "Bridgepoint CRM" });
      }
      out.scoreboard++;
    }

    return new Response(JSON.stringify({ ok: true, checked: active.length, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("ad-lead-followup: error", String(err));
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
