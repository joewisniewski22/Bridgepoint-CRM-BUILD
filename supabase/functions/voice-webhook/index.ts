// Telnyx Call Control webhook for the power dialer. Bridge-call pattern,
// no WebRTC softphone needed:
//   Outbound (staff clicks Call): ring the staff member's own personal
//   cell first: once THEY pick up, transfer that leg to the lead's number
//   so they land in a normal two-party call.
//   Inbound (someone calls our main line): answer immediately, match the
//   caller against leads.phone to find the assigned staff member, then
//   transfer to that person's personal cell. Unmatched callers fall back
//   to "owner", mirroring receive-email's untagged-message fallback.
//
// State is carried across legs via Telnyx's client_state (base64 JSON),
// updated on each command so the next webhook event knows what stage the
// call is in. call_session_id stays constant across a transfer (Telnyx
// docs: it correlates all legs of one call flow), so it's what call
// outcomes get logged against.
//
// Outcomes are logged into leads.call_attempts using the same shape Quo's
// call webhook already writes (see quo-call-webhook/index.ts) so the
// existing daily call-quota reminders keep working unmodified regardless
// of which phone system placed the call. Real disposition tracking beyond
// connected/no-answer is a follow-up, not built here yet.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const JSON_HEADERS = { "Content-Type": "application/json" };

interface CallState {
  v: 1;
  stage: "ringing_staff" | "connecting_lead" | "answering_inbound" | "connecting_staff";
  leadId?: string | null;
  userId?: string | null;
  staffId?: string | null;
  leadPhone?: string;
  leadName?: string;
  staffName?: string;
  staffPhone?: string;
  callerNumber?: string;
}

function last10(phone: string | null | undefined): string {
  return (phone || "").replace(/\D/g, "").slice(-10);
}
function toE164(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 10 ? "+1" + digits : "+" + digits;
}
function decodeState(payload: Record<string, unknown>): CallState | null {
  try {
    return JSON.parse(atob((payload.client_state as string) || ""));
  } catch {
    return null;
  }
}
function encodeState(obj: CallState): string {
  return btoa(JSON.stringify(obj));
}

