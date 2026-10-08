// @ts-nocheck
// FOLLOW-UP ENGINE -- Bridgepoint investor lending (business-purpose loans only).
//
// Joe (2026-10-03): "AI follow-ups with texts and emails AND live follow-ups by the
// LOs for literally EVERYTHING ... when it's time to do the follow-up, send a text
// with a link and directions ... the most robust and effective follow-up system ever
// built in this CRM ... maximize the potential of every single lead."
//
// Runs every 5 minutes (pg_cron, shared-secret auth). For every active lead it works
// out the ONE next best action and when it is due, creates a follow-up task for the
// assigned loan officer, writes them an AI call brief, texts them at the right time with
// a link that opens the brief + one-tap call log, nags until it is done, escalates to
// Joe, and layers AI-written borrower texts/emails on top of the human follow-ups.
//
// WHY THESE TIMINGS (researched 2026-10-03; sources in the project memory note):
//  - Speed: contact inside 5 minutes is ~21x likelier to qualify than waiting 30 minutes
//    (MIT/InsideSales Lead Response Management study); the first call is the whole game.
//  - Persistence: ~80% of sales need 5+ follow-ups, most people quit after 1-2. New inbound
//    leads get 6-9 touches in the first ~14 days, front-loaded in the first 72 hours;
//    a 14-day / 8-call-attempt window, then slower nurture. 93% of eventual connects
//    happen by the 6th attempt.
//  - Channel mix: phone first, then SMS (texting BEFORE the first call lowers contact odds);
//    a text after a conversation converts far better than email; alternating call + email
//    + text lifts conversion more than any single channel.
//  - Time of day: vary attempts between late morning (10-11:30) and late afternoon
//    (4-5:30), avoid the lunch hour; speed matters more than the exact hour.
//  - Quotes/term sheets: follow up within 24h, then ~day 3, 7, 11 and a final close-out at
//    ~day 15-22, each touch adding something new. Stalled documents: reminder at ~72h and a
//    personal call by day 5. Abandoned applications: the first 24-48h matter most.
//  - Psychology levers used per step: speed/urgency, reciprocity (give value first),
//    commitment & consistency (get a small yes), Zeigarnik open loops, implementation
//    intentions (always book the NEXT specific step), loss aversion and real scarcity
//    (term-sheet expiry), effort minimisation ("I'll take it by phone").
//
// MODES (table followup_config.mode):  off | shadow (tasks + briefs only, nobody is texted)
//   | pilot (texts/AI only for followup_config.pilot_users) | live (everyone).
// SAFETY: older leads are not dumped on day one -- they are dripped in a few per loan officer
// per day ("backlog drip"); AI texts only go to people with recorded consent / an enrolled AI
// conversation; STOP is honoured; nothing is texted before 8:30am or after 8pm Eastern.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
// Borrower-facing links (booking, application/portal) use the branded domain -- the
// vercel.app address trips carrier spam filters. Staff links stay on CRM_URL.
const CLIENT_URL = "https://app.bplending.com/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const BRIEF_MODEL = "claude-sonnet-5-5";
const TOUCH_MODEL = "claude-haiku-4-5-20251001";
const LAUNCH_DATE = "2026-10-03";
const STALE_AFTER_MS = 2 * 86400000;
const MAX_BRIEFS_PER_RUN = 6;
const MAX_AI_TOUCHES_PER_RUN = 6;
const STAGE_ORDER = ["new", "attempting", "qualifying", "app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
const si = (s) => STAGE_ORDER.indexOf(s);

// ---------------------------------------------------------------------------
// Time helpers (everything business-related is Eastern; staff are NY/FL)
// ---------------------------------------------------------------------------
function etParts(d) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d || new Date());
  const g = (t) => p.find((x) => x.type === t)?.value || "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: parseInt(g("hour"), 10) % 24, minute: parseInt(g("minute"), 10) };
}
function etMs(dateStr, hour, minute) {
  let guess = Date.parse(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}:00Z`);
  for (let i = 0; i < 2; i++) {
    const e = etParts(new Date(guess));
    let diff = (hour * 60 + (minute || 0)) - (e.hour * 60 + e.minute);
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    guess += diff * 60000;
  }
  return guess;
}
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const dow = (dateStr) => new Date(dateStr + "T12:00:00Z").getUTCDay(); // 0 Sun .. 6 Sat
function nextBiz(dateStr) { let d = dateStr; while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1); return d; }
function dateOf(v) { return v ? String(v).slice(0, 10) : null; }
function dateNoonMs(dateStr) { return etMs(dateStr, 12, 0); }
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const first = (n) => String(n || "").trim().split(/\s+/)[0] || "there";
const daysAgo = (ms) => Math.max(0, Math.round((Date.now() - ms) / 86400000));

// Fairness clock (Joe: overnight leads never count against a loan officer): when does the work clock start?
function workStartMs(ms) {
  const e = etParts(new Date(ms));
  if (e.hour >= 8 && e.hour < 20) return ms;
  if (e.hour < 8) return etMs(e.date, 8, 0);
  return etMs(addDays(e.date, 1), 8, 0);
}
// If a timestamp falls outside 8:30am-6:30pm ET, move it to the next business morning (10:00).
function intoWindow(ms) {
  const e = etParts(new Date(ms));
  const mins = e.hour * 60 + e.minute;
  if (dow(e.date) === 0 || dow(e.date) === 6) return etMs(nextBiz(e.date), 10, 0);
  if (mins < 8 * 60 + 30) return etMs(e.date, 10, 0);
  if (mins > 18 * 60 + 30) return etMs(nextBiz(addDays(e.date, 1)), 10, 0);
  return ms;
}
// Preferred call times alternate late morning / late afternoon, jittered per lead so
// one loan officer's tasks don't all land on the same minute.
function prefTime(leadId, n, ch) {
  const j = hash(leadId) % 25;
  if (ch !== "call") return n % 2 ? [11, 15 + (j % 10)] : [15, 30 + (j % 15)];
  return n % 2 === 0 ? [10, 15 + j] : [16, j];
}

// ---------------------------------------------------------------------------
// Lead helpers
// ---------------------------------------------------------------------------
const attemptsOf = (l) => l.call_attempts || [];
const callsOf = (l) => attemptsOf(l).filter((a) => a.outcome !== "texted");
const connectedAttempts = (l) => attemptsOf(l).filter((a) => a.outcome === "connected" || a.outcome === "callback");
function attemptMs(a) { return a.at ? new Date(a.at).getTime() : (a.date ? dateNoonMs(a.date) : 0); }
function lastTouchMs(l) { const t = attemptsOf(l).map(attemptMs); return t.length ? Math.max(...t) : 0; }
function lastConnectDate(l) { const c = connectedAttempts(l).map((a) => a.date).filter(Boolean).sort(); return c.length ? c[c.length - 1] : null; }
function activityOf(l) { return l.activity || []; }
function hasConsent(l) { return activityOf(l).some((a) => typeof a.text === "string" && a.text.indexOf("TCPA consent recorded") === 0); }
function inboundText(l, withinDays) {
  const today = Date.parse(etParts().date + "T12:00:00Z");
  return activityOf(l).some((a) => a.type === "text" && typeof a.text === "string" && /^Received \(via/.test(a.text) &&
    (withinDays == null || (today - Date.parse((a.date || "1970-01-01") + "T12:00:00Z")) / 86400000 < withinDays));
}
function outstandingDocs(l) {
  return (l.documents || []).filter((d) => d.status === "requested" && !d.staffOnly && !d.isTermSheetOption && d.requestedAt);
}
function touchedToday(l) {
  const t = etParts().date;
  return activityOf(l).some((a) => a.date === t && (a.type === "email" || (a.type === "text" && /^Texted/.test(a.text || ""))));
}

// ---------------------------------------------------------------------------
// THE PLAYBOOK. off = {h: hours after anchor} or {d: days after anchor}.
// ---------------------------------------------------------------------------
const SIT = {
  attempting: {
    pri: 60, label: "New lead — reach them",
    steps: [
      { off: { h: 0 }, ch: "call", title: "Call now — new lead", goal: "Make live contact within minutes and book the next step (usually: a quick qualifying call or the application).", lever: "Speed to lead (5-minute rule). Open with their own words from the form. If voicemail: short message with ONE reason to call back, then text.", urgent: true, pri: 100 },
      { off: { h: 3 }, ch: "call", title: "Second attempt — try a different time", goal: "Reach them at a different time than the first try; voicemail + a short text if no answer.", lever: "Phone first, SMS after. Persistence — most conversions come after several tries." },
      { off: { d: 1 }, ch: "call", title: "Day 2 call + text", goal: "Reach them; if not, leave a voicemail that offers a quick ballpark number.", lever: "Reciprocity — offer something useful (a quick number) instead of just 'checking in'." },
      { off: { d: 2 }, ch: "call", title: "Day 3 call", goal: "Reach them; mention you have already looked at their deal.", lever: "Effort already invested; commitment/consistency — they asked for this." },
      { off: { d: 4 }, ch: "call", title: "Day 5 call — easy yes/no", goal: "Get ANY reply: are they still looking to move on a deal?", lever: "Low-friction question; people answer easy yes/no questions." },
      { off: { d: 6 }, ch: "call", title: "Day 7 call — offer a time", goal: "Offer a specific 10-minute slot.", lever: "Implementation intention — a specific day/time beats 'let me know'." },
      { off: { d: 9 }, ch: "call", title: "Day 10 call — what changed?", goal: "Find out whether their timeline or deal changed.", lever: "Curiosity + loss aversion: good deals do not wait on financing." },
      { off: { d: 13 }, ch: "call", title: "Final attempt — permission-based close-out", goal: "Last live attempt; tell them you will close their file unless they want to proceed.", lever: "Scarcity/closure: the polite break-up often gets the reply nothing else did." },
    ],
    ai: [
      { k: "a01", off: { h: 2 }, ch: "text", stop: true, angle: "A friendly quick check-in. You saw their form, can run numbers on their deal, ask what time is best to talk." },
      { k: "a02", off: { d: 1 }, ch: "text", angle: "Ask ONE easy discovery question about their deal: is there a property under contract or identified, and what is their timeline." },
      { k: "a03", off: { d: 2 }, ch: "email", subject: "How we'll get your deal funded", angle: "A short helpful email: 3 plain steps (tell us the deal, we send real numbers, we handle the file to closing). Invite them to reply with the property address." },
      { k: "a04", off: { d: 3 }, ch: "text", stop: true, angle: "A very easy yes/no question: are they still looking to move on a deal? Keep it light." },
      { k: "a05", off: { d: 5 }, ch: "text", angle: "Offer to put together a ballpark loan number if they text the property address." },
      { k: "a06", off: { d: 7 }, ch: "email", subject: "Why speed wins deals", angle: "A brief email on why investors who line up financing early win more deals and negotiate better. No statistics, no promises. Invite a quick call." },
      { k: "a07", off: { d: 10 }, ch: "text", stop: true, angle: "Check whether their timeline has changed or whether a different kind of loan would fit better." },
      { k: "a08", off: { d: 14 }, ch: "text", app: true, angle: "Offer the application link: it takes a few minutes to start and gets them a firm quote faster." },
      { k: "a09", off: { d: 21 }, ch: "email", subject: "Still planning a deal?", app: true, angle: "A short, warm last-chance email with the application link and your direct availability. No pressure." },
      { k: "a10", off: { d: 30 }, ch: "text", stop: true, app: true, angle: "A polite break-up message: you will close their file unless they want to move ahead; they can text back any time." },
    ],
  },
  connected: {
    pri: 62, label: "Spoke with them — keep it moving",
    steps: [
      { off: { d: 1 }, ch: "call", title: "Follow up on your last conversation", goal: "Re-open the loop on what you discussed and confirm the exact next step.", lever: "Zeigarnik open loop + commitment/consistency: tie back to what THEY said they wanted." },
      { off: { d: 3 }, ch: "call", title: "Day 3 check-in — add value", goal: "Share one useful thing (a ballpark, a lender tip) and ask where the property/deal stands.", lever: "Reciprocity: give before you ask." },
      { off: { d: 7 }, ch: "call", title: "Week-1 call — lock a start date", goal: "Get a specific day they will start the application or send the contract/address.", lever: "Implementation intention: 'what day works to get this started?'" },
      { off: { d: 14 }, ch: "call", title: "Two-week check-in", goal: "Find out whether anything changed and whether another lender is in the picture.", lever: "Competition awareness without pressure; offer to beat the clock." },
      { off: { d: 21 }, ch: "call", title: "Day 21 call", goal: "Re-engage or learn why they went quiet.", lever: "Honest curiosity." },
      { off: { d: 30 }, ch: "call", title: "30-day close-out call", goal: "Decide: move forward, schedule a future date, or close the file.", lever: "Closure." },
    ],
    ai: [
      { k: "c01", off: { d: 2 }, ch: "email", subject: "What to expect from here", angle: "A short email recapping what happens next (application, term sheet, closing) so they feel the path is easy. Mention you enjoyed speaking." },
      { k: "c02", off: { d: 5 }, ch: "text", angle: "Offer to run a ballpark number if they send the property address, referencing your recent conversation." },
      { k: "c03", off: { d: 9 }, ch: "email", subject: "Quick question about your deal", angle: "Ask which part of the deal they want more clarity on and offer a quick call." },
      { k: "c04", off: { d: 14 }, ch: "text", stop: true, angle: "A light check-in: still planning to move forward? Offer the application link if so.", app: true },
      { k: "c05", off: { d: 21 }, ch: "email", subject: "Following up", angle: "A warm check-in that leaves the door open and offers help with whatever stage their deal is at." },
    ],
  },
  app_sent: {
    pri: 75, label: "Application sent — get it finished",
    steps: [
      { off: { d: 1 }, ch: "call", title: "Application sent — offer to take it by phone", goal: "Offer to complete the application together over the phone (about 10 minutes). Biggest completion lever.", lever: "Effort minimisation + commitment: a small first step ('let's just start') beats waiting." },
      { off: { d: 3 }, ch: "call", title: "Day 3 — help them finish the application", goal: "Find the blocker (missing info, questions, cold feet) and remove it.", lever: "Zeigarnik: an unfinished task nags — help them close it." },
      { off: { d: 5 }, ch: "text", title: "Day 5 — send a text from the CRM", goal: "A short personal text offering help; include the link again.", lever: "Easy next step." },
      { off: { d: 8 }, ch: "call", title: "Day 8 call", goal: "Reconnect; confirm the deal is still alive.", lever: "Loss aversion: delays can cost them the property." },
      { off: { d: 12 }, ch: "call", title: "Day 12 call", goal: "Last real push to complete, or learn the real reason.", lever: "Honest candor." },
      { off: { d: 16 }, ch: "call", title: "Final application call", goal: "Decide: complete, reschedule, or close out.", lever: "Closure." },
    ],
    ai: [
      { k: "p01", off: { h: 2 }, ch: "text", app: true, angle: "Confirm you sent the application; it takes about 10 minutes, they can save and finish later, and you are available if they get stuck." },
      { k: "p02", off: { d: 1 }, ch: "text", app: true, stop: true, angle: "Gentle nudge: most of the application is quick; offer to walk through it together by phone." },
      { k: "p03", off: { d: 3 }, ch: "email", subject: "Your application is waiting", app: true, angle: "Email explaining what happens right after they finish the application (we review, send terms) so finishing feels worthwhile. Link included." },
      { k: "p04", off: { d: 6 }, ch: "text", app: true, angle: "Ask if anything on the application is unclear, and offer to fill it out with them by phone." },
      { k: "p05", off: { d: 10 }, ch: "email", subject: "Still want to move forward?", app: true, angle: "A short email checking whether the deal is still on and offering help or a new timeline." },
      { k: "p06", off: { d: 14 }, ch: "text", app: true, stop: true, angle: "Final friendly nudge; they can text back any time." },
    ],
  },
  app_done_no_terms: {
    pri: 85, label: "Application is in — get terms out",
    steps: [
      { off: { h: 4 }, ch: "call", title: "Application is in — get terms to them today", goal: "Review the file, price it, and call with real terms the same day.", lever: "Speed + momentum: the first lender with real numbers usually wins.", urgent: true, pri: 90 },
      { off: { d: 1 }, ch: "call", title: "Terms still not out — call", goal: "Get the term sheet out and confirm they received it.", lever: "Momentum." },
      { off: { d: 2 }, ch: "call", title: "Call — keep momentum", goal: "Move the file to terms or tell the borrower exactly what is missing.", lever: "Clear next step." },
      { off: { d: 4 }, ch: "call", title: "Escalate — file stuck before terms", goal: "Unstick it or reset expectations honestly.", lever: "Transparency builds trust." },
    ],
    ai: [],
  },
  quote: {
    pri: 80, label: "Terms sent — get a decision",
    steps: [
      { off: { d: 1 }, ch: "call", title: "Terms sent — did they get them?", goal: "Confirm receipt, walk through the key terms, and ask what questions they have.", lever: "Most winning quotes close within a day of first review — be there while it is fresh." },
      { off: { d: 3 }, ch: "call", title: "Day 3 — add value and ask about timeline", goal: "Compare total cost (not just rate) and ask when they plan to close on the property.", lever: "Reciprocity + anchoring on total cost and speed to close." },
      { off: { d: 7 }, ch: "call", title: "Day 7 — decision timeline", goal: "Ask directly what is needed to decide and by when; handle objections.", lever: "Implementation intention: get a decision DATE." },
      { off: { d: 11 }, ch: "call", title: "Terms expiring soon", goal: "Remind them the term sheet is good through its expiry date and ask to move forward.", lever: "Real scarcity: the expiry date is real." },
      { off: { d: 15 }, ch: "call", title: "Terms expired — re-issue?", goal: "Offer to refresh the terms if the deal is still alive, or learn why not.", lever: "Closure + second chance." },
      { off: { d: 22 }, ch: "call", title: "Final close-out call", goal: "Decide: refresh and proceed, or close the file.", lever: "Closure." },
    ],
    ai: [
      { k: "q01", off: { d: 1 }, ch: "text", angle: "Check they received the term sheet and invite any questions about the terms." },
      { k: "q02", off: { d: 3 }, ch: "email", subject: "Comparing your options", angle: "A helpful email on comparing offers by total cost (rate, points, fees, speed to close), not just the rate. Offer to walk through it." },
      { k: "q03", off: { d: 6 }, ch: "text", angle: "Ask what their timeline is on the property and whether anything is holding up a decision." },
      { k: "q04", off: { d: 10 }, ch: "email", subject: "Your terms are good through soon", angle: "Remind them their term sheet is valid through its expiry date and offer a quick call to answer questions." },
      { k: "q05", off: { d: 15 }, ch: "text", stop: true, angle: "The terms have expired; offer to refresh them if the deal is still alive." },
    ],
  },
  docs: {
    pri: 70, label: "Documents outstanding — keep the file moving",
    steps: [
      { off: { d: 3 }, ch: "text", title: "Docs requested 3 days ago — send a personal text", goal: "A quick personal text listing exactly what is still needed and offering help.", lever: "Specific and easy: name the documents." },
      { off: { d: 5 }, ch: "call", title: "Docs outstanding 5 days — call", goal: "Call, find the blocker, and set a specific upload date.", lever: "Implementation intention: 'what day will you upload these?'" },
      { off: { d: 7 }, ch: "call", title: "Docs outstanding 7 days", goal: "Re-confirm commitment; offer another way to send (photo, email).", lever: "Reduce friction." },
      { off: { d: 9 }, ch: "text", title: "Docs — personal text", goal: "Short reminder with the exact list.", lever: "Make it easy." },
      { off: { d: 11 }, ch: "call", title: "Docs outstanding 11 days — call", goal: "Decide whether the deal is still alive and what is truly holding it up.", lever: "Honest candor." },
      { off: { d: 14 }, ch: "call", title: "Docs outstanding 2 weeks — escalate", goal: "Get the file moving or reset the timeline with the borrower.", lever: "Transparency." },
    ],
    ai: [
      { k: "d01", off: { d: 2 }, ch: "text", app: true, angle: "Friendly reminder listing the specific documents still needed and that they can upload in their portal link." },
      { k: "d02", off: { d: 3 }, ch: "email", subject: "Documents we still need", app: true, angle: "Email listing exactly what is needed, how to upload (portal link), and that having them in lets you keep the closing date on track." },
      { k: "d03", off: { d: 5 }, ch: "text", app: true, angle: "A short text offering to take photos by text or email if easier." },
      { k: "d04", off: { d: 8 }, ch: "text", app: true, stop: true, angle: "A gentle reminder that the file is waiting on these items." },
      { k: "d05", off: { d: 11 }, ch: "email", subject: "Is the deal still on?", app: true, angle: "Ask if the deal is still moving and whether the timeline changed." },
    ],
  },
  in_process: {
    pri: 45, label: "In process — keep the borrower informed",
    steps: [{ off: { d: 4 }, ch: "call", title: "Status touch — and ask about their next deal", goal: "Give a real status update and ask what they have coming up next.", lever: "No news feels like bad news; proactive updates build trust and repeat business." }],
    ai: [],
  },
  preapproved: {
    pri: 40, label: "Pre-approved — help them find the deal",
    steps: [
      { off: { d: 5 }, ch: "call", title: "Pre-approved — any properties yet?", goal: "Ask where their property search stands and offer to run numbers on any address.", lever: "Be useful during the search." },
      { off: { d: 12 }, ch: "call", title: "Search check-in", goal: "Offer help evaluating a deal; ask about timeline.", lever: "Reciprocity." },
      { off: { d: 19 }, ch: "call", title: "Search check-in 3", goal: "Keep top of mind; confirm the pre-approval is still useful.", lever: "Stay present." },
      { off: { d: 26 }, ch: "call", title: "Pre-approval follow-up", goal: "Re-qualify and refresh if needed.", lever: "Closure/refresh." },
    ],
    ai: [
      { k: "r01", off: { d: 7 }, ch: "text", angle: "Ask if they have found a property and offer to run numbers on any address quickly." },
      { k: "r02", off: { d: 14 }, ch: "email", subject: "Found a deal yet?", angle: "A short email offering a fast turnaround when they have a property under contract." },
      { k: "r03", off: { d: 21 }, ch: "text", angle: "A light check-in offering help." },
    ],
  },
  closed: {
    pri: 30, label: "Closed — referrals and the next deal",
    steps: [
      { off: { d: 2 }, ch: "call", title: "Thank-you call after closing", goal: "Thank them, ask how the process felt, and ask what they have coming up next.", lever: "Reciprocity + peak-end rule: end the experience on a high." },
      { off: { d: 30 }, ch: "call", title: "30-day call — referral ask", goal: "Ask for an introduction to another investor and for their next deal.", lever: "Social proof & reciprocity: happy clients refer." },
      { off: { d: 90 }, ch: "call", title: "90-day check-in — next deal?", goal: "Ask what is next and whether anything is coming due.", lever: "Stay top of mind." },
    ],
    ai: [
      { k: "z01", off: { d: 1 }, ch: "text", angle: "Thank them sincerely for closing with you and say you are here for the next deal." },
      { k: "z02", off: { d: 30 }, ch: "email", subject: "A quick favor", angle: "A short note thanking them and asking if they know another investor who could use a lender who answers the phone." },
      { k: "z03", off: { d: 90 }, ch: "text", angle: "A light check-in asking what they have coming up next." },
    ],
  },
};

// ---------------------------------------------------------------------------
// Which situations apply to a lead, and what is the next step in each
// ---------------------------------------------------------------------------
function candidates(l, tasksByLead, now) {
  const out = [];
  const stage = l.stage || "new";
  const calls = callsOf(l);
  const created = l.created_at_ts ? new Date(l.created_at_ts).getTime() : (l.created_at ? dateNoonMs(l.created_at) : now);
  const createdDate = etParts(new Date(created)).date;
  const done = (sit, anchor) => (tasksByLead[l.id] || []).filter((t) => t.situation === sit && t.meta && t.meta.anchor === anchor && (t.status === "done" || t.status === "skipped")).length;

  if (l.status === "closed" || stage === "closed" || stage === "postclosing") {
    if (l.status === "closed" || stage === "closed") {
      const anchor = dateOf(l.close_date) || dateOf(l.last_contact_at) || createdDate;
      out.push({ sit: "closed", anchor, idx: done("closed", anchor), anchorMs: dateNoonMs(anchor) });
    }
    return out;
  }
  if (l.status !== "active") return out;

  // A client-requested callback has its own exact time (the existing reminder job texts the LO 10 min before).
  if (l.next_follow_up_at) {
    const at = new Date(l.next_follow_up_at).getTime();
    out.push({ sit: "callback", anchor: String(l.next_follow_up_at), idx: 0, special: { dueAt: at, title: "Scheduled call back", goal: (l.next_follow_up_note || "Return the call you scheduled.").replace(/^Call back requested:?\s*/, ""), lever: "Keep the promise — showing up on time builds trust.", urgent: true, pri: 95, noText: true } });
  }

  const outstanding = outstandingDocs(l);
  if (outstanding.length && si(stage) >= si("app_completed")) {
    const anchor = outstanding.map((d) => d.requestedAt).sort()[0];
    out.push({ sit: "docs", anchor, idx: done("docs", anchor), anchorMs: dateNoonMs(anchor) });
  }
  if (l.termsheet_sent_at && !l.application_taken_at && !l.application_taken_by_phone && si(stage) < si("app_completed")) {
    const anchor = dateOf(l.termsheet_sent_at);
    out.push({ sit: "quote", anchor, idx: done("quote", anchor), anchorMs: dateNoonMs(anchor) });
  }
  if (l.application_sent_at && !l.application_taken_at && !l.application_taken_by_phone && si(stage) <= si("app_sent")) {
    const anchor = dateOf(l.application_sent_at);
    out.push({ sit: "app_sent", anchor, idx: done("app_sent", anchor), anchorMs: dateNoonMs(anchor) });
  }
  if ((l.application_taken_at || l.application_taken_by_phone) && !l.termsheet_sent_at && (stage === "app_completed" || stage === "app_sent")) {
    const anchor = dateOf(l.application_taken_at) || dateOf(l.application_sent_at) || createdDate;
    out.push({ sit: "app_done_no_terms", anchor, idx: done("app_done_no_terms", anchor), anchorMs: dateNoonMs(anchor) });
  }
  if (["processing", "underwriting", "approved", "ctc"].indexOf(stage) !== -1) {
    const anchor = dateOf(l.last_contact_at) || createdDate;
    out.push({ sit: "in_process", anchor, idx: 0, anchorMs: dateNoonMs(anchor), repeat: true });
  }
  if (l.preapproval_sent_at && si(stage) < si("processing") && !l.termsheet_sent_at) {
    const anchor = dateOf(l.preapproval_sent_at);
    out.push({ sit: "preapproved", anchor, idx: done("preapproved", anchor), anchorMs: dateNoonMs(anchor) });
  }
  // A future callback pauses the calling cadence until then (same rule as the CRM's call
  // queue, computeQueueForLeads) -- Joe 10/8: "not called or put on a call list until Monday".
  if (l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() > Date.now()) return out;
  if (stage === "qualifying" || (connectedAttempts(l).length && (stage === "new" || stage === "attempting"))) {
    const anchor = lastConnectDate(l) || dateOf(l.last_contact_at) || createdDate;
    if (!l.application_sent_at && !l.termsheet_sent_at) out.push({ sit: "connected", anchor, idx: done("connected", anchor), anchorMs: dateNoonMs(anchor) });
  }
  if ((stage === "new" || stage === "attempting") && !connectedAttempts(l).length) {
    out.push({ sit: "attempting", anchor: "created", idx: calls.length, anchorMs: created, createdMs: created, createdDate, imported: l.source === "LendingWise Import" });
  }
  return out;
}

function planFor(l, cand, now) {
  if (cand.special) {
    const s = cand.special;
    return { sit: cand.sit, key: `${cand.sit}:${cand.anchor}:0`, idx: 0, ch: "call", title: s.title, goal: s.goal, lever: s.lever, dueAt: s.dueAt, urgent: !!s.urgent, pri: s.pri, noText: !!s.noText, anchor: cand.anchor };
  }
  const def = SIT[cand.sit];
  let step = def.steps[def.repeat ? 0 : cand.idx];
  if (cand.repeat) step = def.steps[0];
  if (!step) return null;
  let at;
  const lt = lastTouchMs(l);
  if (cand.sit === "attempting") {
    if (step.off.h === 0 && cand.idx === 0) at = cand.createdMs;
    else if (step.off.h != null) at = intoWindow(cand.createdMs + step.off.h * 3600000);
    else {
      const [hh, mm] = prefTime(l.id, cand.idx, "call");
      at = etMs(nextBiz(addDays(cand.createdDate, step.off.d)), hh, mm);
    }
    if (lt) at = Math.max(at, lt + (cand.idx === 1 ? 2.5 * 3600000 : 20 * 3600000));
  } else if (cand.repeat) {
    const [hh, mm] = prefTime(l.id, cand.idx, step.ch);
    at = etMs(nextBiz(addDays(cand.anchor, step.off.d)), hh, mm);
    if (lt) at = Math.max(at, lt + 3 * 86400000);
  } else if (step.off.h != null) {
    at = intoWindow(cand.anchorMs + step.off.h * 3600000);
    if (lt) at = Math.max(at, lt + 2 * 3600000);
  } else {
    const [hh, mm] = prefTime(l.id, cand.idx, step.ch);
    at = etMs(nextBiz(addDays(cand.anchor, step.off.d)), hh, mm);
    if (lt) at = Math.max(at, lt + 20 * 3600000);
  }
  let urgent = !!step.urgent && (now - at) < 3 * 86400000;
  let title = step.title;
  // Files moved over from LendingWise are existing relationships, not fresh leads: never "urgent",
  // always dripped in gradually, and worded as a reconnect.
  if (cand.imported) {
    urgent = false;
    at = Math.min(at, now - STALE_AFTER_MS - 1000);
    if (cand.idx === 0) title = "Reconnect — existing file from LendingWise";
  } else if (cand.sit === "attempting" && cand.idx === 0 && now - cand.createdMs > 3 * 86400000) {
    title = "Reach out — inquiry came in " + daysAgo(cand.createdMs) + " days ago";
  }
  return { sit: cand.sit, key: `${cand.sit}:${cand.anchor}:${cand.repeat ? "r" + (lt ? new Date(lt).toISOString().slice(0, 10) : "0") : cand.idx}`, idx: cand.idx, ch: step.ch, title, goal: step.goal, lever: step.lever, dueAt: at, urgent, pri: cand.imported ? 20 : (step.pri || def.pri), anchor: cand.anchor, anchorMs: cand.anchorMs };
}

// Best plan across all situations that apply: earliest due wins, ties by priority.
function bestPlan(l, tasksByLead, now) {
  const plans = candidates(l, tasksByLead, now).map((c) => planFor(l, c, now)).filter(Boolean);
  if (!plans.length) return null;
  plans.sort((a, b) => (a.dueAt - b.dueAt) || (b.pri - a.pri));
  // Prefer a plan that is actually due or imminent over a far-future one, otherwise the soonest.
  return plans[0];
}

// ---------------------------------------------------------------------------
// Messaging plumbing
// ---------------------------------------------------------------------------
const users = {};
let cfg = { mode: "pilot", pilot_users: ["owner"], backlog_per_day: 6, text_cap_per_hour: 3 };
const post = (fn, payload) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload),
}).catch(() => null);
async function claim(leadId, step, detail) {
  const { error } = await sb.from("ad_followup_log").insert({ lead_id: leadId, step, detail: detail || "" });
  return !error;
}
// Who may be TEXTED (live: everyone; pilot: pilot users only; shadow/off: nobody).
function userAllowed(userId) {
  if (cfg.mode === "live") return true;
  if (cfg.mode === "pilot") return (cfg.pilot_users || []).indexOf(userId) !== -1;
  return false;
}
// Who gets TASKS created (visible in the app): live: everyone; otherwise only the pilot users.
function taskAllowed(userId) {
  if (cfg.mode === "live") return true;
  return (cfg.pilot_users || []).indexOf(userId) !== -1;
}
async function textUser(userId, text, leadId, kind) {
  const u = users[userId];
  if (!u) return false;
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: userId, lead_id: leadId || null, kind: kind || "followup", text: text.slice(0, 240), date: etParts().date, read: false });
  // followup_config.staff_texts = false (Joe 2026-10-07: "too frequent"): staff get the
  // in-app task/notification only, no SMS. Borrower-facing AI touches are unaffected.
  if (u.phone && cfg.staff_texts !== false) await post("send-text", { to: u.phone, text, fromName: "Bridgepoint CRM" });
  return true;
}

// ---------------------------------------------------------------------------
// AI: call brief for the loan officer
// ---------------------------------------------------------------------------
function leadFacts(l) {
  const bits = [];
  bits.push(`Name: ${l.name}`);
  if (l.loan_type) bits.push(`Loan type: ${l.loan_type}`);
  if (l.property_address) bits.push(`Property: ${l.property_address}`);
  if (l.property_type) bits.push(`Property type: ${l.property_type}`);
  if (l.transaction_type) bits.push(`Transaction: ${l.transaction_type}`);
  if (l.purchase_price) bits.push(`Purchase price: $${Math.round(l.purchase_price).toLocaleString()}`);
  if (l.current_value) bits.push(`Current value: $${Math.round(l.current_value).toLocaleString()}`);
  if (l.arv) bits.push(`ARV: $${Math.round(l.arv).toLocaleString()}`);
  if (l.rehab_budget) bits.push(`Rehab: $${Math.round(l.rehab_budget).toLocaleString()}`);
  if (l.rent_estimate) bits.push(`Monthly rent: $${Math.round(l.rent_estimate).toLocaleString()}`);
  if (l.loan_amount) bits.push(`Loan amount: $${Math.round(l.loan_amount).toLocaleString()}`);
  if (l.rate) bits.push(`Rate quoted: ${l.rate}%`);
  if (l.credit_score) bits.push(`Credit score: ${l.credit_score}`);
  if (l.experience_deals != null) bits.push(`Deals completed: ${l.experience_deals}`);
  if (l.entity_type) bits.push(`Entity: ${l.entity_type}`);
  if (l.source) bits.push(`Source: ${l.source}`);
  bits.push(`Stage: ${l.stage}`);
  return bits.join("\n");
}
function timelineFacts(l, now) {
  const L = [];
  const created = l.created_at_ts ? new Date(l.created_at_ts).getTime() : 0;
  if (created) L.push(`Lead came in ${daysAgo(created)} day(s) ago`);
  if (l.application_sent_at) L.push(`Application sent ${daysAgo(dateNoonMs(dateOf(l.application_sent_at)))} day(s) ago`);
  if (l.application_taken_at) L.push(`Application completed ${daysAgo(dateNoonMs(dateOf(l.application_taken_at)))} day(s) ago`);
  if (l.termsheet_sent_at) L.push(`Term sheet sent ${daysAgo(dateNoonMs(dateOf(l.termsheet_sent_at)))} day(s) ago (valid ${15} days)`);
  if (l.preapproval_sent_at) L.push(`Pre-approval sent ${daysAgo(dateNoonMs(dateOf(l.preapproval_sent_at)))} day(s) ago`);
  const od = outstandingDocs(l);
  if (od.length) L.push(`Documents still outstanding: ${od.map((d) => d.name + " (asked " + daysAgo(dateNoonMs(dateOf(d.requestedAt))) + "d ago)").join("; ")}`);
  const calls = attemptsOf(l);
  if (calls.length) L.push(`Call/text attempts so far: ${calls.length} (${calls.slice(-4).map((a) => a.outcome + " " + a.date).join(", ")})`);
  return L.join("\n");
}
function recentConversation(l) {
  const items = [];
  attemptsOf(l).filter((a) => a.notes).slice(-3).forEach((a) => items.push(`Call ${a.date} (${a.outcome}): ${String(a.notes).slice(0, 220)}`));
  activityOf(l).filter((a) => a.type === "text" || a.type === "email" || a.type === "note").slice(-6).forEach((a) => items.push(`${a.date} ${a.type}: ${String(a.text || "").slice(0, 200)}`));
  return items.join("\n");
}
function extractJson(s) {
  const m = String(s || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_e) { return null; }
}
async function claude(model, prompt, maxTokens) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens || 700, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await res.json();
    return res.ok ? String(j.content?.[0]?.text || "").trim() : null;
  } catch (_e) { return null; }
}
function fallbackBrief(l, plan) {
  const first_ = first(l.name);
  return {
    why_now: plan.goal,
    recap: timelineFacts(l, Date.now()).split("\n").slice(0, 3).join(". "),
    objective: plan.goal,
    opening: `Hi ${first_}, it's ${"{your name}"} with Bridgepoint Lending — do you have two minutes?`,
    questions: ["Where does the deal stand right now?", "What's your timeline to close?", "Is there anything holding you back from moving forward?"],
    objections: [{ q: "I'm shopping around", a: "Totally fair — what matters most to you: rate, speed, or certainty? I'll show you where we're strongest." }, { q: "Not ready yet", a: "No problem — what would need to happen first? I can check back on a date that suits you." }],
    voicemail: `Hi ${first_}, it's ${"{your name}"} at Bridgepoint Lending about your loan request — I have a couple of quick things on your deal. I'll text you too; call me back when you can.`,
    next_step: "Book a specific day and time for the next step before you hang up.",
    text_after: `Great talking with you, ${first_}. As discussed, [next step]. I'll follow up ${"[day]"}.`,
  };
}
async function makeBrief(l, plan, lo) {
  const lang = l.preferred_language === "es" ? "Spanish" : "English";
  const prompt = `You are a sales coach writing a 20-second call brief for ${lo.name}, a loan officer at Bridgepoint Lending. Bridgepoint makes BUSINESS-PURPOSE real estate investor loans only (DSCR rentals, fix & flip, bridge, ground-up construction, portfolio) — never consumer mortgages, never use consumer-mortgage terms.
Today is ${etParts().date}. The loan officer is about to follow up with an investor. Use ONLY the facts below; never invent rates, numbers, approvals, or promises.

THE FOLLOW-UP
Situation: ${SIT[plan.sit]?.label || plan.sit}
Task: ${plan.title}
Goal: ${plan.goal}
Sales-psychology lever to use: ${plan.lever}

FILE FACTS
${leadFacts(l)}

TIMELINE
${timelineFacts(l, Date.now())}

RECENT CONVERSATION / NOTES
${recentConversation(l) || "(nothing logged yet)"}

Write the brief in ${lang} as strict JSON with these keys (keep each short and conversational, no markdown):
"why_now" (max 140 chars: why this call matters today, referencing a concrete fact like days since application),
"recap" (max 260 chars: what we know and what was discussed last time),
"objective" (max 100 chars),
"opening" (a natural first sentence the loan officer can say, max 200 chars; use their first name and a concrete fact),
"questions" (array of exactly 3 short discovery questions, most important first),
"objections" (array of 2-3 objects {"q":"...","a":"..."} with the most likely objection at this stage and a short honest reply),
"voicemail" (what to say if it goes to voicemail: max 220 chars, friendly, gives ONE concrete reason to call back and says you will text them),
"next_step" (the specific next step to ask for before hanging up — always a concrete date/time or action),
"text_after" (a friendly 1-2 sentence text the loan officer can send right after the call, with [bracketed] blanks only where truly needed).
No emojis anywhere. Return ONLY the JSON.`;
  const raw = (await claude(BRIEF_MODEL, prompt, 900)) || (await claude(TOUCH_MODEL, prompt, 900));
  const j = extractJson(raw);
  if (j && j.why_now) return j;
  return fallbackBrief(l, plan);
}

