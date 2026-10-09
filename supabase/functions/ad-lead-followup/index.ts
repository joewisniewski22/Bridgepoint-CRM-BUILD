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
// Borrower-facing links (booking, application/portal) use the branded domain -- the
// vercel.app address trips carrier spam filters. Staff links stay on CRM_URL.
const CLIENT_URL = "https://app.bplending.com/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const LAUNCH_DATE = "2026-10-03";
// Spanish Facebook-ad leads arrive through HighLevel tagged source "Facebook". Joe (2026-10-05):
// include them in job 1 (speed-to-lead nagging + Joe escalation) ONLY -- not the English nurture,
// digests or scoreboard. Start date keeps older Spanish leads from all firing at once.
const SPANISH_SLA_START = "2026-10-06";
const GOAL_DEALS = 7;
const NURTURE_STAGES = ["new", "attempting", "qualifying"];
const MIN_GAP_MS = 20 * 3600 * 1000; // between automated borrower touches

type Row = Record<string, any>;

function et(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: parseInt(g("hour"), 10) % 24, minute: parseInt(g("minute"), 10) };
}
// ---------------------------------------------------------------------------
// Fairness rule (Joe, 2026-10-03): leads that arrive at crazy hours never count
// against a loan officer. The accountability clock starts at the lead's
// creation time if that is inside 8:00am-8:00pm Eastern, otherwise at the next
// 8:00am Eastern. (Weekends are NOT excluded -- tell Joe/ask before changing.)
// ---------------------------------------------------------------------------
const CLOCK_OPEN_HOUR = 8;
const CLOCK_CLOSE_HOUR = 20;
function etWallToUtc(dateStr: string, hour: number): number {
  let guess = Date.parse(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  for (let i = 0; i < 2; i++) {
    const e = et(new Date(guess));
    let diff = hour * 60 - (e.hour * 60 + e.minute);
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    guess += diff * 60000;
  }
  return guess;
}
function clockStartMs(createdIso: string): number {
  const created = new Date(createdIso);
  const c = et(created);
  if (c.hour >= CLOCK_OPEN_HOUR && c.hour < CLOCK_CLOSE_HOUR) return created.getTime();
  if (c.hour < CLOCK_OPEN_HOUR) return etWallToUtc(c.date, CLOCK_OPEN_HOUR);
  const next = new Date(Date.parse(c.date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
  return etWallToUtc(next, CLOCK_OPEN_HOUR);
}
const isOffHours = (iso: string) => clockStartMs(iso) !== new Date(iso).getTime();

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
  const bookingLink = CLIENT_URL + "?book=" + l.assigned_to + "&forLead=" + l.id;
  const appLink = CLIENT_URL + "?apply=" + l.id + "&t=" + (l.application_token || "");
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
  // Once the full follow-up engine is live (followup_config.mode = 'live') IT owns the speed-to-lead
  // nagging, the borrower nurture and the loan-officer digests for every lead; this function keeps only
  // the accountability reports, so nobody is texted twice for the same thing.
  const { data: fuCfg } = await sb.from("followup_config").select("mode").eq("id", 1).single();
  const engineLive = !!(fuCfg && fuCfg.mode === "live");
  const staffWindow = !engineLive && t.hour >= 8 && t.hour < 21;
  const borrowerWindow = !engineLive && t.hour >= 9 && t.hour < 19;
  const out: Record<string, number> = { sla: 0, touches: 0, nags: 0, escalations: 0, scoreboard: 0 };

  try {
    await loadUsers();
    const since = new Date(Date.now() - 45 * 86400000).toISOString();
    const { data: leadsData, error } = await sb.from("leads")
      .select("id,name,phone,email,loan_type,assigned_to,stage,status,source,created_at_ts,first_attempt_at,call_attempts,last_contact_at,activity,automation_paused,application_token")
      // "Website — …" = bplending.com forms (Deal Analyzer, quote, apply), which the Deal Analyzer
      // ads drive to. Same intake, same recorded consent, so they get the same follow-up (Joe, 2026-10-05).
      .or("source.like.Meta Ads*,source.like.Website*").gte("created_at_ts", since);
    if (error) throw new Error(error.message);
    const all: Row[] = leadsData || [];
    const active = all.filter((l) => l.status === "active");
    const { data: spanishData, error: spErr } = await sb.from("leads")
      .select("id,name,phone,loan_type,assigned_to,stage,status,source,created_at_ts,first_attempt_at,call_attempts")
      .eq("source", "Facebook").eq("status", "active").gte("created_at_ts", SPANISH_SLA_START);
    if (spErr) throw new Error(spErr.message);
    const spanish: Row[] = spanishData || [];
    const nagPool = active.concat(spanish);

    const ids = all.concat(spanish).map((l) => l.id as string);
    const logged: Record<string, Record<string, string>> = {};
    if (ids.length) {
      const { data: logRows } = await sb.from("ad_followup_log").select("lead_id,step,sent_at").in("lead_id", ids);
      (logRows || []).forEach((r: Row) => { (logged[r.lead_id] = logged[r.lead_id] || {})[r.step] = r.sent_at; });
    }
    const done = (l: Row, step: string) => !!(logged[l.id] && logged[l.id][step]);

    // ---------------- 1. Speed-to-lead nagging ----------------
    if (staffWindow) {
      for (const l of nagPool) {
        if (isContacted(l)) continue;
        const loId = (l.assigned_to as string) || "owner";
        const lo = users[loId];
        if (!lo) continue;
        // Business-hours clock: a 2am lead starts counting at 8am.
        const ageMin = (Date.now() - clockStartMs(l.created_at_ts)) / 60000;
        if (ageMin < 5 || ageMin > 72 * 60) continue;
        const steps: Array<{ k: string; joe?: boolean; msg: (m: number) => string }> = [];
        const link = CRM_URL + "?lead=" + l.id;
        const ph = l.phone ? " " + l.phone : "";
        if (ageMin >= 5) steps.push({ k: "sla05", msg: (m) => `⏰ New ${l.loan_type || ""} ad lead ${l.name} is ${m} min old and nobody has called. Speed wins these — call now${ph}: ${link}` });
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
    const slot = engineLive ? null : (t.hour === 9 && t.minute < 10) ? "am" : (t.hour === 13 && t.minute < 10) ? "mid" : (t.hour === 16 && t.minute >= 30 && t.minute < 40) ? "pm" : null;
    if (slot) {
      const todayMs = new Date(t.date + "T12:00:00Z").getTime();
      const byLo: Record<string, string[]> = {};
      for (const l of active) {
        const ageMin = (Date.now() - clockStartMs(l.created_at_ts)) / 60000;
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

    // ---------------- 4. Accountability reports (Joe: "if they're not doing what they're supposed to do I want to know") ----------------
    // Standards (change here): first call within 15 business minutes on >=80% of
    // counted leads, nobody uncalled past 30 business minutes, no 2+ day silent
    // files, and fewer than 2 missed-30-minute alerts a week. Off-hours leads
    // (clock starts next 8:00am ET) are listed but never counted against anyone.
    const STAGES_PAST_APP = ["app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
    const lead7 = Date.now() - 7 * 86400000;
    const todayMs2 = new Date(t.date + "T12:00:00Z").getTime();
    function report(subset: Row[]) {
      const rows: Record<string, any> = {};
      for (const l of subset) {
        const id = (l.assigned_to as string) || "owner";
        const r = (rows[id] = rows[id] || { n: 0, counted: 0, off: 0, mins: [] as number[], within5: 0, within15: 0, late: [] as string[], stale: [] as string[], viol: 0, apps: 0, closed: 0, never: 0 });
        r.n++;
        const off = isOffHours(l.created_at_ts);
        if (off) r.off++;
        const start = clockStartMs(l.created_at_ts);
        const callMs = l.first_attempt_at ? new Date(l.first_attempt_at).getTime() : null;
        if (start <= Date.now()) {
          r.counted++;
          if (callMs != null) {
            const m = Math.max(0, (callMs - start) / 60000);
            r.mins.push(m);
            if (m <= 5) r.within5++;
            if (m <= 15) r.within15++;
          } else if (!isContacted(l) && l.status === "active") {
            const age = (Date.now() - start) / 60000;
            if (age >= 30) r.late.push(l.name + " (" + Math.round(age) + " min)");
            if (age >= 15) { /* counts against the 15-minute rate by simply not being in within15 */ }
          }
        }
        if (logged[l.id] && logged[l.id]["sla30"] && new Date(logged[l.id]["sla30"]).getTime() > lead7) r.viol++;
        if (STAGES_PAST_APP.indexOf(l.stage) !== -1) r.apps++;
        if (["closed", "postclosing"].indexOf(l.stage) !== -1) r.closed++;
        if (l.status === "active" && ["new", "attempting", "qualifying", "app_sent"].indexOf(l.stage) !== -1) {
          const lastStr = (l.last_contact_at || String(l.created_at_ts).slice(0, 10)) as string;
          const days = Math.floor((todayMs2 - new Date(lastStr.slice(0, 10) + "T12:00:00Z").getTime()) / 86400000);
          if (days >= 2 && isContacted(l)) r.stale.push(l.name + " (" + days + "d)");
        }
      }
      return rows;
    }
    function flagsFor(r: any): string[] {
      const f: string[] = [];
      const measured = r.mins.length + r.late.length;
      if (measured >= 3 && r.within15 / measured < 0.8) f.push("only " + Math.round(100 * r.within15 / measured) + "% called within 15 min (standard 80%)");
      if (r.late.length) f.push(r.late.length + " lead(s) uncalled 30+ min: " + r.late.slice(0, 3).join(", "));
      if (r.stale.length >= 3) f.push(r.stale.length + " files silent 2+ days");
      if (r.viol >= 2) f.push(r.viol + " missed-30-minute alerts this week");
      return f;
    }
    function lineFor(id: string, r: any) {
      const avg = r.mins.length ? Math.round(r.mins.reduce((a: number, b: number) => a + b, 0) / r.mins.length) : null;
      return `${users[id]?.name || id}: ${r.counted} leads counted${r.off ? " (+" + r.off + " overnight, not counted)" : ""} · avg first call ${avg == null ? "n/a" : avg + " min"} · ≤5 min ${r.within5}, ≤15 min ${r.within15} · uncalled 30+ min ${r.late.length} · silent 2d+ ${r.stale.length} · apps ${r.apps} · closed ${r.closed}`;
    }
    async function sendReport(kind: "daily" | "weekly", subset: Row[], title: string) {
      const rows = report(subset);
      const ids = Object.keys(rows);
      // Follow-up tasks (the follow-up engine): who has what due / overdue / done, for every lead, not just ad leads.
      const { data: fuT } = await sb.from("followup_tasks").select("assigned_to,status,due_at,completed_at").limit(20000);
      const fu: Record<string, any> = {};
      (fuT || []).forEach((x: Row) => {
        const o = (fu[x.assigned_to] = fu[x.assigned_to] || { dueNow: 0, over24: 0, done7: 0, skipped7: 0 });
        const dueMs = new Date(x.due_at).getTime();
        if (x.status === "open") { if (dueMs <= Date.now()) o.dueNow++; if (Date.now() - dueMs > 24 * 3600000) o.over24++; }
        else if (x.completed_at && new Date(x.completed_at).getTime() > lead7) { if (x.status === "done") o.done7++; if (x.status === "skipped") o.skipped7++; }
      });
      if (!ids.length && !Object.keys(fu).length) return;
      const flagged: string[] = [];
      const everyone = Array.from(new Set(ids.concat(Object.keys(fu))));
      everyone.forEach((id) => {
        const f = rows[id] ? flagsFor(rows[id]) : [];
        if (fu[id] && fu[id].over24) f.push(fu[id].over24 + " follow-up(s) overdue 24h+");
        if (fu[id] && fu[id].skipped7 >= 3) f.push(fu[id].skipped7 + " follow-ups marked not needed this week");
        if (f.length) flagged.push(`${users[id]?.name || id}: ${f.join("; ")}`);
      });
      const fuLines = Object.keys(fu).map((id) => `- ${users[id]?.name || id}: ${fu[id].dueNow} due now · ${fu[id].over24} overdue 24h+ · ${fu[id].done7} completed this week · ${fu[id].skipped7} skipped`);
      const closed = subset.filter((l) => ["closed", "postclosing"].indexOf(l.stage) !== -1).length;
      const apps = subset.filter((l) => STAGES_PAST_APP.indexOf(l.stage) !== -1).length;
      const head = `${title}: ${subset.length} ad leads, ${apps} past application stage, ${closed} closed (goal ${GOAL_DEALS}).`;
      const body = head + "\n\nBY LOAN OFFICER (ad leads)\n" + (ids.map((id) => "- " + lineFor(id, rows[id])).join("\n") || "- no ad leads in this period") +
        (fuLines.length ? "\n\nFOLLOW-UP TASKS (all leads)\n" + fuLines.join("\n") : "") +
        "\n\n" + (flagged.length ? "NEEDS A CONVERSATION\n- " + flagged.join("\n- ") : "Everyone is meeting the standards.") +
        "\n\nStandards: first call within 15 business minutes on 80%+ of leads; nobody uncalled past 30 minutes; no file silent 2+ days; fewer than 2 missed-30-minute alerts a week. Leads that arrive 8pm-8am Eastern start counting at 8am.\n" + CRM_URL;
      await textStaff("owner", (flagged.length ? "⚠️ " : "📊 ") + head + (flagged.length ? " NEEDS A CONVERSATION: " + flagged.join(" | ") : " Everyone meeting standards."), null, "scoreboard");
      const owner = users["owner"];
      if (owner?.email) await post("send-email", { to: owner.email, subject: (flagged.length ? "⚠️ " : "") + title + " — " + t.date, text: body, fromName: "Bridgepoint CRM" });
      if (kind === "daily") {
        for (const id of ids.filter((x) => x !== "owner")) {
          if (id === "owner") continue;
          const r = rows[id]; const f = flagsFor(r);
          const avg = r.mins.length ? Math.round(r.mins.reduce((a: number, b: number) => a + b, 0) / r.mins.length) : null;
          await textStaff(id, `Your ad-lead scorecard: ${r.counted} leads, avg first call ${avg == null ? "n/a" : avg + " min"}, ${r.late.length} uncalled 30+ min, ${r.stale.length} silent 2d+.` + (f.length ? " Below standard: " + f.join("; ") + ". Joe has this report." : " On standard — nice work."), null, "scoreboard");
        }
      }
      out.scoreboard++;
    }

    const launchedLeads = all.filter((l) => String(l.created_at_ts) >= LAUNCH_DATE);
    // On-demand report to Joe only (no loan officer texts), same secret as cron.
    if (body.force === "report") await sendReport("weekly", launchedLeads, "Ad lead report (on demand)");
    if (t.hour === 17 && t.minute < 10 && (await claim("_slot_owner", "score-" + t.date, ""))) {
      await sendReport("daily", launchedLeads, "Ad lead scorecard (since launch)");
    }
    if (new Date(t.date + "T12:00:00Z").getUTCDay() === 1 && t.hour === 8 && t.minute < 10 && (await claim("_slot_owner", "weekly-" + t.date, ""))) {
      await sendReport("weekly", launchedLeads.filter((l) => new Date(l.created_at_ts).getTime() > lead7), "Weekly ad lead report (last 7 days)");
    }
    return new Response(JSON.stringify({ ok: true, checked: active.length, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("ad-lead-followup: error", String(err));
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
