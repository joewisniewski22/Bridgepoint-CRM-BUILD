// GoHighLevel -> CRM. HighLevel's own "Webhook" workflow action can POST a
// contact's data straight here the moment a lead comes in from whatever
// form/source is configured in HighLevel -- no OAuth, no developer app,
// just a URL.
//
// Field names are NOT stable across HighLevel forms -- some campaigns
// populate the standardized English custom fields (Property Address,
// Purchase Price / Est. Value, Requested Loan Amount, etc.), others only
// populate the literal Facebook ad question text as the JSON key (e.g. a
// Spanish-language form's actual question becomes the key, with the
// standardized fields left blank). This parses both: stable field names
// first, then a keyword-based fallback search across whatever keys are
// actually present, so this doesn't break the moment a campaign's exact
// question wording changes. Nothing gets a raw-JSON dump into the lead's
// activity log anymore -- Joe was explicit that the system should turn
// this into real, structured lead fields, not a wall of text a human has
// to re-read and re-type.
//
// Routing: this specific webhook is wired to Joe's Spanish-language
// Facebook ad workflow in HighLevel only (confirmed 2026-09-04) -- every
// lead through this endpoint gets weighted-random routed 70% to Fanis,
// 30% to David, per Joe's explicit instruction. If this same webhook
// endpoint ever gets reused for a different, non-Spanish-ad HighLevel
// source, this routing (and the hardcoded Spanish first-contact message
// below) needs to be revisited, not assumed to still apply.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("HIGHLEVEL_WEBHOOK_TOKEN")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// Weighted-random 70/30 split (Fanis/David) -- probabilistic per Joe's own
// phrasing ("70% to Fanis, 30% to David"), not a strict rotating quota.
function pickSpanishAdLO(): string {
  return Math.random() < 0.7 ? "lo-fanis" : "lo-david";
}

