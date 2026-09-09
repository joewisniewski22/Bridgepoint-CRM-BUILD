// GoHighLevel -> CRM, for Connected Investors leads specifically. Same
// mechanism as highlevel-leads-webhook (HighLevel's "Webhook" workflow
// action just needs a URL) but a SEPARATE endpoint/token since this is a
// different source with different routing and no forced language --
// keeping them separate means changing one workflow's behavior can never
// accidentally affect the other.
//
// Field names aren't guaranteed stable here either -- tries the same
// stable HighLevel custom-field names first (in case this HighLevel
// sub-account reuses the same custom fields across forms, which is
// common), then a keyword-based fallback across whatever keys are
// actually present. Nothing gets a raw-JSON dump into activity -- see
// highlevel-leads-webhook for why.
//
// Routing: Joe's original rule (2026-09-04, never built until now) --
// Connected Investors / PrivateLenders.com leads split 50/50 between Joe
// (owner) and Fiore. No preferred_language is forced (unlike the Spanish
// Facebook workflow) -- defaults to English.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("CONNECTED_INVESTORS_WEBHOOK_TOKEN")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function quoDialLink(leadPhone: string, fromNumber?: string | null): string {
  const digits = (leadPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  const e164 = digits.length === 10 ? ("+1" + digits) : ("+" + digits);
  let url = "openphone://dial?number=" + encodeURIComponent(e164) + "&action=call";
  if (fromNumber) url += "&from=" + encodeURIComponent(fromNumber);
  return url;
}

// True alternating 50/50 (not random-averaging-to-50/50) -- Joe was
// explicit: strict split, starting with him on the very first lead
// tonight. Used to infer "who's next" by querying the most recent lead
// this webhook created and flipping from there -- broke under a real,
// confirmed race: HighLevel fires this webhook twice in quick succession
// for the same contact sometimes (a workflow re-trigger quirk), and both
// requests could read the same "last" lead before either insert
// committed, landing both on the same assignee instead of alternating.
// A single-row atomic UPDATE...RETURNING (ci_routing_state /
// next_ci_assignee(), 063_ci_routing_atomic.sql) is serialized by
// Postgres's own row lock, so concurrent requests can't race anymore.
async function pickCIOwnerOrFiore(): Promise<string> {
  const { data, error } = await sb.rpc("next_ci_assignee");
  if (error || !data) return "owner";
  return data as string;
}

