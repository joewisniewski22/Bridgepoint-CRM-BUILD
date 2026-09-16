// Staff-initiated click-to-call for the power dialer AND the standalone
// quick-dial (Joe's ask, 2026-09-16: a phone icon anywhere in the CRM to
// dial any number or a searched lead, outside the Power Dialer's queue
// flow). Rings the staff member's own personal cell first; voice-webhook
// takes over from there and transfers that leg to the destination once
// the staff member answers. See voice-webhook/index.ts for the full
// bridge-call flow and why. Accepts either a leadId (looks up that lead's
// phone, and outcomes log to their file) or a raw phone (quick-dial's
// manual-number path -- no lead to log against, which voice-webhook
// already handles gracefully).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const TELNYX_CONNECTION_ID = Deno.env.get("TELNYX_CONNECTION_ID")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function toE164(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 10 ? "+1" + digits : "+" + digits;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  try {
    const { leadId, phone, userId } = await req.json();
    if ((!leadId && !phone) || !userId) {
      return new Response(JSON.stringify({ error: "leadId or phone, plus userId, required" }), { status: 400, headers: CORS_HEADERS });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    let destPhone: string | null = phone || null;
    let leadName: string | null = null;
    if (leadId) {
      const { data: lead } = await sb.from("leads").select("id, name, phone").eq("id", leadId).single();
      if (!lead?.phone) {
        return new Response(JSON.stringify({ error: "This lead has no phone number on file." }), { status: 400, headers: CORS_HEADERS });
      }
      destPhone = lead.phone as string;
      leadName = lead.name as string;
    }
    const { data: staff } = await sb.from("users").select("id, name, phone").eq("id", userId).single();
    if (!staff?.phone) {
      return new Response(JSON.stringify({ error: "Your personal cell isn't on file yet — ask an admin to add it before using the dialer." }), { status: 400, headers: CORS_HEADERS });
    }

    const destE164 = toE164(destPhone);
    const staffE164 = toE164(staff.phone as string);
    if (!destE164) {
      return new Response(JSON.stringify({ error: "That doesn't look like a valid phone number." }), { status: 400, headers: CORS_HEADERS });
    }

    const clientState = btoa(JSON.stringify({
      v: 1, stage: "ringing_staff", leadId: leadId || null, userId,
      leadPhone: destE164, leadName: leadName, staffName: staff.name,
    }));

    const res = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { "Authorization": "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_id: TELNYX_CONNECTION_ID,
        to: staffE164,
        from: TELNYX_FROM_NUMBER,
        client_state: clientState,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("make-call: telnyx call create failed", JSON.stringify(data));
      const detail = data?.errors?.[0]?.detail || "Telnyx couldn't place the call.";
      return new Response(JSON.stringify({ error: detail }), { status: 502, headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ ok: true, callControlId: data?.data?.call_control_id }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
