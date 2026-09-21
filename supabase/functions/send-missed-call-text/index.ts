// "Sorry I missed you" follow-up text -- Joe's ask (2026-09-21): whenever a
// loan officer marks a call No Answer or Voicemail, text that person under
// the LO's own name. Also used by voice-webhook for the automatic text on a
// real no-answer. Sent from the one company number via Telnyx.
//
// This function only SENDS and reports back -- it never writes to the lead's
// activity, because the CRM client keeps its own copy of each lead and a
// server-side write could be overwritten by its next sync. The caller records
// the returned message (with kind "missed-call-text" and `at`) on the lead,
// which is also what the 12-hour de-dupe below looks for.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const COMPANY_PHONE_DISPLAY = "(850) 279-8588";
const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function toE164(raw: string): string {
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return raw;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const leadId: string = body.leadId;
    const staffId: string = body.staffId;
    if (!leadId || !staffId) return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: lead } = await sb.from("leads").select("id, name, phone, loan_type, status, activity").eq("id", leadId).single();
    if (!lead || !lead.phone) return new Response(JSON.stringify({ ok: true, sent: false, reason: "no_phone" }), { headers: CORS_HEADERS });
    if (lead.status === "closed" || lead.status === "spam") return new Response(JSON.stringify({ ok: true, sent: false, reason: "status_" + lead.status }), { headers: CORS_HEADERS });

    const activity = (Array.isArray(lead.activity) ? lead.activity : []) as Array<Record<string, unknown>>;
    if (activity.some((a) => typeof a.text === "string" && /TCPA opt-out/i.test(a.text))) {
      return new Response(JSON.stringify({ ok: true, sent: false, reason: "opted_out" }), { headers: CORS_HEADERS });
    }
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    if (activity.some((a) => a.kind === "missed-call-text" && typeof a.at === "string" && new Date(a.at as string).getTime() > cutoff)) {
      return new Response(JSON.stringify({ ok: true, sent: false, reason: "recently_sent" }), { headers: CORS_HEADERS });
    }

    const { data: staff } = await sb.from("users").select("id, name, speaks_spanish").eq("id", staffId).single();
    if (!staff) return new Response(JSON.stringify({ error: "unknown_staff" }), { status: 400, headers: CORS_HEADERS });

    const first = ((lead.name as string) || "").trim().split(" ")[0] || "there";
    const loName = ((staff.name as string) || "your loan officer").trim();
    const loanType = lead.loan_type ? (lead.loan_type as string) + " loan" : "loan";
    const book = CRM_URL + "?book=" + staffId;

    let message =
      "Hey " + first + ", it's " + loName + " with Bridgepoint Lending following up on your " + loanType + " inquiry — sorry I missed you! " +
      "Call or text me back anytime at " + COMPANY_PHONE_DISPLAY + ", or grab a time that works for you: " + book + " (Reply STOP to opt out)";
    // Bilingual loan officers send both, same as the first-contact AI text.
    if (staff.speaks_spanish) {
      message += "\n\nHola " + first + ", soy " + loName + " de Bridgepoint Lending, dándole seguimiento a su consulta de préstamo — ¡disculpe que no pude atenderle! " +
        "Llámeme o envíeme un mensaje al " + COMPANY_PHONE_DISPLAY + ", o elija un horario aquí: " + book + " (Responda STOP para cancelar)";
    }

    if (body.dryRun) return new Response(JSON.stringify({ ok: true, sent: false, dryRun: true, message }), { headers: CORS_HEADERS });

    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TELNYX_API_KEY },
      body: JSON.stringify({ from: TELNYX_FROM_NUMBER, to: toE164(lead.phone as string), text: message, messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "telnyx_error", detail: data }), { status: 502, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ ok: true, sent: true, message, at: new Date().toISOString(), staffName: loName }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
