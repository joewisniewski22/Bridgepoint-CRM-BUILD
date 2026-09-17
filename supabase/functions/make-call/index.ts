// Staff-initiated click-to-call for the power dialer AND the standalone
// quick-dial (Joe's ask, 2026-09-16: a phone icon anywhere in the CRM to
// dial any number or a searched lead, outside the Power Dialer's queue
// flow).
//
// Two modes:
// - Sequential (leadId, or phone without `direct`): rings the staff
//   member's own cell first; voice-webhook transfers that leg to the
//   destination once staff answers. See voice-webhook/index.ts.
// - Direct (`direct: true`): dials BOTH the destination and the staff
//   member's cell in parallel, at the same instant, instead of waiting on
//   staff to pick up before the destination phone even starts ringing.
//   voice-webhook bridges them together once both sides have answered.
//   As of 2026-09-17 this is the default for every call the dialer places
//   (startDialerCall) -- Joe decided it himself after the team's phone-
//   system poll went unanswered ("they don't vote, they don't get a
//   say"), on the reasoning that a single simultaneous dial-out is
//   faster than the sequential ring-staff-then-transfer pattern.
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
function last10(phone: string | null | undefined): string {
  return (phone || "").replace(/\D/g, "").slice(-10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  try {
    const { leadId, phone, userId, direct } = await req.json();
    if ((!leadId && !phone) || !userId) {
      return new Response(JSON.stringify({ error: "leadId or phone, plus userId, required" }), { status: 400, headers: CORS_HEADERS });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    let destPhone: string | null = phone || null;
    let leadName: string | null = null;
    let matchedLeadId: string | null = leadId || null;
    if (leadId) {
      const { data: lead } = await sb.from("leads").select("id, name, phone").eq("id", leadId).single();
      if (!lead?.phone) {
        return new Response(JSON.stringify({ error: "This lead has no phone number on file." }), { status: 400, headers: CORS_HEADERS });
      }
      destPhone = lead.phone as string;
      leadName = lead.name as string;
    } else if (phone) {
      // Manual-dial box gave a raw number, no leadId -- if it happens to
      // match an existing lead anyway, attach it so the call still logs
      // to that client's file (Joe's ask, 2026-09-16) instead of vanishing.
      const dialedDigits = last10(phone);
      const { data: matches } = await sb.from("leads").select("id, name, phone");
      const match = (matches || []).find((l) => last10(l.phone as string) === dialedDigits);
      if (match) {
        matchedLeadId = match.id as string;
        leadName = match.name as string;
      }
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

    if (direct) {
      // Parallel dial -- both legs are OUTBOUND calls WE originate at the
      // same instant (nobody "answers" on our end, the far end does), so
      // the destination's phone starts ringing immediately rather than
      // waiting on staff to answer their own phone first. client_state
      // goes in the create body itself so both legs are tagged from the
      // start; voice-webhook bridges them once call.answered fires for both.
      const pairId = "DD" + crypto.randomUUID().slice(0, 12);
      const destState = btoa(JSON.stringify({ v: 1, stage: "direct_dial_leg", pairId, role: "destination", leadId: matchedLeadId, leadName, staffName: staff.name }));
      const staffState = btoa(JSON.stringify({ v: 1, stage: "direct_dial_leg", pairId, role: "staff", leadId: matchedLeadId, leadName, staffName: staff.name }));

      const [destRes, staffRes] = await Promise.all([
        fetch("https://api.telnyx.com/v2/calls", {
          method: "POST",
          headers: { "Authorization": "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: TELNYX_CONNECTION_ID, to: destE164, from: TELNYX_FROM_NUMBER, timeout_secs: 30, client_state: destState }),
        }),
        fetch("https://api.telnyx.com/v2/calls", {
          method: "POST",
          headers: { "Authorization": "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: TELNYX_CONNECTION_ID, to: staffE164, from: TELNYX_FROM_NUMBER, timeout_secs: 30, client_state: staffState }),
        }),
      ]);
      const destData = await destRes.json();
      const staffData = await staffRes.json();

      const destCallControlId = destData?.data?.call_control_id;
      const staffCallControlId = staffData?.data?.call_control_id;
      if (!destRes.ok || !staffRes.ok || !destCallControlId || !staffCallControlId) {
        console.error("make-call: direct dial create failed", JSON.stringify(destData), JSON.stringify(staffData));
        // Clean up whichever leg DID get created so it doesn't ring forever alone.
        if (destCallControlId) fetch(`https://api.telnyx.com/v2/calls/${destCallControlId}/actions/hangup`, { method: "POST", headers: { "Authorization": "Bearer " + TELNYX_API_KEY } }).catch(() => {});
        if (staffCallControlId) fetch(`https://api.telnyx.com/v2/calls/${staffCallControlId}/actions/hangup`, { method: "POST", headers: { "Authorization": "Bearer " + TELNYX_API_KEY } }).catch(() => {});
        return new Response(JSON.stringify({ error: "Telnyx couldn't place the call." }), { status: 502, headers: CORS_HEADERS });
      }

      await sb.from("voice_direct_dial_pairs").insert({
        id: pairId, staff_call_control_id: staffCallControlId, destination_call_control_id: destCallControlId,
      });

      return new Response(JSON.stringify({ ok: true, destCallControlId, staffCallControlId, matchedLeadId }), { headers: CORS_HEADERS });
    }

    const clientState = btoa(JSON.stringify({
      v: 1, stage: "ringing_staff", leadId: matchedLeadId, userId,
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

    return new Response(JSON.stringify({ ok: true, callControlId: data?.data?.call_control_id, matchedLeadId }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
