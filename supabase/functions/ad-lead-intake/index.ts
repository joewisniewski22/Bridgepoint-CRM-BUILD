// Public lead intake for the Meta-ad landing pages (/lp/dscr, /lp/fix-flip).
// The landing pages post here; this validates, de-duplicates, creates the loan
// file, alerts the assigned loan officer, and (with the borrower's recorded
// consent) sends one AI first-contact text + email in English.
//
// Public on purpose (the form is filled by strangers), so it is defensive:
// honeypot field, strict field whitelist and length caps, consent required,
// and a repeat submission from the same phone/email within 30 days is attached
// to the existing file instead of creating a duplicate.
//
// Routing: round-robin across the loan officers per pickEnglishAdLO below.
//
// First-contact text and email go out immediately at any hour (Joe's call).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
// Borrower-facing links (booking, application/portal) use the branded domain -- the
// vercel.app address trips carrier spam filters. Staff links stay on CRM_URL.
const CLIENT_URL = "https://app.bplending.com/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// English ad-lead routing (Joe, 2026-10-03): 30% to Joe, the rest split evenly
// between Fiore, Taeya and Theresa. Deterministic rotation, not random: each
// new lead goes to whoever is furthest below their target share of the ad
// leads created since ROUTING_START. (Spanish-ad leads are routed separately
// in highlevel-leads-webhook.)
const ROUTING_START = "2026-10-03";
const ROUTE_TARGETS: Array<{ id: string; weight: number }> = [
  { id: "owner", weight: 0.30 },
  { id: "lo-fiore", weight: 0.70 / 3 },
  { id: "lo-taeya", weight: 0.70 / 3 },
  { id: "lo-theresa", weight: 0.70 / 3 },
];
async function pickEnglishAdLO(client: ReturnType<typeof createClient>): Promise<string> {
  const { data } = await client.from("leads").select("assigned_to")
    .gte("created_at", ROUTING_START).or("source.like.Meta Ads*,source.like.Website*Quote Form,source.like.Website*Application,source.like.Website*Deal Analyzer").in("assigned_to", ROUTE_TARGETS.map((r) => r.id));
  const counts: Record<string, number> = {};
  (data || []).forEach((r: Record<string, unknown>) => { counts[r.assigned_to as string] = (counts[r.assigned_to as string] || 0) + 1; });
  const total = (data || []).length;
  let best = ROUTE_TARGETS[0], bestDeficit = -Infinity;
  for (const r of ROUTE_TARGETS) {
    const deficit = r.weight * (total + 1) - (counts[r.id] || 0);
    if (deficit > bestDeficit + 1e-9) { best = r; bestDeficit = deficit; }
  }
  return best.id;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const PROPERTY_TYPES = ["SFR", "Duplex", "2-4 Unit", "Multifamily 5+", "Mixed-Use", "Condo"];
const CREDIT_MIDPOINTS: Record<string, number> = { "Under 640": 620, "640-679": 660, "680-719": 700, "720-759": 740, "760+": 780 };
const TIMELINES = ["ASAP (under 30 days)", "30-60 days", "60+ days", "Just exploring"];

function clean(v: unknown, max = 200): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max) : "";
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return isFinite(n) && n > 0 && n < 1e10 ? n : null;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

// Funnel + outcome log (2026-10-08, "why aren't we getting Facebook leads"): every landing-page
// step reached and every submit outcome goes to ad_intake_log, so a dead form or a silent drop
// can't hide again. Never blocks a lead.
async function logIntake(row: Record<string, unknown>) {
  try { await sb.from("ad_intake_log").insert(row); } catch (_) { /* tracking only */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch (_) { return json({ error: "invalid" }, 400); }
  const base = { program: clean(b.program, 12) || null, session: clean(b.session, 40) || null, utm_campaign: clean(b.utm_campaign, 80) || null, utm_content: clean(b.utm_content, 80) || null, src: clean(b.src, 10) || "lp" };
  // Step pings from the landing-page quiz: log only, nothing else happens.
  if (b.ping === true) {
    const step = Math.max(0, Math.min(9, parseInt(String(b.step), 10) || 0));
    await logIntake({ ...base, kind: "step", step });
    return json({ ok: true });
  }
  const res = await handle(b);
  let outcome = "error";
  try { const j = await res.clone().json(); outcome = j.ok ? (j.dropped ? "honeypot" : j.repeat ? "repeat" : "created") : (j.error === "invalid" ? "invalid: " + (j.detail || "") : (j.error || "error")); } catch (_) { /* keep "error" */ }
  await logIntake({ ...base, kind: "submit", outcome: outcome.slice(0, 120), status: res.status });
  if (outcome === "honeypot") return json({ ok: true });
  return res;
});

