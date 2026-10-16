// Called by receive-text whenever a lead enrolled in the conversion-texting
// automation (lead.ai_stage set, automation_paused false) sends a reply.
// Runs one Claude call to (a) resolve English/Spanish on the first reply if
// the assigned LO is bilingual, (b) draft the next conversion-focused text,
// and (c) pull out any clearly-stated loan details to auto-fill -- never
// overwriting a field that's already set. Sends the reply itself via
// send-text. Stops entirely once automation_paused is set (the LO's own
// "Stop Automation" button) -- checked by the caller before invoking this.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-5";
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
// Borrower-facing links (booking, application/portal) use the branded domain -- the
// vercel.app address trips carrier spam filters. Staff links stay on CRM_URL.
const CLIENT_URL = "https://app.bplending.com/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Only ever fills a field when it's currently empty -- never overwrites a
// value someone (or a prior AI turn) already set.
const FIELD_MAP: Record<string, string> = {
  loanType: "loan_type",
  propertyAddress: "property_address",
  purchasePrice: "purchase_price",
  loanAmount: "loan_amount",
  creditScore: "credit_score",
  propertyType: "property_type",
  exitStrategy: "exit_strategy",
  // Pricing inputs (Joe 2026-10-12): collected over text so the deal can be priced privately for the loan officer.
  rehabBudget: "rehab_budget",
  arv: "arv",
  experienceDeals: "experience_deals",
  rentEstimate: "rent_estimate",
  monthlyTaxes: "monthly_taxes",
  monthlyInsurance: "monthly_insurance",
  currentValue: "current_value",
  transactionType: "transaction_type",
  citizenshipStatus: "citizenship_status",
};

const RATE_KEY_BY_LOAN_TYPE: Record<string, string> = {
  "DSCR": "dscr", "Fix & Flip": "fixFlip", "Ground Up Construction": "groundUp",
  "Portfolio/Blanket": "portfolio", "Bridge": "bridge", "Mixed-Use": "mixedUse",
};
const KNOWN_LOAN_TYPES = ["DSCR", "Fix & Flip", "Bridge", "Ground Up Construction", "Portfolio/Blanket", "Mixed-Use"];
function normalizeLoanType(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (t.includes("fix") && t.includes("flip")) return "Fix & Flip";
  if (t.includes("dscr") || t.includes("rental")) return "DSCR";
  if (t.includes("bridge")) return "Bridge";
  if (t.includes("ground up") || t.includes("construction")) return "Ground Up Construction";
  if (t.includes("portfolio") || t.includes("blanket")) return "Portfolio/Blanket";
  if (t.includes("mixed")) return "Mixed-Use";
  return null;
}
function applicationLink(leadId: string, token: string): string {
  return CLIENT_URL + "?apply=" + leadId + "&t=" + (token || "");
}

function marketRateContext(loanType: string, rates: Array<Record<string, unknown>>): string {
  const key = RATE_KEY_BY_LOAN_TYPE[loanType];
  const row = rates.find((r) => r.key === key);
  if (!row) return "";
  const current = row.current as number;
  const previous = row.previous as number;
  if (current == null) return "";
  if (previous != null && current < previous) {
    return "Current market note: " + loanType + " rates just moved down to " + current + "% (from " + previous + "%) -- a real, timely reason to move now if it fits naturally, don't force it.";
  }
  return "Current market note: " + loanType + " rates are at " + current + "% right now.";
}