// AI-written borrower touch
async function makeTouch(touch, l, lo, sit, anchorLabel) {
  const bookingLink = CLIENT_URL + "?book=" + l.assigned_to;
  const appLink = CLIENT_URL + "?apply=" + l.id + "&t=" + (l.application_token || "");
  const lang = l.preferred_language === "es" ? "Spanish" : "English";
  const exp = l.termsheet_sent_at ? addDays(dateOf(l.termsheet_sent_at), 15) : null;
  const prompt = `You are ${lo.name}, a loan officer at Bridgepoint Lending (business-purpose real estate investor loans — not consumer mortgages). Write ONE ${touch.ch === "text" ? "text message (max 2 short sentences, plain, friendly, no emojis)" : "short email (max 90 words, plain text, no markdown, sign off with just your first name)"} in ${lang} to ${first(l.name)}.
Situation: ${SIT[sit].label}. Goal of this message: ${touch.angle}
What we know: ${leadFacts(l).split("\n").slice(0, 8).join("; ")}.
${timelineFacts(l, Date.now()).split("\n").join("; ")}
${exp ? "Their term sheet is valid through " + exp + "." : ""}
${touch.app || sit === "docs" ? "Application / portal link to include: " + appLink : "Booking link you may include if it fits: " + bookingLink}
Never quote a rate, fee, approval or closing time unless it is stated above. Never invent facts or statistics. Do not say you are automated. ${touch.ch === "email" ? "Reply with the email body only (no subject line)." : "Reply with ONLY the message text."}`;
  let body = await claude(TOUCH_MODEL, prompt, 360);
  if (!body) return null;
  if (touch.ch === "text" && touch.stop && body.length < 240) body += lang === "Spanish" ? " Responda STOP para no recibir mensajes." : " Reply STOP to opt out.";
  return { subject: touch.subject || "Following up on your loan request", body };
}

