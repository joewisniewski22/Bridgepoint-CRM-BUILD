// Sends an outbound SMS through Telnyx and logs it to the CRM.
// Called from the CRM frontend with the Supabase publishable (anon) key.
//
// Replaces the old Quo-based version (2026-09-14) -- Quo's API always
// returned ok:true but a confirmed batch of test sends never arrived
// (most likely A2P 10DLC carrier filtering on an unregistered line).
// Telnyx requires the same A2P 10DLC registration as any US SMS
// provider, but unlike Quo it gives real per-message delivery status via
// the message.finalized webhook (see telnyx-webhook), so a silent
// failure like that is now something we can actually detect.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER") || "";
const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function toE164(raw: string): string {
  if (!raw) return raw;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return raw; // let Telnyx reject it with a clear error rather than silently mis-format
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const leadId: string | null = body.leadId || null;
    const to: string = body.to;
    const text: string = body.text;
    const fromName: string | null = body.fromName || null;
    // Who actually caused this send -- "staff" (default) for every real
    // button-click in the CRM, "ai" only when the AI engagement/campaign
    // functions pass it explicitly. AI-sent texts still go out under the
    // LO's own name (fromName) so they read naturally to the borrower,
    // which means that field alone can't tell a real human contact
    // attempt apart from an automated one -- this can. Lets speed-to-lead
    // reporting count only genuine LO actions, not AI activity.
    const initiatedBy: string = body.initiatedBy === "ai" ? "ai" : "staff";
    // Per-LO number (fromNumber, still sourced from each Team member's
    // quoPhoneNumber field in the CRM -- kept as-is to avoid a schema/UI
    // rename) falls back to the shared, properly-registered Telnyx line
    // when not set. Most teams should just use the shared line until/
    // unless individual 10DLC-registered numbers are worth the overhead.
    const fromNumber = toE164(body.fromNumber || TELNYX_FROM_NUMBER);
    const toNumber = toE164(to);

    if (!to || !text) {
      return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });
    }
    if (!fromNumber) {
      return new Response(JSON.stringify({ error: "no_from_number", detail: "No Telnyx number to send from -- set the TELNYX_FROM_NUMBER secret for the shared office line." }), { status: 500, headers: CORS_HEADERS });
    }

    const telnyxRes = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TELNYX_API_KEY,
      },
      body: JSON.stringify({
        from: fromNumber,
        to: toNumber,
        text: text,
        ...(TELNYX_MESSAGING_PROFILE_ID ? { messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID } : {}),
      }),
    });
    const telnyxData = await telnyxRes.json();
    if (!telnyxRes.ok) {
      return new Response(JSON.stringify({ error: "telnyx_error", detail: telnyxData }), { status: 502, headers: CORS_HEADERS });
    }
    const messageId: string | null = (telnyxData.data && telnyxData.data.id) || null;

    if (leadId) {
      const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const { data: leadRow } = await sb.from("leads").select("activity").eq("id", leadId).single();
      const activity = (leadRow && leadRow.activity) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10),
        type: "text",
        text: "Texted (via Telnyx): " + text,
        author: fromName || "System",
        initiatedBy,
        telnyxMessageId: messageId,
        deliveryStatus: "sent",
      });
      await sb.from("leads").update({ activity: activity }).eq("id", leadId);
    }

    return new Response(JSON.stringify({ ok: true, messageId }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