// What it takes to price each loan type, in the order the AI should ask (one at a time, only when it fits the conversation).
const NEED_BY_TYPE: Record<string, string[]> = {
  "Fix & Flip": ["propertyAddress", "purchasePrice", "rehabBudget", "arv", "creditScore", "experienceDeals"],
  "Bridge": ["propertyAddress", "purchasePrice", "creditScore", "experienceDeals"],
  "Ground Up Construction": ["propertyAddress", "purchasePrice", "rehabBudget", "arv", "creditScore", "experienceDeals"],
  "DSCR": ["propertyAddress", "purchasePrice", "rentEstimate", "creditScore"],
  "Mixed-Use": ["propertyAddress", "purchasePrice", "rentEstimate", "creditScore"],
};
const ASK_FOR: Record<string, string> = {
  propertyAddress: "the property address (street, city and state)",
  purchasePrice: "the purchase price (or what it's worth today if they already own it)",
  rehabBudget: "roughly how much the rehab or construction will cost",
  arv: "what they expect it to be worth after the work is done (the after-repair value)",
  creditScore: "their approximate credit score",
  experienceDeals: "how many flips, builds or rentals they've completed in the last 3 years (zero is fine)",
  rentEstimate: "the monthly rent it brings in or should bring in",
};
const NUMERIC_FIELDS = ["purchasePrice", "loanAmount", "creditScore", "rehabBudget", "arv", "rentEstimate", "monthlyTaxes", "monthlyInsurance", "currentValue"];
function normalizeTxn(text: string): string | null {
  const t = text.toLowerCase();
  if (/cash.?out/.test(t)) return "cashout";
  if (/refi|refinanc|rate.?(and|\/|&)?.?term/.test(t)) return "ratetermrefi";
  if (/purchas|buy|acquir|under contract/.test(t)) return "purchase";
  return null;
}
function normalizeCitizenship(text: string): string | null {
  const t = text.toLowerCase();
  if (/foreign/.test(t)) return "Foreign National";
  if (/green.?card|permanent|resident/.test(t)) return "Permanent Resident";
  if (/visa|non.?perm/.test(t)) return "Non-Permanent Resident";
  if (/citizen|u\.?s\.?a?\b|american/.test(t)) return "US Citizen";
  return null;
}
function buildTranscript(activity: Array<Record<string, unknown>>): string {
  return (activity || [])
    .filter((a) => a.type === "text")
    .slice(-20)
    .map((a) => String(a.text || ""))
    .join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const leadId: string = body.leadId;
    if (!leadId) return new Response(JSON.stringify({ error: "missing_lead_id" }), { status: 400, headers: CORS_HEADERS });

    const { data: lead, error: leadErr } = await sb.from("leads").select("*").eq("id", leadId).single();
    if (leadErr || !lead) return new Response(JSON.stringify({ error: "lead_not_found" }), { status: 404, headers: CORS_HEADERS });
    if (!lead.ai_stage || lead.automation_paused) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: CORS_HEADERS });
    }

    const { data: lo } = await sb.from("users").select("id,name,phone,email").eq("id", lead.assigned_to).single();
    const loName = (lo && lo.name) || "your loan officer";
    const awaitingLanguage = lead.ai_stage === "awaiting_language";
    const lang = lead.preferred_language === "es" ? "Spanish" : lead.preferred_language === "vi" ? "Vietnamese" : "English";
    const transcript = buildTranscript(lead.activity as Array<Record<string, unknown>>);
    const { data: rateRows } = await sb.from("market_rates").select("key,current,previous");
    const rateNote = marketRateContext(lead.loan_type as string, rateRows || []);

    const knownFields = Object.keys(FIELD_MAP).filter((k) => lead[FIELD_MAP[k]] != null && lead[FIELD_MAP[k]] !== "");
    const missingFields = Object.keys(FIELD_MAP).filter((k) => !knownFields.includes(k));
    const needKeys = NEED_BY_TYPE[(lead.loan_type as string) || ""] || [];
    const stillNeeded = needKeys.filter((k) => !knownFields.includes(k));
    const nextAsk = stillNeeded.length ? ASK_FOR[stillNeeded[0]] : null;
    const pricingGuidance =
      "Also, your loan officer needs the deal details to price this loan, so while chatting, gather them naturally, one question at a time, never as a checklist. " +
      (needKeys.length
        ? (stillNeeded.length
            ? ("Still needed to price it: " + stillNeeded.map((k) => ASK_FOR[k]).join("; ") + ". When the conversation allows it, the next thing to ask about is " + nextAsk + " -- but if they asked you something, answer that first, and if they're ready for the application or a call, do that instead of interrogating them. ")
            : "You already have everything needed to price this loan; the loan officer is pulling their numbers together -- you can tell them that, and move toward the application or a call. ")
        : "") +
      "NEVER state, estimate or hint at a specific interest rate, points, fees, loan terms or approval odds for THEIR deal (general commentary like rates just dropped is fine, but no numbers for them). If they ask what the rate or price will be, say you are pulling their exact numbers together and " + loName + " will text them real numbers shortly. ";

    // Live-tunable guidance -- the AI Assistant's analyze_and_adjust_engagement
    // tool updates this based on real conversion data, no code deploy needed.
    const { data: engagementConfig } = await sb.from("engagement_config").select("messaging_guidance").eq("id", "default").single();
    const messagingGuidance = engagementConfig?.messaging_guidance
      ? ("Additional guidance learned from real conversion data across all conversations, follow this: " + engagementConfig.messaging_guidance + " ")
      : "";

    // What the team's own call notes have taught us about this person (scan-notes, Joe 2026-10-16) -- so the AI texts like someone who knows them.
    // Internal-only kinds (issues, mood, suggested file changes) are left out because this text goes to the borrower.
    const { data: insightRows } = await sb.from("lead_insights").select("kind,text").eq("lead_id", leadId).eq("active", true).in("kind", ["preference", "personal", "timeline", "commitment", "deal_fact"]).order("created_at", { ascending: false }).limit(10);
    const learnedNotes = (insightRows && insightRows.length)
      ? ("What our team already knows about them from earlier calls (use ONE naturally if it fits, follow any stated contact preference such as short messages or texts over calls, never recite a list and never say we keep notes): " + insightRows.map((r: { kind: string; text: string }) => r.text).join(" | ") + ". ")
      : "";
    const bookingLink = CLIENT_URL + "?book=" + lead.assigned_to + "&forLead=" + leadId;
    const hasLoanType = !!lead.loan_type;
    const alreadyApplied = !!lead.application_sent_at;
    const systemPrompt =
      "You are texting on behalf of " + loName + " at Bridgepoint Lending, a hard-money/DSCR real estate lender, with a prospective borrower named " + (lead.name || "the lead") + " who came in via " + (lead.source || "an ad") + " for a " + (lead.loan_type || "loan") + " inquiry. " +
      "Your goals, in priority order: (1) get them to agree to fill out our loan application -- this is the strongest outcome, don't settle for less if they seem willing; (2) if they're not ready for the full application yet, get them to book a specific time with " + loName + "; (3) at minimum, keep the conversation moving naturally and learn more about what they need. Keep every message short (1-3 sentences), casual real-texting style, never corporate or salesy. No more than one question per message -- this is a conversation, not an interrogation, so don't ask for everything at once. " +
      (alreadyApplied
        ? "The application was already sent to them earlier in this conversation -- don't offer to send it again, just help with whatever they're asking now."
        : (hasLoanType
            ? "Their loan type is already known: " + lead.loan_type + ". If they clearly agree to fill out an application (or ask for one), set readyForApplication true in your response and tell them in your reply that you're sending it now."
            : "Their loan type is NOT yet known. Before offering or sending an application, find out what type of financing they need (fix & flip, DSCR/rental, ground-up construction, etc.) -- never set readyForApplication true and never offer to send the application until you know this, since sending the wrong application type would confuse them.")) +
      " Once they seem ready to talk (or if the conversation has gone back and forth a couple times with no clear next step), send them this exact booking link so they can grab a real time slot themselves instead of a vague \"let's hop on a call\": " + bookingLink + " -- don't send it on literally the first message unless they ask to schedule directly. " +
      pricingGuidance +
      learnedNotes +
      messagingGuidance +
      (rateNote ? (rateNote + " ") : "") +
      (awaitingLanguage
        ? "Your last message already asked (in both languages) whether they prefer English or Spanish. Read their latest reply and figure out which they picked -- look for \"spanish\", \"espanol\", \"español\", or a close misspelling/typo of those => Spanish; otherwise assume English. Then write your NEXT message already in that language, moving the conversation forward (e.g. ask about the property or their timeline)."
        : "Continue the conversation in " + lang + ". Use the transcript below for context -- don't repeat questions already answered.") +
      " If their latest message clearly states any of these details, extract them: " + missingFields.join(", ") + (missingFields.length ? "" : " (none outstanding)") + ". For loanType, only use one of: DSCR, Fix & Flip, Bridge, Ground Up Construction, Portfolio/Blanket, Mixed-Use. Never guess or infer a field they didn't actually state. " +
      "Output ONLY a JSON object, no markdown fences, no commentary: " +
      '{"language": "en"|"es"|"vi"|null, "reply": "next text message", "readyForApplication": true|false, "extractedFields": {"fieldName": "value", ...only fields explicitly stated, from the outstanding list above}}';

    const userMessage = "Conversation so far (chronological):\n" + (transcript || "(no prior messages)");

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });

    // Claude's response can include a "thinking" block before the actual
    // "text" block -- never assume content[0] is the text.
    const textBlock = (aiData.content || []).find((c: Record<string, unknown>) => c.type === "text");
    const raw = (textBlock && textBlock.text) || "";
    let parsed: Record<string, unknown> = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (_e) {
      return new Response(JSON.stringify({ error: "parse_error", raw }), { status: 502, headers: CORS_HEADERS });
    }

    const updates: Record<string, unknown> = {};
    if (awaitingLanguage && (parsed.language === "es" || parsed.language === "en" || parsed.language === "vi")) {
      updates.preferred_language = parsed.language;
      updates.ai_stage = "engaging";
    }
    const extracted = (parsed.extractedFields && typeof parsed.extractedFields === "object") ? parsed.extractedFields as Record<string, unknown> : {};
    const filledNotes: string[] = [];
    for (const key of Object.keys(extracted)) {
      const col = FIELD_MAP[key];
      if (!col || knownFields.includes(key)) continue; // whitelist only, never overwrite
      const val = extracted[key];
      if (val == null || val === "") continue;
      if (key === "loanType") {
        const normalized = normalizeLoanType(String(val));
        if (!normalized || !KNOWN_LOAN_TYPES.includes(normalized)) continue; // never store an unrecognized loan type
        updates[col] = normalized;
      } else if (key === "transactionType") {
        const tt = normalizeTxn(String(val)); if (!tt) continue; updates[col] = tt;
      } else if (key === "citizenshipStatus") {
        const cs = normalizeCitizenship(String(val)); if (!cs) continue; updates[col] = cs;
      } else if (key === "experienceDeals") {
        const ed = Math.round(Number(String(val).replace(/[^0-9.]/g, ""))); if (!Number.isFinite(ed) || ed < 0 || ed > 500) continue; updates[col] = ed;
      } else if (NUMERIC_FIELDS.includes(key)) {
        const num = Number(String(val).replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(num) || num <= 0) continue;
        updates[col] = num;
      } else {
        updates[col] = String(val).slice(0, 200);
      }
      filledNotes.push(key + ": " + val);
    }

    const replyText = typeof parsed.reply === "string" ? parsed.reply.slice(0, 600) : null;
    const effectiveLoanType = (updates.loan_type as string) || (lead.loan_type as string) || null;
    const sendApplication = parsed.readyForApplication === true && !!effectiveLoanType && !lead.application_sent_at;
    if (sendApplication) {
      updates.application_sent_at = new Date().toISOString().slice(0, 10);
      updates.stage = "app_sent";
    }

    if (Object.keys(updates).length) {
      await sb.from("leads").update(updates).eq("id", leadId);
    }
    if (filledNotes.length || sendApplication) {
      const activity = (lead.activity as unknown[]) || [];
      if (filledNotes.length) {
        activity.push({
          date: new Date().toISOString().slice(0, 10), type: "system",
          text: "AI auto-filled from conversation — " + filledNotes.join("; "), author: "AI Assistant",
        });
      }
      if (sendApplication) {
        activity.push({
          date: new Date().toISOString().slice(0, 10), type: "application",
          text: "Application link sent to " + lead.name + " via AI conversation (confirmed " + effectiveLoanType + ")", author: "AI Assistant",
        });
      }
      await sb.from("leads").update({ activity }).eq("id", leadId);
    }
    if (sendApplication) {
      const link = applicationLink(leadId, lead.application_token as string);
      const appMsg = (lang === "Spanish"
        ? "Aquí tiene el enlace para completar su solicitud — toma unos 5 minutos: "
        : "Here's the link to complete your application — takes about 5 minutes: ") + link;
      if (lead.phone) {
        await fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ leadId, to: lead.phone, text: appMsg, fromName: loName, initiatedBy: "ai" }),
        }).catch(() => {});
      }
      if (lead.email) {
        await fetch(SUPABASE_URL + "/functions/v1/send-email", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ leadId, to: lead.email, subject: "Bridgepoint Lending — Your Application", text: appMsg, fromName: loName, fromAddress: (lo && lo.email) || null, initiatedBy: "ai" }),
        }).catch(() => {});
      }
    }

    let sendResult: Record<string, unknown> = { ok: false, error: "no_phone" };
    if (replyText && lead.phone) {
      const sendRes = await fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ leadId, to: lead.phone, text: replyText, fromName: loName, initiatedBy: "ai" }),
      });
      sendResult = await sendRes.json();
    }

    // Joe 2026-10-12: once the deal details are complete, price it privately and brief the loan officer (ai-price-lead).
    try {
      const merged: Record<string, unknown> = Object.assign({}, lead, updates);
      const need = NEED_BY_TYPE[(merged.loan_type as string) || ""] || [];
      if (need.length && need.every((k) => merged[FIELD_MAP[k]] != null && merged[FIELD_MAP[k]] !== "")) {
        const kick = fetch(SUPABASE_URL + "/functions/v1/ai-price-lead", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify({ leadId }),
        }).catch(() => null);
        try { (globalThis as any).EdgeRuntime.waitUntil(kick); } catch (_e) { await kick; }
      }
    } catch (_e) { /* pricing is best-effort and never blocks the reply */ }

    return new Response(JSON.stringify({ ok: true, reply: replyText, extracted: filledNotes, sendResult }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