// ---------------------------------------------------------------------------
// Text to the loan officer for a task
// ---------------------------------------------------------------------------
function taskLink(task) { return CRM_URL + "?brief=" + task.id; }
function taskSms(task, l, brief) {
  const icon = task.channel === "call" ? "📞" : task.channel === "text" ? "💬" : "✉️";
  const q = brief && brief.questions && brief.questions[0] ? " Ask: " + brief.questions[0] : "";
  const why = brief && brief.why_now ? " " + brief.why_now : "";
  const phone = l.phone ? " " + l.phone : "";
  const tail = " Brief + log: " + taskLink(task);
  let body = `${icon} ${l.name} — ${task.title}.${why}${q}${phone}`;
  const max = 318 - tail.length;
  if (body.length > max) body = body.slice(0, max - 1).trimEnd() + "…";
  return body + tail;
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return new Response(JSON.stringify({ error: "not_authorized" }), { status: 403, headers: { "Content-Type": "application/json" } });
  const { data: cfgRow } = await sb.from("followup_config").select("*").eq("id", 1).single();
  if (cfgRow) cfg = cfgRow;
  if (cfg.mode === "off" && !body.dry) return new Response(JSON.stringify({ ok: true, mode: "off" }), { headers: { "Content-Type": "application/json" } });

  const now = Date.now();
  const t = etParts();
  const stats = { leads: 0, created: 0, done: 0, superseded: 0, briefs: 0, pings: 0, reminders: 0, digests: 0, escalations: 0, ai: 0, drip: 0 };
  try {
    const { data: userRows } = await sb.from("users").select("id,name,phone,email,photo_url,role");
    (userRows || []).forEach((u) => { users[u.id] = u; });

    const since = new Date(now - 150 * 86400000).toISOString();
    const { data: leadRows, error: lerr } = await sb.from("leads")
      .select("id,name,phone,email,loan_type,assigned_to,stage,status,source,created_at,created_at_ts,first_attempt_at,call_attempts,last_contact_at,next_follow_up_at,next_follow_up_note,activity,documents,automation_paused,ai_stage,application_token,application_sent_at,application_taken_at,application_taken_by_phone,termsheet_sent_at,preapproval_sent_at,close_date,preferred_language,sms_opt_out,nurture_off,property_address,property_type,transaction_type,purchase_price,current_value,arv,rehab_budget,rent_estimate,loan_amount,rate,credit_score,experience_deals,entity_type")
      .in("status", ["active", "closed"]).gte("created_at_ts", since).limit(3000);
    if (lerr) throw new Error(lerr.message);
    const leads = leadRows || [];
    stats.leads = leads.length;
    const byId = {}; leads.forEach((l) => { byId[l.id] = l; });

    const { data: taskRows } = await sb.from("followup_tasks").select("*").limit(20000);
    const tasks = taskRows || [];
    const tasksByLead = {}; tasks.forEach((tk) => { (tasksByLead[tk.lead_id] = tasksByLead[tk.lead_id] || []).push(tk); });

    // ---- A. Reconcile open tasks: detect completion, supersede stale ones ----
    for (const tk of tasks.filter((x) => x.status === "open")) {
      const l = byId[tk.lead_id];
      if (!l || (l.status !== "active" && !(l.status === "closed" && tk.situation === "closed"))) {
        if (!body.dry) await sb.from("followup_tasks").update({ status: "superseded", completed_at: new Date().toISOString() }).eq("id", tk.id);
        tk.status = "superseded"; stats.superseded++; continue;
      }
      const baseline = (tk.meta && tk.meta.attempts) || 0;
      const nowAttempts = attemptsOf(l).length;
      if (nowAttempts > baseline) {
        const last = attemptsOf(l)[nowAttempts - 1] || {};
        if (!body.dry) await sb.from("followup_tasks").update({ status: "done", completed_at: new Date().toISOString(), completed_by: tk.assigned_to, outcome: last.outcome || "logged" }).eq("id", tk.id);
        tk.status = "done"; tk.outcome = last.outcome; stats.done++; continue;
      }
      // Situation moved on (e.g. application completed, terms sent): this task no longer applies.
      const cur = candidates(l, tasksByLead, now).map((c) => c.sit);
      if (cur.indexOf(tk.situation) === -1) {
        if (!body.dry) await sb.from("followup_tasks").update({ status: "superseded", completed_at: new Date().toISOString() }).eq("id", tk.id);
        tk.status = "superseded"; stats.superseded++;
      }
    }
    const openByLead = {}; tasks.filter((x) => x.status === "open").forEach((x) => { openByLead[x.lead_id] = x; });

    // ---- B. Plan the next step for every lead; create tasks that are due soon ----
    const stalePool = []; // leads whose next step is long overdue: dripped in a few per day
    const dryPlans = [];
    for (const l of leads) {
      if (openByLead[l.id]) continue;
      const plan = bestPlan(l, tasksByLead, now);
      if (!plan) continue;
      if (!taskAllowed(l.assigned_to || "owner") && !body.dry) continue;
      if (body.dry) dryPlans.push({ id: l.id, name: l.name, lo: l.assigned_to, stage: l.stage, sit: plan.sit, title: plan.title, dueAt: new Date(plan.dueAt).toISOString(), stale: plan.dueAt < now - STALE_AFTER_MS });
      if (plan.dueAt < now - STALE_AFTER_MS && !plan.urgent) { stalePool.push({ l, plan }); continue; }
      if (plan.dueAt > now + 14 * 3600000) continue;
      if (body.dry) continue;
      const created = await createTask(l, plan, false);
      if (created) { openByLead[l.id] = created; stats.created++; }
    }

    // ---- C. Backlog drip: a few stale leads per loan officer per day, most valuable first ----
    if (!body.dry && t.hour >= 8 && t.hour < 17) {
      const perLo = {};
      stalePool.forEach((x) => { (perLo[x.l.assigned_to || "owner"] = perLo[x.l.assigned_to || "owner"] || []).push(x); });
      for (const [loId, pool] of Object.entries(perLo)) {
        if (!taskAllowed(loId)) continue;
        const dripToday = tasks.filter((x) => x.assigned_to === loId && x.meta && x.meta.drip && etParts(new Date(x.created_at)).date === t.date).length;
        const room = (cfg.backlog_per_day || 6) - dripToday;
        if (room <= 0) continue;
        pool.sort((a, b) => (b.plan.pri - a.plan.pri) || (new Date(b.l.created_at_ts) - new Date(a.l.created_at_ts)));
        for (const x of pool.slice(0, room)) {
          x.plan.dueAt = now;
          const created = await createTask(x.l, x.plan, true);
          if (created) { stats.drip++; stats.created++; }
        }
      }
    }
    if (body.dry) return new Response(JSON.stringify({ ok: true, dry: true, stats, plans: dryPlans.slice(0, 400) }), { headers: { "Content-Type": "application/json" } });

    async function createTask(l, plan, drip) {
      const row = {
        lead_id: l.id, assigned_to: l.assigned_to || "owner", situation: plan.sit, step_key: plan.key, step_n: plan.idx || 0,
        channel: plan.ch, title: plan.title, goal: plan.goal, lever: plan.lever, due_at: new Date(plan.dueAt).toISOString(),
        priority: plan.pri || 50, urgent: !!plan.urgent, status: "open",
        meta: { anchor: plan.anchor, attempts: attemptsOf(l).length, drip: !!drip, noText: !!plan.noText, stale: drip },
      };
      const { data, error } = await sb.from("followup_tasks").insert(row).select().single();
      if (error) return null; // already exists for this step -- fine
      tasksByLead[l.id] = (tasksByLead[l.id] || []).concat([data]);
      tasks.push(data);
      return data;
    }

    // ---- D. Briefs for tasks due within the next 2 hours ----
    let briefsMade = 0;
    for (const tk of tasks.filter((x) => x.status === "open" && !x.brief && new Date(x.due_at).getTime() <= now + 2 * 3600000)) {
      if (briefsMade >= MAX_BRIEFS_PER_RUN) break;
      const l = byId[tk.lead_id]; if (!l) continue;
      const lo = users[tk.assigned_to] || { name: "your loan officer" };
      const plan = { sit: tk.situation, title: tk.title, goal: tk.goal, lever: tk.lever };
      const brief = await makeBrief(l, plan, lo);
      await sb.from("followup_tasks").update({ brief }).eq("id", tk.id);
      tk.brief = brief; briefsMade++; stats.briefs++;
    }

    // ---- E. Text the loan officers ----
    const inWindow = (t.hour > 8 || (t.hour === 8 && t.minute >= 30)) && t.hour < 20;
    const openTasks = tasks.filter((x) => x.status === "open");
    const hourAgo = now - 3600000;
    // morning digest (8:30-8:45)
    if (t.hour === 8 && t.minute >= 30 && t.minute < 45) {
      const byLo = {};
      openTasks.filter((x) => new Date(x.due_at).getTime() <= now + 10 * 3600000).forEach((x) => { (byLo[x.assigned_to] = byLo[x.assigned_to] || []).push(x); });
      for (const [loId, list] of Object.entries(byLo)) {
        if (!userAllowed(loId)) continue;
        if (!(await claim("_digest_" + loId, "digest-" + t.date, String(list.length)))) continue;
        list.sort((a, b) => (b.priority - a.priority) || (new Date(a.due_at) - new Date(b.due_at)));
        const overdue = list.filter((x) => new Date(x.due_at).getTime() < now - 12 * 3600000).length;
        const names = list.slice(0, 3).map((x) => (byId[x.lead_id]?.name || "").split(" ")[0] + " (" + x.title.split(" — ")[0].toLowerCase().slice(0, 28) + ")").join(", ");
        await textUser(loId, `Good morning ${first(users[loId]?.name)} — ${list.length} follow-up${list.length > 1 ? "s" : ""} today${overdue ? " (" + overdue + " overdue)" : ""}: ${names}${list.length > 3 ? " +" + (list.length - 3) + " more" : ""}. Work the list: ${CRM_URL}?brief=next`, null, "followup");
        stats.digests++;
      }
    }
    if (inWindow) {
      const sentThisHour = {};
      tasks.forEach((x) => { if (x.notified_at && new Date(x.notified_at).getTime() > hourAgo) sentThisHour[x.assigned_to] = (sentThisHour[x.assigned_to] || 0) + 1; });
      const due = openTasks.filter((x) => !x.notified_at && new Date(x.due_at).getTime() <= now).sort((a, b) => (Number(b.urgent) - Number(a.urgent)) || (b.priority - a.priority) || (new Date(a.due_at) - new Date(b.due_at)));
      for (const tk of due) {
        const l = byId[tk.lead_id]; if (!l) continue;
        if (!userAllowed(tk.assigned_to)) continue;
        if (tk.meta && tk.meta.noText) { await sb.from("followup_tasks").update({ notified_at: new Date().toISOString() }).eq("id", tk.id); continue; }
        if (!tk.brief && now - new Date(tk.due_at).getTime() < 8 * 60000) continue; // give the brief a moment
        if (!tk.urgent && (sentThisHour[tk.assigned_to] || 0) >= (cfg.text_cap_per_hour || 3)) continue;
        if (await textUser(tk.assigned_to, taskSms(tk, l, tk.brief), l.id, tk.urgent ? "hot-lead" : "followup")) {
          await sb.from("followup_tasks").update({ notified_at: new Date().toISOString() }).eq("id", tk.id);
          sentThisHour[tk.assigned_to] = (sentThisHour[tk.assigned_to] || 0) + 1; stats.pings++;
        }
      }
      // one reminder 2h after the first text, then escalation to Joe after a full business day
      const escalate = {};
      for (const tk of openTasks.filter((x) => x.notified_at)) {
        const l = byId[tk.lead_id]; if (!l || !userAllowed(tk.assigned_to)) continue;
        const since_ = now - new Date(tk.notified_at).getTime();
        if (tk.reminder_count === 0 && cfg.staff_texts !== false && since_ >= (tk.urgent ? 30 : 120) * 60000) {
          await textUser(tk.assigned_to, `⏰ Still open: ${l.name} — ${tk.title}.${l.phone ? " " + l.phone : ""} Brief + log: ${taskLink(tk)}`, l.id, "followup");
          await sb.from("followup_tasks").update({ reminded_at: new Date().toISOString(), reminder_count: 1 }).eq("id", tk.id);
          stats.reminders++;
        } else if (tk.reminder_count >= 1 && !(tk.meta && tk.meta.escalated) && now - new Date(tk.due_at).getTime() > 24 * 3600000 && tk.assigned_to !== "owner") {
          (escalate[tk.assigned_to] = escalate[tk.assigned_to] || []).push({ tk, l });
        }
      }
      // Urgent follow-ups (new lead, terms owed, scheduled callback) not touched 30 business-minutes after due: tell Joe once.
      for (const tk of openTasks.filter((x) => x.urgent && x.notified_at && x.assigned_to !== "owner" && !(x.meta && x.meta.joe30))) {
        const l = byId[tk.lead_id]; if (!l || !userAllowed("owner")) continue;
        const start = workStartMs(new Date(tk.due_at).getTime());
        if (now - start < 30 * 60000) continue;
        await textUser("owner", `🔴 ${users[tk.assigned_to]?.name || tk.assigned_to} hasn't acted on "${tk.title.slice(0, 40)}" for ${l.name} in ${Math.round((now - start) / 60000)} min. ${l.phone || ""} ${CRM_URL}?lead=${l.id}`, l.id, "escalation");
        await sb.from("followup_tasks").update({ meta: Object.assign({}, tk.meta, { joe30: true }) }).eq("id", tk.id);
        tk.meta = Object.assign({}, tk.meta, { joe30: true });
        stats.escalations++;
      }
      for (const [loId, items] of Object.entries(escalate)) {
        if (!userAllowed("owner")) break;
        const lines = items.slice(0, 4).map((x) => x.l.name + " (" + x.tk.title.slice(0, 30) + ", due " + Math.round((now - new Date(x.tk.due_at).getTime()) / 3600000) + "h ago)").join("; ");
        await textUser("owner", `🔴 ${users[loId]?.name || loId} has ${items.length} follow-up${items.length > 1 ? "s" : ""} open 24h+: ${lines}.`, null, "escalation");
        for (const x of items) await sb.from("followup_tasks").update({ meta: Object.assign({}, x.tk.meta, { escalated: true }) }).eq("id", x.tk.id);
        stats.escalations++;
      }
    }

    // ---- F. AI borrower touches (texts + emails) layered on the human follow-ups ----
    const isWeekday = dow(t.date) >= 1 && dow(t.date) <= 5;
    if (isWeekday && t.hour >= 9 && t.hour < 19) {
      let sent = 0;
      for (const l of leads) {
        if (sent >= MAX_AI_TOUCHES_PER_RUN) break;
        if (l.nurture_off || l.status === "spam" || !userAllowed(l.assigned_to || "owner")) continue;
        const lo = users[l.assigned_to || "owner"]; if (!lo) continue;
        if (touchedToday(l) || inboundText(l, 3)) continue;
        const cands = candidates(l, tasksByLead, now).filter((c) => SIT[c.sit] && SIT[c.sit].ai && SIT[c.sit].ai.length);
        if (!cands.length) continue;
        // use the lead's primary (best-planned) situation
        const plan = bestPlan(l, tasksByLead, now);
        const cand = cands.find((c) => plan && c.sit === plan.sit) || cands[0];
        if (cand.sit === "attempting" && String(l.created_at_ts) < LAUNCH_DATE) continue; // never auto-nurture the old backlog
        const textOk = !l.sms_opt_out && !!l.phone && (hasConsent(l) || !!l.ai_stage || inboundText(l, null));
        const emailOk = !!l.email;
        const aiDefs = SIT[cand.sit].ai;
        const dueDefs = aiDefs.filter((d) => {
          const base = cand.anchor === "created" ? cand.createdMs : cand.anchorMs;
          const target = d.off.h != null ? base + d.off.h * 3600000 : etMs(nextBiz(addDays(etParts(new Date(base)).date, d.off.d)), prefTime(l.id, 1, d.ch)[0], prefTime(l.id, 1, d.ch)[1]);
          return target <= now && (d.ch === "text" ? textOk : emailOk);
        });
        if (!dueDefs.length) continue;
        // skip anything already done; send only the latest due one, mark the earlier ones skipped
        const pending = [];
        for (const d of dueDefs) { const key = `ai:${cand.sit}:${cand.anchor}:${d.k}`; const { data: ex } = await sb.from("ad_followup_log").select("step").eq("lead_id", l.id).eq("step", key).maybeSingle(); if (!ex) pending.push({ d, key }); }
        if (!pending.length) continue;
        const { data: lastRows } = await sb.from("ad_followup_log").select("sent_at").eq("lead_id", l.id).like("step", "ai:%").order("sent_at", { ascending: false }).limit(1);
        if (lastRows && lastRows[0] && now - new Date(lastRows[0].sent_at).getTime() < 20 * 3600000) continue;
        const pick = pending[pending.length - 1];
        for (const p of pending.slice(0, -1)) await claim(l.id, p.key, "skipped");
        if (!(await claim(l.id, pick.key, "sent"))) continue;
        const msg = await makeTouch(pick.d, l, lo, cand.sit);
        if (!msg) { await sb.from("ad_followup_log").update({ detail: "generation failed" }).eq("lead_id", l.id).eq("step", pick.key); continue; }
        if (pick.d.ch === "text") await post("send-text", { leadId: l.id, to: l.phone, text: msg.body, fromName: lo.name, initiatedBy: "ai" });
        else await post("send-email", { leadId: l.id, to: l.email, subject: msg.subject, text: msg.body, fromName: lo.name, fromAddress: lo.email, fromUserId: lo.id, fromPhotoUrl: lo.photo_url || null, initiatedBy: "ai" });
        sent++; stats.ai++;
      }
    }

    return new Response(JSON.stringify({ ok: true, mode: cfg.mode, stats }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("followup-engine error", String(err), err && err.stack);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