function firstOf(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}
function findByKeyword(obj: Record<string, unknown>, keywords: string[]): string | null {
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (keywords.some((k) => lower.includes(k))) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}
function toNumber(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}
function rangeMidpoint(s: string | null): number | null {
  if (!s) return null;
  const nums = (s.match(/[\d,]+/g) || []).map((x) => Number(x.replace(/,/g, "")));
  if (!nums.length) return null;
  if (nums.length === 1) return nums[0];
  return Math.round((nums[0] + nums[1]) / 2);
}
function normalizeLoanType(text: string | null): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("fix") && t.includes("flip")) return "Fix & Flip";
  if (t.includes("dscr") || t.includes("rental")) return "DSCR";
  if (t.includes("bridge")) return "Bridge";
  if (t.includes("ground up") || t.includes("construction")) return "Ground Up Construction";
  if (t.includes("portfolio") || t.includes("blanket")) return "Portfolio/Blanket";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  if (url.searchParams.get("token") !== WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();

    const firstName = firstOf(body, "first_name", "firstName");
    const lastName = firstOf(body, "last_name", "lastName");
    const fullName = firstOf(body, "full_name", "fullName", "name", "contact_name") ||
      [firstName, lastName].filter(Boolean).join(" ") || "Connected Investors Lead";
    const email = firstOf(body, "email", "email_address");
    const phone = firstOf(body, "phone", "phone_number", "phoneNumber");
    const assignedTo = await pickCIOwnerOrFiore();

    // --- Structured field extraction (stable names first, then keyword fallback) ---
    // "Stable names" now includes PrivateLenders.com's actual snake_case
    // custom-field IDs (per their API Field Mapping doc, 2026-09-09) --
    // the keyword fallback below only catches space-separated phrasing
    // ("credit score"), which never matches their machine field names
    // ("credit_score"), so without these explicit entries this webhook
    // would silently capture name/email/phone from them and drop every
    // deal detail (loan amount, credit score, experience, etc.).
    const propertyAddress = firstOf(body, "Property Address") || findByKeyword(body, ["property address"]);
    const propertyType = firstOf(body, "Property Type", "type_of_deal") || findByKeyword(body, ["property type"]);
    const purchasePrice = toNumber(firstOf(body, "Purchase Price / Est. Value") || findByKeyword(body, ["purchase price", "estimated value", "est. value"]));
    let loanAmount = toNumber(firstOf(body, "Requested Loan Amount", "Requested Amount", "requested_amount") || findByKeyword(body, ["loan amount", "amount needed", "amount requested"]));
    let creditScore = toNumber(firstOf(body, "Estimated FICO Score", "Credit Score", "credit_score") || findByKeyword(body, ["credit score", "fico"]));
    let experienceDeals: number | null = toNumber(firstOf(body, "Experience", "deals_done") || findByKeyword(body, ["experience", "deals completed", "properties flipped"]));
    if (loanAmount == null) loanAmount = rangeMidpoint(findByKeyword(body, ["loan amount", "amount needed"]));
    if (creditScore == null) creditScore = rangeMidpoint(findByKeyword(body, ["credit score", "fico"]));
    if (experienceDeals != null && /primero|first|none|0/i.test(String(experienceDeals))) experienceDeals = 0;

    let loanType = normalizeLoanType(firstOf(body, "Loan Type Needed") || findByKeyword(body, ["loan type", "loan program"]));
    if (!loanType) {
      const attribution = (body as Record<string, any>).contact?.attributionSource || (body as Record<string, any>).attributionSource || {};
      loanType = normalizeLoanType(JSON.stringify(attribution));
    }

    // Qualifying answers with no dedicated CRM column -- one readable note.
    const qualifyingNotes: string[] = [];
    const holdingPeriod = firstOf(body, "Holding Period", "holding_period") || findByKeyword(body, ["holding period"]);
    if (holdingPeriod) qualifyingNotes.push("Holding period: " + holdingPeriod);
    const buyVsRefi = firstOf(body, "Buy VS Refi", "buy_vs_refi") || findByKeyword(body, ["buy vs refi", "purchase or refinance"]);
    if (buyVsRefi) qualifyingNotes.push("Buy vs. Refi: " + buyVsRefi);
    const additionalDetails = firstOf(body, "Additional Project Details", "special_and_terms") || findByKeyword(body, ["additional details", "project details", "message", "comments"]);
    if (additionalDetails) qualifyingNotes.push("Additional details: " + additionalDetails);
    const referralSource = firstOf(body, "referral_source");
    if (referralSource) qualifyingNotes.push("Referral source: " + referralSource);
    const externalLeadId = firstOf(body, "lead_id");
    if (externalLeadId) qualifyingNotes.push("PrivateLenders lead ID: " + externalLeadId);

    const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const activity: Record<string, string>[] = [
      { date: today, type: "note", text: "Lead captured from GoHighLevel via webhook (Connected Investors) — auto-routed to " + assignedTo, author: "System" },
    ];
    if (qualifyingNotes.length) {
      activity.push({ date: today, type: "note", text: "Form answers — " + qualifyingNotes.join(" · "), author: "System" });
    }

    const row = {
      id, name: fullName, email: email || null, phone: phone || null,
      source: "Connected Investors", loan_type: loanType, stage: "new", status: "active",
      assigned_to: assignedTo, created_at: today, created_at_ts: new Date().toISOString(),
      property_address: propertyAddress || null, property_type: propertyType || null,
      purchase_price: purchasePrice, loan_amount: loanAmount,
      credit_score: creditScore, experience_deals: experienceDeals,
      // Enrolls in the same AI conversion-texting automation every other
      // source uses -- English, no language handshake needed since neither
      // owner nor Fiore is flagged bilingual.
      ai_stage: "engaging",
      entity_type: "LLC", application_token: crypto.randomUUID(),
      activity,
    };

    const { error } = await sb.from("leads").insert(row);
    if (error) {
      console.error("connected-investors-webhook: insert failed", error.message);
      return new Response(JSON.stringify({ error: "insert_failed", detail: error.message }), { status: 500, headers: CORS_HEADERS });
    }

    const link = CRM_URL + "?lead=" + id;
    const alertText = "🔥 New Connected Investors lead: " + fullName + " — open & dial: " + link;
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: assignedTo, lead_id: id,
      kind: "hot-lead", text: alertText, date: today, read: false,
    });
    const { data: assignee } = await sb.from("users").select("id,name,email,phone,quo_phone_number,photo_url").eq("id", assignedTo).single();
    if (assignee?.phone) {
      const dialLink = phone ? quoDialLink(phone, assignee.quo_phone_number) : "";
      fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: assignee.phone, text: alertText + (dialLink ? ("\nCall now: " + dialLink) : ""), fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    if (assignee?.email) {
      fetch(SUPABASE_URL + "/functions/v1/send-email", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: assignee.email, subject: "New lead: " + fullName, text: alertText, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }

    // --- AI first-contact message to the borrower, in English --------------
    if ((email || phone) && assignee) {
      try {
        const bookingLink = CRM_URL + "?book=" + assignedTo;
        const known: string[] = [];
        if (loanType) known.push("Loan type: " + loanType);
        if (loanAmount) known.push("Requested amount: approx. $" + loanAmount.toLocaleString());
        if (creditScore) known.push("Credit score: approx. " + creditScore);
        if (propertyAddress) known.push("Property: " + propertyAddress);
        if (experienceDeals != null) known.push("Investing experience: " + experienceDeals + " deal(s)");
        const missing: string[] = [];
        if (!propertyAddress) missing.push("the property address (if they have one yet)");
        if (!loanAmount) missing.push("the exact loan amount they're looking for");
        if (!creditScore) missing.push("their approximate credit score");

        const prompt = "You are " + assignee.name + " at Bridgepoint Lending (business-purpose loans for investment real estate, not owner-occupied). " +
          "A prospective borrower just came in from Connected Investors. Write a short first message (max 4-5 sentences, works as SMS or email), warm and professional, in ENGLISH. " +
          "Thank them for their interest, briefly confirm what's already known, ask for at most 1-2 important missing details, and invite them to grab a quick call time here: " + bookingLink + ". " +
          "Never invent a detail that wasn't given. No legal jargon or approval promises.\n\n" +
          "Client: " + fullName + "\n" +
          (known.length ? ("Already known:\n- " + known.join("\n- ") + "\n") : "") +
          (missing.length ? ("Missing, ask for at most 2:\n- " + missing.join("\n- ") + "\n") : "") +
          "\nReply with ONLY the message text, no quotes or explanation.";

        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
        });
        const aiData = await aiRes.json();
        const message: string | null = aiRes.ok ? (aiData.content?.[0]?.text || "").trim() : null;

        if (message) {
          const sendCalls: Promise<unknown>[] = [];
          if (email) {
            sendCalls.push(fetch(SUPABASE_URL + "/functions/v1/send-email", {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
              body: JSON.stringify({
                leadId: id, to: email, subject: "Bridgepoint Lending — Your Loan Inquiry",
                text: message, fromName: assignee.name, fromAddress: assignee.email, fromUserId: assignee.id, fromPhotoUrl: assignee.photo_url || null, initiatedBy: "ai",
              }),
            }).catch(() => {}));
          }
          if (phone) {
            sendCalls.push(fetch(SUPABASE_URL + "/functions/v1/send-text", {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
              body: JSON.stringify({ leadId: id, to: phone, text: message, fromName: assignee.name, fromNumber: assignee.quo_phone_number || null, initiatedBy: "ai" }),
            }).catch(() => {}));
          }
          await Promise.all(sendCalls);
        }
      } catch (aiErr) {
        console.error("connected-investors-webhook: AI first-contact failed", String(aiErr));
      }
    }

    return new Response(JSON.stringify({ ok: true, leadId: id }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
