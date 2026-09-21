// Sends an outbound SMS through Telnyx from the single company number and
// logs it to the CRM. Called from the CRM frontend with the Supabase
// publishable (anon) key. Replaced Quo on 2026-09-21 once the 10DLC campaign
// cleared -- one company number for everyone, so fromNumber is no longer
// accepted. Telnyx only queues the message here; a carrier rejection shows up
// later as a message.finalized webhook, which receive-text logs to the lead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID")!;
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

    if (!to || !text) {
      return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });
    }

    const telnyxRes = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TELNYX_API_KEY },
      body: JSON.stringify({
        from: TELNYX_FROM_NUMBER,
        to: toE164(to),
        text,
        messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
      }),
    });
    const telnyxData = await telnyxRes.json().catch(() => null);
    if (!telnyxRes.ok) {
      return new Response(JSON.stringify({ error: "telnyx_error", detail: telnyxData }), { status: 502, headers: CORS_HEADERS });
    }

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
      });
      await sb.from("leads").update({ activity: activity }).eq("id", leadId);
    }

    return new Response(JSON.stringify({ ok: true, messageId: (telnyxData && telnyxData.data && telnyxData.data.id) || null }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
