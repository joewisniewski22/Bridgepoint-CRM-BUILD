// Called by receive-text whenever a lead enrolled in the conversion-texting
// automation (lead.ai_stage set, automation_paused false) sends a reply.
// Runs one Claude call to (a) resolve English/Spanish on the first reply if
// the assigned LO is bilingual, (b) draft the next conversion-focused text,
// and (c) pull out any clearly-stated loan details to auto-fill -- never
// overwriting a field that's already set. Sends the reply itself via
// send-text. Stops entirely once automation_paused is set (the LO's own
// "Stop Automation" button) -- checked by the caller before invoking this.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-5";

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
  propertyAddress: "property_address",
  purchasePrice: "purchase_price",
  loanAmount: "loan_amount",
  creditScore: "credit_score",
  propertyType: "property_type",
  exitStrategy: "exit_strategy",
};

const RATE_KEY_BY_LOAN_TYPE: Record<string, string> = {
  "DSCR": "dscr", "Fix & Flip": "fixFlip", "Ground Up Construction": "groundUp",
  "Portfolio/Blanket": "portfolio", "Bridge": "bridge", "Mixed-Use": "mixedUse",
};

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

    const { data: lo } = await sb.from("users").select("id,name,phone,email,quo_phone_number").eq("id", lead.assigned_to).single();
    const loName = (lo && lo.name) || "your loan officer";
    const awaitingLanguage = lead.ai_stage === "awaiting_language";
    const lang = lead.preferred_language === "es" ? "Spanish" : "English";
    const transcript = buildTranscript(lead.activity as Array<Record<string, unknown>>);
    const { data: rateRows } = await sb.from("market_rates").select("key,current,previous");
    const rateNote = marketRateContext(lead.loan_type as string, rateRows || []);

    const knownFields = Object.keys(FIELD_MAP).filter((k) => lead[FIELD_MAP[k]] != null && lead[FIELD_MAP[k]] !== "");
    const missingFields = Object.keys(FIELD_MAP).filter((k) => !knownFields.includes(k));

    const systemPrompt =
      "You are texting on behalf of " + loName + " at Bridgepoint Lending, a hard-money/DSCR real estate lender, with a prospective borrower named " + (lead.name || "the lead") + " who came in via " + (lead.source || "an ad") + " for a " + (lead.loan_type || "loan") + " inquiry. " +
      "Your single goal is CONVERSION: get them to complete our loan application or agree to a call with " + loName + ". Keep every message short (1-3 sentences), casual real-texting style, never corporate or salesy. No more than one question per message. " +
      (rateNote ? (rateNote + " ") : "") +
      (awaitingLanguage
        ? "Your last message already asked (in both languages) whether they prefer English or Spanish. Read their latest reply and figure out which they picked -- look for \"spanish\", \"espanol\", \"español\", or a close misspelling/typo of those => Spanish; otherwise assume English. Then write your NEXT message already in that language, moving the conversation forward (e.g. ask about the property or their timeline)."
        : "Continue the conversation in " + lang + ". Use the transcript below for context -- don't repeat questions already answered.") +
      " If their latest message clearly states any of these details, extract them: " + missingFields.join(", ") + (missingFields.length ? "" : " (none outstanding)") + ". Never guess or infer a field they didn't actually state. " +
      "Output ONLY a JSON object, no markdown fences, no commentary: " +
      '{"language": "en"|"es"|null, "reply": "next text message", "extractedFields": {"fieldName": "value", ...only fields explicitly stated, from the outstanding list above}}';

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
    if (awaitingLanguage && (parsed.language === "es" || parsed.language === "en")) {
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
      if ((key === "purchasePrice" || key === "loanAmount" || key === "creditScore")) {
        const num = Number(String(val).replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(num) || num <= 0) continue;
        updates[col] = num;
      } else {
        updates[col] = String(val).slice(0, 200);
      }
      filledNotes.push(key + ": " + val);
    }

    const replyText = typeof parsed.reply === "string" ? parsed.reply.slice(0, 600) : null;

    if (Object.keys(updates).length) {
      await sb.from("leads").update(updates).eq("id", leadId);
    }
    if (filledNotes.length) {
      const activity = (lead.activity as unknown[]) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10), type: "system",
        text: "AI auto-filled from conversation — " + filledNotes.join("; "), author: "AI Assistant",
      });
      await sb.from("leads").update({ activity }).eq("id", leadId);
    }

    let sendResult: Record<string, unknown> = { ok: false, error: "no_phone" };
    if (replyText && lead.phone) {
      const sendRes = await fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ leadId, to: lead.phone, text: replyText, fromName: loName, fromNumber: (lo && lo.quo_phone_number) || null }),
      });
      sendResult = await sendRes.json();
    }

    return new Response(JSON.stringify({ ok: true, reply: replyText, extracted: filledNotes, sendResult }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