function firstOf(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}
// Fallback for forms that only populate the literal ad question as the
// JSON key -- searches every key for a keyword rather than an exact
// question string, so a reworded question still matches.
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
// "$100,000 - $500,000" or "760 - 799" -> a single representative number.
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
  if (t.includes("dscr")) return "DSCR";
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
  const token = url.searchParams.get("token");
  if (token !== WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();

    const firstName = firstOf(body, "first_name", "firstName");
    const lastName = firstOf(body, "last_name", "lastName");
    const fullName = firstOf(body, "full_name", "fullName", "name", "contact_name") ||
      [firstName, lastName].filter(Boolean).join(" ") || "HighLevel Lead";
    const email = firstOf(body, "email", "email_address");
    const phone = firstOf(body, "phone", "phone_number", "phoneNumber");
    const sourceTag = firstOf(body, "source", "lead_source", "contact_source") || "Meta Ads";
    const assignedTo = pickSpanishAdLO();

    // --- Structured field extraction -------------------------------------
    const propertyAddress = firstOf(body, "Property Address");
    const propertyType = firstOf(body, "Property Type");
    const purchasePrice = toNumber(firstOf(body, "Purchase Price / Est. Value"));
    let loanAmount = toNumber(firstOf(body, "Requested Loan Amount", "Requested Amount"));
    let creditScore = toNumber(firstOf(body, "Estimated FICO Score", "Credit Score"));
    let experienceDeals: number | null = toNumber(firstOf(body, "Experience"));

    if (loanAmount == null) {
      loanAmount = rangeMidpoint(findByKeyword(body, ["cantidad de dinero", "loan amount", "monto del préstamo", "monto del prestamo"]));
    }
    if (creditScore == null) {
      creditScore = rangeMidpoint(findByKeyword(body, ["crédito", "credito", "credit score", "puntaje"]));
    }
    if (experienceDeals == null) {
      const raw = findByKeyword(body, ["fix & flip", "fix and flip", "proyectos"]);
      if (raw) experienceDeals = /primero|first/i.test(raw) ? 0 : toNumber(raw);
    }

    let loanType = normalizeLoanType(firstOf(body, "Loan Type Needed"));
    if (!loanType) {
      const attribution = (body as Record<string, any>).contact?.attributionSource || (body as Record<string, any>).attributionSource || {};
      loanType = normalizeLoanType(JSON.stringify(attribution));
    }

    // Qualifying answers that don't map to a dedicated CRM column -- kept
    // as one short readable note instead of the old raw-JSON dump.
    const qualifyingNotes: string[] = [];
    const needs60 = findByKeyword(body, ["próximos 60", "proximos 60", "next 60 days"]);
    if (needs60) qualifyingNotes.push("Needs financing within 60 days: " + needs60);
    const capital = findByKeyword(body, ["acceso a capital", "access to capital"]);
    if (capital) qualifyingNotes.push("Has capital for down payment + closing: " + capital);
    const holdingPeriod = firstOf(body, "Holding Period");
    if (holdingPeriod) qualifyingNotes.push("Holding period: " + holdingPeriod);
    const buyVsRefi = firstOf(body, "Buy VS Refi");
    if (buyVsRefi) qualifyingNotes.push("Buy vs. Refi: " + buyVsRefi);
    const voiceAiReason = firstOf(body, "Voice AI Reason for Call");
    if (voiceAiReason) qualifyingNotes.push("Reason for call: " + voiceAiReason);
    const additionalDetails = firstOf(body, "Additional Project Details");
    if (additionalDetails) qualifyingNotes.push("Additional details: " + additionalDetails);

    const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const activity: Record<string, string>[] = [
      { date: today, type: "note", text: "Lead captured from GoHighLevel via webhook (Spanish Facebook ad) — auto-routed to " + assignedTo, author: "System" },
    ];
    if (qualifyingNotes.length) {
      activity.push({ date: today, type: "note", text: "Facebook form answers — " + qualifyingNotes.join(" · "), author: "System" });
    }

    const row = {
      id, name: fullName, email: email || null, phone: phone || null,
      source: sourceTag, loan_type: loanType, stage: "new", status: "active",
      assigned_to: assignedTo, created_at: today,
      property_address: propertyAddress || null, property_type: propertyType || null,
      purchase_price: purchasePrice, loan_amount: loanAmount,
      credit_score: creditScore, experience_deals: experienceDeals,
      // This webhook is wired to Joe's Spanish-language Facebook ad workflow
      // only (see routing comment above) -- every message the CRM's own
      // templates build for this lead (outreach texts, term sheet,
      // pre-approval, portal invite) branches on this flag, so tagging it
      // here is what actually makes first contact and everything after go
      // out in Spanish instead of silently defaulting to English.
      preferred_language: "es",
      // Enrolls this lead directly in the existing ai-lead-engage automation
      // (same system startAiEngagement() enrolls client-created leads into --
      // see index.html). Skipping the "awaiting_language" handshake that
      // system normally does first, since a Spanish-ad lead routed to a
      // bilingual LO is already a known quantity -- go straight to
      // "engaging" so receive-text hands off every reply to the AI
      // conversion automation from the very first message onward.
      ai_stage: "engaging",
      entity_type: "LLC", application_token: crypto.randomUUID(),
      activity,
    };

    const { error } = await sb.from("leads").insert(row);
    if (error) {
      console.error("highlevel-leads-webhook: insert failed", error.message);
      return new Response(JSON.stringify({ error: "insert_failed", detail: error.message }), { status: 500, headers: CORS_HEADERS });
    }

    const link = CRM_URL + "?lead=" + id;
    const alertText = "🔥 New Facebook lead (Spanish ad): " + fullName + " — open & dial: " + link;
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: assignedTo, lead_id: id,
      kind: "hot-lead", text: alertText, date: today, read: false,
    });
    const { data: assignee } = await sb.from("users").select("id,name,email,phone,quo_phone_number,photo_url").eq("id", assignedTo).single();
    if (assignee?.phone) {
      fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: assignee.phone, text: alertText, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    if (assignee?.email) {
      fetch(SUPABASE_URL + "/functions/v1/send-email", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: assignee.email, subject: "New lead: " + fullName, text: alertText, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }

    // --- AI first-contact message to the borrower, in Spanish -------------
    // Joe asked for the AI to start engaging the client directly: thank
    // them, confirm what we already know from the ad form, ask for
    // anything important still missing, and push toward booking a call
    // with their assigned LO -- sent immediately, before any human has
    // necessarily looked at the lead yet.
    if ((email || phone) && assignee) {
      try {
        const bookingLink = CRM_URL + "?book=" + assignedTo;
        const known: string[] = [];
        if (loanType) known.push("Tipo de préstamo: " + loanType);
        if (loanAmount) known.push("Monto solicitado: aprox. $" + loanAmount.toLocaleString());
        if (creditScore) known.push("Puntaje de crédito: aprox. " + creditScore);
        if (propertyAddress) known.push("Propiedad: " + propertyAddress);
        if (experienceDeals != null) known.push("Experiencia en Fix & Flip: " + experienceDeals + " proyecto(s)");
        const missing: string[] = [];
        if (!propertyAddress) missing.push("la dirección de la propiedad (si ya la tiene)");
        if (!loanAmount) missing.push("el monto exacto de préstamo que busca");
        if (!creditScore) missing.push("su puntaje de crédito aproximado");

        const prompt = "Eres " + assignee.name + ", oficial de préstamos de Bridgepoint Lending (préstamos de negocio para bienes raíces de inversión, no residenciales). " +
          "Un cliente potencial de un anuncio de Facebook en español acaba de enviar este formulario. Escríbele un primer mensaje corto (máximo 4-5 oraciones, apto para SMS o email), cálido y profesional, en ESPAÑOL. " +
          "Agradécele su interés, confirma brevemente lo que ya sabemos, pide como máximo 1-2 datos importantes que falten, e invítalo a agendar una llamada rápida con este enlace: " + bookingLink + ". " +
          "No inventes datos que no se te dieron. No uses jerga legal ni promesas de aprobación.\n\n" +
          "Cliente: " + fullName + "\n" +
          (known.length ? ("Datos ya conocidos:\n- " + known.join("\n- ") + "\n") : "") +
          (missing.length ? ("Datos que faltan, pide como máximo 2:\n- " + missing.join("\n- ") + "\n") : "") +
          "\nResponde con SOLO el texto del mensaje, sin comillas ni explicación.";

        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const aiData = await aiRes.json();
        const message: string | null = aiRes.ok ? (aiData.content?.[0]?.text || "").trim() : null;

        if (message) {
          const sendCalls: Promise<unknown>[] = [];
          if (email) {
            sendCalls.push(fetch(SUPABASE_URL + "/functions/v1/send-email", {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
              body: JSON.stringify({
                leadId: id, to: email, subject: "Bridgepoint Lending — Su solicitud de préstamo",
                text: message, fromName: assignee.name, fromAddress: assignee.email, fromUserId: assignee.id, fromPhotoUrl: assignee.photo_url || null,
              }),
            }).catch(() => {}));
          }
          if (phone) {
            sendCalls.push(fetch(SUPABASE_URL + "/functions/v1/send-text", {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
              body: JSON.stringify({ leadId: id, to: phone, text: message, fromName: assignee.name, fromNumber: assignee.quo_phone_number || null }),
            }).catch(() => {}));
          }
          await Promise.all(sendCalls);
          // send-text/send-email each log their own activity entry (type
          // "text"/"email") -- that's also what feeds ai-lead-engage's
          // transcript for every reply from here on, so nothing extra to
          // record here.
        }
      } catch (aiErr) {
        console.error("highlevel-leads-webhook: AI first-contact failed", String(aiErr));
        // Never fail the whole lead intake over the AI outreach step.
      }
    }

    return new Response(JSON.stringify({ ok: true, leadId: id }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