async function telnyxAction(callControlId: string, action: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`, {
    method: "POST",
    headers: { "Authorization": "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) console.error(`voice-webhook: ${action} failed`, callControlId, JSON.stringify(data));
  return { ok: res.ok, data };
}

async function logCallOutcome(opts: { leadId: string; staffId?: string | null; sessionId: string; outcome: string; note: string }) {
  const { data: lead } = await sb.from("leads").select("call_attempts, activity").eq("id", opts.leadId).single();
  if (!lead) return;
  const attempts = (Array.isArray(lead.call_attempts) ? lead.call_attempts : []) as Array<Record<string, unknown>>;
  const activity = (Array.isArray(lead.activity) ? lead.activity : []) as Array<Record<string, unknown>>;
  const d = new Date().toISOString().slice(0, 10);

  let staffName = "System";
  if (opts.staffId) {
    const { data: staff } = await sb.from("users").select("name").eq("id", opts.staffId).single();
    if (staff?.name) staffName = staff.name as string;
  }

  const entry = { date: d, outcome: opts.outcome, notes: opts.note, telnyxSessionId: opts.sessionId };
  const existingIdx = attempts.findIndex((a) => a.telnyxSessionId === opts.sessionId);
  if (existingIdx !== -1) attempts[existingIdx] = entry;
  else attempts.push(entry);

  activity.push({ date: d, type: "call", text: opts.note, author: staffName });
  await sb.from("leads").update({ call_attempts: attempts, activity, last_contact_at: d }).eq("id", opts.leadId);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const event = (body?.data as Record<string, unknown>) || {};
  const eventType = event.event_type as string;
  const payload = (event.payload as Record<string, unknown>) || {};
  console.log("voice-webhook:", eventType, JSON.stringify(payload));

  try {
    if (eventType === "call.initiated") {
      if (payload.direction === "incoming") {
        const callerDigits = last10(payload.from as string);
        const { data: leads } = await sb.from("leads").select("id, name, phone, assigned_to");
        const match = (leads || []).find((l) => last10(l.phone as string) === callerDigits);

        if (!match) {
          await sb.from("notifications").insert({
            id: "N" + crypto.randomUUID().slice(0, 8),
            to_user_id: "owner",
            lead_id: null,
            kind: "call",
            text: "Inbound call from " + (payload.from as string) + " — no matching lead in CRM",
            date: new Date().toISOString().slice(0, 10),
            read: false,
          });
        }

        let staffId = (match?.assigned_to as string) || "owner";
        const { data: staff } = await sb.from("users").select("id, name, phone").eq("id", staffId).single();
        let routeStaff = staff;
        if (!routeStaff?.phone) {
          const { data: owner } = await sb.from("users").select("id, name, phone").eq("id", "owner").single();
          routeStaff = owner;
          staffId = "owner";
        }

        if (!routeStaff?.phone) {
          console.error("voice-webhook: no staff phone on file to route inbound call to");
          return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
        }

        const state: CallState = {
          v: 1,
          stage: "answering_inbound",
          leadId: match?.id || null,
          staffId,
          staffPhone: toE164(routeStaff.phone as string),
          callerNumber: payload.from as string,
        };
        await telnyxAction(payload.call_control_id as string, "answer", { client_state: encodeState(state) });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.answered") {
      const state = decodeState(payload);
      if (!state) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

      if (state.stage === "ringing_staff") {
        // Staff picked up the dialer leg -- now ring the lead and bridge once they answer.
        const nextState: CallState = { ...state, stage: "connecting_lead" };
        await telnyxAction(payload.call_control_id as string, "transfer", {
          to: state.leadPhone, from: TELNYX_FROM_NUMBER, client_state: encodeState(nextState),
        });
      } else if (state.stage === "answering_inbound") {
        // Caller connected to us -- now ring the assigned staff member's cell and bridge.
        const nextState: CallState = { ...state, stage: "connecting_staff" };
        await telnyxAction(payload.call_control_id as string, "transfer", {
          to: state.staffPhone, from: TELNYX_FROM_NUMBER, client_state: encodeState(nextState),
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.hangup") {
      const state = decodeState(payload);
      if (!state || !state.leadId) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

      const cause = ((payload.hangup_cause as string) || "").toLowerCase();
      const neverConnected = ["no_answer", "timeout", "call_rejected", "originator_cancel", "unspecified", "user_busy"].includes(cause);
      const sessionId = (payload.call_session_id as string) || (payload.call_control_id as string);

      if (state.stage === "ringing_staff") {
        await logCallOutcome({
          leadId: state.leadId, staffId: state.userId, sessionId, outcome: "no-answer",
          note: "Dialer call to " + (state.staffName || "staff") + " went unanswered before reaching " + (state.leadName || "the lead"),
        });
      } else if (state.stage === "connecting_lead") {
        await logCallOutcome({
          leadId: state.leadId, staffId: state.userId, sessionId,
          outcome: neverConnected ? "no-answer" : "connected",
          note: neverConnected
            ? "Outbound call — " + (state.leadName || "lead") + " did not pick up"
            : "Outbound call connected with " + (state.leadName || "lead"),
        });
      } else if (state.stage === "answering_inbound") {
        await logCallOutcome({
          leadId: state.leadId, staffId: state.staffId, sessionId, outcome: "no-answer",
          note: "Inbound call from " + (state.callerNumber || "caller") + " dropped before connecting to staff",
        });
      } else if (state.stage === "connecting_staff") {
        await logCallOutcome({
          leadId: state.leadId, staffId: state.staffId, sessionId,
          outcome: neverConnected ? "no-answer" : "connected",
          note: neverConnected ? "Inbound call — staff did not pick up" : "Inbound call connected with staff",
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err) {
    console.error("voice-webhook: error", String(err));
    return new Response(JSON.stringify({ ok: true, error: String(err) }), { headers: JSON_HEADERS });
  }
});