async function handle(b: Record<string, unknown>): Promise<Response> {
  try {
    // Honeypot: bots fill the hidden "website" field. iPhone AutoFill can fill it too, so a
    // submission that also answered the quiz (only possible with JavaScript, clicking through
    // the steps) is a person -- keep it and note it instead of silently dropping a real lead.
    const trapped = !!clean(b.website);
    const answeredQuiz = !!(clean(b.goal, 20) || clean(b.propertyType, 40) || clean(b.credit, 20) || clean(b.tool, 12) || b.apply === true);
    if (trapped && !answeredQuiz) return json({ ok: true, dropped: true });

    // Programs: the two Meta-ad landing pages send dscr | fixflip; the website quote form can also send
    // bridge | ground | portfolio (priced like the other short-term/portfolio files from the same fields).
    const LOAN_TYPES: Record<string, string> = { dscr: "DSCR", fixflip: "Fix & Flip", bridge: "Bridge", ground: "Ground Up Construction", portfolio: "Portfolio/Blanket" };
    const program = LOAN_TYPES[String(b.program)] ? String(b.program) : "dscr";
    const loanType = LOAN_TYPES[program];
    const isSite = clean(b.src, 10) === "site";
    const isApply = isSite && b.apply === true;
    const isTool = isSite && clean(b.tool, 12) === "analyzer"; // the free Deal Analyzer on bplending.com // "Apply Now" on bplending.com: they get their application link on screen // bplending.com forms vs. the ad landing pages
    const channel = isSite ? "website" : "Meta-ad landing page";
    const stateCode = clean(b.state, 2).toUpperCase();
    const addressIn = clean(b.address, 160);
    const estimateNote = clean(b.estimate, 200);
    const name = clean(b.name, 80);
    const email = clean(b.email, 120).toLowerCase();
    const phoneDigits = clean(b.phone, 30).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (name.length < 2) return json({ error: "invalid", detail: "Please enter your name." }, 400);
    if (phoneDigits.length !== 10) return json({ error: "invalid", detail: "Please enter a 10-digit phone number." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "invalid", detail: "Please enter a valid email." }, 400);
    if (b.consent !== true) return json({ error: "invalid", detail: "Please check the box to let us contact you." }, 400);
    const phone = "(" + phoneDigits.slice(0, 3) + ") " + phoneDigits.slice(3, 6) + "-" + phoneDigits.slice(6);

    const propertyTypeRaw = clean(b.propertyType, 40);
    const propertyType = PROPERTY_TYPES.indexOf(propertyTypeRaw) !== -1 ? propertyTypeRaw : null;
    const goal = clean(b.goal, 20); // purchase | refi | cashout
    const transactionType = goal === "refi" ? "ratetermrefi" : goal === "cashout" ? "cashout" : "purchase";
    const valueAmt = num(b.value);
    const rent = num(b.rent);
    const rehab = num(b.rehab);
    const arv = num(b.arv);
    const credit = CREDIT_MIDPOINTS[clean(b.credit, 20)] || null;
    const creditLabel = clean(b.credit, 20);
    const experience = clean(b.experience, 20);
    const experienceDeals = experience === "First deal" ? 0 : experience === "1-2 deals" ? 1 : experience === "3-5 deals" ? 3 : experience === "6+ deals" ? 6 : null;
    const timeline = TIMELINES.indexOf(clean(b.timeline, 40)) !== -1 ? clean(b.timeline, 40) : "";
    const utm = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].map((k) => clean(b[k], 80) ? k.replace("utm_", "") + "=" + clean(b[k], 80) : "").filter(Boolean).join(", ");
    const today = new Date().toISOString().slice(0, 10);
    // source attribution: which post / ad / link brought this person (kept in its own table so it can be reported on)
    const attr = { utm_source: clean(b.utm_source, 80) || null, utm_medium: clean(b.utm_medium, 80) || null, utm_campaign: clean(b.utm_campaign, 80) || null, utm_content: clean(b.utm_content, 120) || null, utm_term: clean(b.utm_term, 80) || null, landing: clean(b.landing, 160) || null, referrer: clean(b.referrer, 200) || null };
    const logAttr = async (leadId: string, kind: string) => { if (Object.values(attr).some(Boolean)) { try { await sb.from("lead_attribution").insert({ lead_id: leadId, kind, tool: isTool ? "analyzer" : (isApply ? "apply" : "quote"), ...attr }); } catch (_) { /* never block a lead on tracking */ } } };
    const stamp = new Date().toISOString();

    // --- Sent from the CRM ("Send Deal Analyzer", Joe 2026-10-06)? ----------
    // The link carries ?ref=<file id>. If the phone or email matches that file
    // (any age), attach the analysis there and ping its LO -- never a new file
    // and never re-routed by round-robin.
    const ref = clean(b.ref, 40);
    if (ref) {
      const { data: refLead } = await sb.from("leads").select("id,name,phone,email,activity,assigned_to").eq("id", ref).maybeSingle();
      const same = refLead && ((((refLead.phone as string) || "").replace(/\D/g, "").slice(-10) === phoneDigits) || (!!refLead.email && (refLead.email as string).toLowerCase() === email));
      // Social leads (Facebook/Instagram comment or DM, 2026-10-07) start with no phone/email:
      // the link we DM'd them carries their file id, so their submission fills it in.
      const blankSocial = refLead && !refLead.phone && !refLead.email && (phoneDigits || email);
      if (refLead && (same || blankSocial)) {
        const summary = clean(b.estimate, 300);
        const activity = (refLead.activity as unknown[]) || [];
        if (blankSocial) {
          activity.push({ date: today, type: "note", text: "Added their contact info from the Deal Analyzer link we sent (" + [phone, email].filter(Boolean).join(", ") + ")", author: "System" });
          activity.push({ date: today, type: "note", text: "TCPA consent recorded — agreed to the contact disclaimer on the Deal Analyzer form", author: "System" });
          await sb.from("leads").update({ phone: phone || null, email: email || null, ai_stage: "engaging" }).eq("id", refLead.id as string);
        }
        activity.push({ date: today, type: "note", text: "Ran the Deal Analyzer from the link you sent" + (summary ? " — " + summary : "") + (num(b.value) ? " (price " + num(b.value) + (num(b.rehab) ? ", rehab " + num(b.rehab) : "") + (num(b.arv) ? ", ARV " + num(b.arv) : "") + (num(b.rent) ? ", rent " + num(b.rent) : "") + ")" : ""), author: "System" });
        await sb.from("leads").update({ activity }).eq("id", refLead.id as string);
        await logAttr(refLead.id as string, "crm-share");
        if (refLead.assigned_to) {
          await sb.from("notifications").insert({
            id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: refLead.assigned_to, lead_id: refLead.id, kind: "hot-lead",
            text: (refLead.name as string) + " just ran a deal in the Deal Analyzer you sent — call them while it's fresh", date: today, read: false,
          });
        }
        return json({ ok: true, repeat: true, leadId: isTool ? (refLead.id as string) : undefined });
      }
    }

    // --- Repeat submission? Attach to the existing file, don't duplicate. ---
    // Any age (10/9: Roscoe Davis came back months later and became a second file for another
    // LO because this only looked back 30 days). Skips spam/duplicates; prefers a working file
    // (active/cold) over a lost one, then the newest.
    const { data: recent } = await sb.from("leads").select("id,name,phone,email,activity,assigned_to,status,application_token,created_at_ts,lost_reason").neq("status", "spam");
    const matches = (recent || []).filter((l: Record<string, unknown>) => l.lost_reason !== "Duplicate" &&
      ((phoneDigits.length === 10 && ((l.phone as string) || "").replace(/\D/g, "").slice(-10) === phoneDigits) || (!!l.email && (l.email as string).toLowerCase() === email)));
    const rank = (l: Record<string, unknown>) => (l.status === "active" ? 2 : l.status === "cold" ? 1 : 0);
    matches.sort((a: Record<string, unknown>, b: Record<string, unknown>) => rank(b) - rank(a) || String(b.created_at_ts || "").localeCompare(String(a.created_at_ts || "")));
    const existing = matches[0];
    if (existing) {
      const activity = (existing.activity as unknown[]) || [];
      activity.push({ date: today, type: "note", text: "Filled out the " + loanType + " " + (isTool ? "Deal Analyzer" : channel) + " form again" + (utm ? " (" + utm + ")" : "") + " — already on file, no duplicate created", author: "System" });
      await sb.from("leads").update({ activity }).eq("id", existing.id as string);
      await logAttr(existing.id as string, "repeat");
      if (existing.assigned_to) {
        await sb.from("notifications").insert({
          id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: existing.assigned_to, lead_id: existing.id, kind: "hot-lead",
          text: (existing.name as string) + " just filled out the " + loanType + " " + (isSite ? "website" : "ad") + " form again — they're actively shopping", date: today, read: false,
        });
      }
      return json({ ok: true, repeat: true, leadId: isTool ? (existing.id as string) : undefined, applyUrl: isApply && existing.application_token ? (CLIENT_URL + "?apply=" + existing.id + "&t=" + existing.application_token) : undefined });
    }

    // --- Build the file --------------------------------------------------
    const ASSIGNEE = await pickEnglishAdLO(sb);
    const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const appToken = crypto.randomUUID();
    const answers: string[] = [];
    if (goal) answers.push("Goal: " + (goal === "purchase" ? "purchase" : goal === "refi" ? "rate/term refinance" : "cash-out refinance"));
    if (creditLabel) answers.push("Credit: " + creditLabel);
    if (experience) answers.push("Experience: " + experience);
    if (timeline) answers.push("Timeline: " + timeline);
    if (stateCode) answers.push("State: " + stateCode);
    if (estimateNote) answers.push("Saw on the estimator: " + estimateNote);
    const activity: Record<string, string>[] = [
      { date: today, type: "note", text: "Lead captured from the " + loanType + " " + channel + (utm ? " (" + utm + ")" : ""), author: "System" },
      { date: today, type: "note", text: "Landing page answers — " + (answers.join(" · ") || "none"), author: "System" },
      { date: today, type: "system", text: "TCPA consent recorded " + stamp + ": borrower checked the box agreeing to calls, texts and email from Bridgepoint Lending at " + phone + " / " + email + " (marketing, may be autodialed, not a condition of any loan; msg & data rates apply; reply STOP to opt out).", author: "System" },
    ];
    if (trapped) activity.push({ date: today, type: "note", text: "Note: the form's hidden anti-spam field was filled (usually phone AutoFill) — they answered the quiz, so the lead was kept. Verify it's a real person.", author: "System" });
    const row: Record<string, unknown> = {
      id, name, email, phone, source: isSite ? ("Website — " + loanType + (isApply ? " Application" : isTool ? " Deal Analyzer" : " Quote Form")) : ("Meta Ads — " + loanType + " Landing Page"), loan_type: loanType, property_address: addressIn || null,
      stage: isApply ? "app_sent" : "new", status: "active", application_sent_at: isApply ? today : null, assigned_to: ASSIGNEE, created_at: today, created_at_ts: stamp,
      property_type: propertyType, transaction_type: transactionType,
      credit_score: credit, experience_deals: experienceDeals,
      ai_stage: "engaging", entity_type: "LLC", application_token: appToken, preferred_language: "en",
      activity,
    };
    if (program === "dscr" || program === "portfolio") {
      row.current_value = transactionType === "purchase" ? null : valueAmt;
      row.purchase_price = transactionType === "purchase" ? valueAmt : null;
      row.rent_estimate = rent;
    } else {
      row.purchase_price = valueAmt;
      row.rehab_budget = rehab;
      row.arv = arv;
    }
    const { error } = await sb.from("leads").insert(row);
    if (!error) await logAttr(id, "new");
    if (error) {
      console.error("ad-lead-intake: insert failed", error.message);
      return json({ error: "server_error", detail: "We couldn't save that — please try again." }, 500);
    }

    // --- Alert the loan officer -------------------------------------------
    const link = CRM_URL + "?lead=" + id;
    const alertText = isApply ? ("🔥 " + name + " just clicked Apply Now on the website (" + loanType + ") and is filling out the application — call now: " + CRM_URL + "?lead=" + id) : "🔥 New " + loanType + (isSite ? " website lead: " : " ad lead: ") + name + " — open & dial: " + link;
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: ASSIGNEE, lead_id: id, kind: "hot-lead", text: alertText, date: today, read: false,
    });
    const { data: lo } = await sb.from("users").select("id,name,email,phone,photo_url").eq("id", ASSIGNEE).single();
    const post = (fn: string, payload: Record<string, unknown>) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload),
    }).catch(() => null);
    if (lo?.phone) await post("send-text", { to: lo.phone, text: alertText, fromName: "Bridgepoint CRM" });
    if (lo?.email) await post("send-email", { to: lo.email, subject: "New " + loanType + " lead: " + name, text: alertText, fromName: "Bridgepoint CRM" });

    // --- AI first contact (English), consent recorded above ----------------
    if (lo && !isApply) {
      try {
        const bookingLink = CLIENT_URL + "?book=" + ASSIGNEE;
        const known: string[] = ["Loan type: " + loanType].concat(answers);
        if (propertyType) known.push("Property: " + propertyType);
        if (valueAmt) known.push((goal === "purchase" ? "Purchase price" : "Property value") + ": about $" + Math.round(valueAmt).toLocaleString());
        if (rent) known.push("Monthly rent: about $" + Math.round(rent).toLocaleString());
        if (rehab) known.push("Rehab budget: about $" + Math.round(rehab).toLocaleString());
        if (arv) known.push("After-repair value: about $" + Math.round(arv).toLocaleString());
        const prompt = "You are " + lo.name + ", a loan officer at Bridgepoint Lending (business-purpose real estate investor loans — not consumer mortgages). " +
          "A real estate investor just filled out our " + loanType + " " + (isTool ? "Deal Analyzer on our website and downloaded their analysis" : "web form") + ". Write a short first text message (max 3 sentences, plain, friendly, no emojis, no promises of approval, no rates). " +
          "Thank them by first name, show you read their answers, and invite them to grab a quick call here: " + bookingLink + " — or just reply with the property address and you'll run numbers.\n\n" +
          "First name: " + name.split(/\s+/)[0] + "\nWhat they told us:\n- " + known.join("\n- ") + "\n\nReply with ONLY the message text.";
        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
        });
        const aiData = await aiRes.json();
        const message: string = aiRes.ok ? (aiData.content?.[0]?.text || "").trim() : "";
        if (message) {
          await post("send-email", {
            leadId: id, to: email, subject: "Your " + loanType + " loan request — Bridgepoint Lending", text: message,
            fromName: lo.name, fromAddress: lo.email, fromUserId: lo.id, fromPhotoUrl: lo.photo_url || null, initiatedBy: "ai",
          });
          // Joe, 2026-10-03: text and email go out at any hour -- someone filling
          // out the form at 2am is awake. (No quiet-hours hold.)
          await post("send-text", { leadId: id, to: phone, text: message, fromName: lo.name, initiatedBy: "ai" });
        }
      } catch (e) {
        console.error("ad-lead-intake: AI first contact failed", String(e));
      }
    }
    return json({ ok: true, leadId: id, applyUrl: isApply ? (CLIENT_URL + "?apply=" + id + "&t=" + appToken) : undefined });
  } catch (err) {
    console.error("ad-lead-intake: error", String(err));
    return json({ error: "server_error", detail: "Something went wrong — please try again." }, 500);
  }
}
