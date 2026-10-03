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
// Routing: every ad lead lands on the owner, matching meta-leads-webhook
// ("default to me until I change it"). Change ASSIGNEE to re-route.
//
// First-contact text and email go out immediately at any hour (Joe's call).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const ASSIGNEE = "owner";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const b = await req.json();
    if (clean(b.website)) return json({ ok: true }); // honeypot: bots fill the hidden field, say "ok" and drop it

    const program = b.program === "fixflip" ? "fixflip" : "dscr";
    const loanType = program === "fixflip" ? "Fix & Flip" : "DSCR";
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
    const stamp = new Date().toISOString();

    // --- Repeat submission? Attach to the existing file, don't duplicate. ---
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: recent } = await sb.from("leads").select("id,name,phone,email,activity,assigned_to,status").gte("created_at", since);
    const existing = (recent || []).find((l: Record<string, unknown>) =>
      (((l.phone as string) || "").replace(/\D/g, "").slice(-10) === phoneDigits) || (!!l.email && (l.email as string).toLowerCase() === email));
    if (existing) {
      const activity = (existing.activity as unknown[]) || [];
      activity.push({ date: today, type: "note", text: "Filled out the " + loanType + " ad landing page again" + (utm ? " (" + utm + ")" : "") + " — already on file, no duplicate created", author: "System" });
      await sb.from("leads").update({ activity }).eq("id", existing.id as string);
      if (existing.assigned_to) {
        await sb.from("notifications").insert({
          id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: existing.assigned_to, lead_id: existing.id, kind: "hot-lead",
          text: (existing.name as string) + " just filled out the " + loanType + " ad form again — they're actively shopping", date: today, read: false,
        });
      }
      return json({ ok: true, repeat: true });
    }

    // --- Build the file --------------------------------------------------
    const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const answers: string[] = [];
    if (goal) answers.push("Goal: " + (goal === "purchase" ? "purchase" : goal === "refi" ? "rate/term refinance" : "cash-out refinance"));
    if (creditLabel) answers.push("Credit: " + creditLabel);
    if (experience) answers.push("Experience: " + experience);
    if (timeline) answers.push("Timeline: " + timeline);
    const activity: Record<string, string>[] = [
      { date: today, type: "note", text: "Lead captured from the " + loanType + " Meta-ad landing page" + (utm ? " (" + utm + ")" : ""), author: "System" },
      { date: today, type: "note", text: "Landing page answers — " + (answers.join(" · ") || "none"), author: "System" },
      { date: today, type: "system", text: "TCPA consent recorded " + stamp + ": borrower checked the box agreeing to calls, texts and email from Bridgepoint Lending at " + phone + " / " + email + " (marketing, may be autodialed, not a condition of any loan; msg & data rates apply; reply STOP to opt out).", author: "System" },
    ];
    const row: Record<string, unknown> = {
      id, name, email, phone, source: "Meta Ads — " + loanType + " Landing Page", loan_type: loanType,
      stage: "new", status: "active", assigned_to: ASSIGNEE, created_at: today, created_at_ts: stamp,
      property_type: propertyType, transaction_type: transactionType,
      credit_score: credit, experience_deals: experienceDeals,
      ai_stage: "engaging", entity_type: "LLC", application_token: crypto.randomUUID(), preferred_language: "en",
      activity,
    };
    if (program === "dscr") {
      row.current_value = transactionType === "purchase" ? null : valueAmt;
      row.purchase_price = transactionType === "purchase" ? valueAmt : null;
      row.rent_estimate = rent;
    } else {
      row.purchase_price = valueAmt;
      row.rehab_budget = rehab;
      row.arv = arv;
    }
    const { error } = await sb.from("leads").insert(row);
    if (error) {
      console.error("ad-lead-intake: insert failed", error.message);
      return json({ error: "server_error", detail: "We couldn't save that — please try again." }, 500);
    }

    // --- Alert the loan officer -------------------------------------------
    const link = CRM_URL + "?lead=" + id;
    const alertText = "🔥 New " + loanType + " ad lead: " + name + " — open & dial: " + link;
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
    if (lo) {
      try {
        const bookingLink = CRM_URL + "?book=" + ASSIGNEE;
        const known: string[] = ["Loan type: " + loanType].concat(answers);
        if (propertyType) known.push("Property: " + propertyType);
        if (valueAmt) known.push((goal === "purchase" ? "Purchase price" : "Property value") + ": about $" + Math.round(valueAmt).toLocaleString());
        if (rent) known.push("Monthly rent: about $" + Math.round(rent).toLocaleString());
        if (rehab) known.push("Rehab budget: about $" + Math.round(rehab).toLocaleString());
        if (arv) known.push("After-repair value: about $" + Math.round(arv).toLocaleString());
        const prompt = "You are " + lo.name + ", owner of Bridgepoint Lending (business-purpose real estate investor loans — not consumer mortgages). " +
          "A real estate investor just filled out our " + loanType + " web form. Write a short first text message (max 3 sentences, plain, friendly, no emojis, no promises of approval, no rates). " +
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
    return json({ ok: true, leadId: id });
  } catch (err) {
    console.error("ad-lead-intake: error", String(err));
    return json({ error: "server_error", detail: "Something went wrong — please try again." }, 500);
  }
});
