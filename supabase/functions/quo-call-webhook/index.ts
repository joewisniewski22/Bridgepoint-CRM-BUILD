// Quo's call.recording.completed webhook -> fetches the AI call summary,
// matches it to a lead + the loan officer who took the call, and generates
// a coaching note (see generate-coaching-note). Quo's exact webhook
// payload shape isn't fully documented, so this parses defensively for a
// handful of likely shapes and always logs the raw payload so it can be
// adjusted once real events start arriving, same approach as receive-text.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QUO_API_KEY = Deno.env.get("QUO_API_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("QUO_CALL_WEBHOOK_TOKEN")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function last10(phone: string | null | undefined): string {
  return (phone || "").replace(/\D/g, "").slice(-10);
}

function extractCallEvent(body: Record<string, unknown>): { callId: string | null; from: string | null; to: string | null; direction: string | null; status: string | null; duration: number | null } {
  const data = (body.data as Record<string, unknown>) || body;
  const object = (data.object as Record<string, unknown>) || data;
  const callId = (object.id as string) || (object.callId as string) || (data.callId as string) || null;
  const from = (object.from as string) || (object.participants as string[] | undefined)?.[0] || null;
  const to = (object.to as string) || (Array.isArray(object.to) ? (object.to as string[])[0] : null);
  const direction = (object.direction as string) || null;
  const status = (object.status as string) || (object.callStatus as string) || null;
  const duration = typeof object.duration === "number" ? (object.duration as number) : null;
  return { callId, from: from as string | null, to: to as string | null, direction, status, duration };
}

// Payload shape for call.completed isn't fully documented -- infer a
// CALL_OUTCOMES-compatible outcome ("connected" | "no-answer" |
// "left-voicemail") defensively from whatever status/duration signal is
// present, same tune-after-real-events approach as the rest of this call.
function inferOutcome(status: string | null, duration: number | null): string {
  const s = (status || "").toLowerCase();
  if (s.includes("voicemail")) return "left-voicemail";
  if (s.includes("no-answer") || s.includes("missed") || s.includes("busy") || s.includes("failed")) return "no-answer";
  if (s.includes("completed") || s.includes("answered")) return "connected";
  if (duration != null) return duration > 15 ? "connected" : "no-answer";
  return "connected";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  const url = new URL(req.url);
  if (url.searchParams.get("token") !== WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    console.log("quo-call-webhook: raw payload", JSON.stringify(body));

    // Event type field isn't confirmed in Quo's docs either -- try the
    // common spots. Defaults to treating it as a plain call-completed event
    // (log the attempt) unless it clearly says recording.completed.
    const eventType = (body.type as string) || (body.event as string) || ((body.data as Record<string, unknown>)?.type as string) || "";
    const isRecordingEvent = eventType.includes("recording");

    const { callId, from, to, status, duration } = extractCallEvent(body);
    if (!callId) {
      console.log("quo-call-webhook: no callId found in payload, skipping");
      return new Response(JSON.stringify({ ok: true, note: "no callId in payload" }), { headers: CORS_HEADERS });
    }

    // One of from/to is a staff member's Quo line, the other is the lead's
    // phone -- check both directions against both tables.
    const { data: staffRows } = await sb.from("users").select("id,name,phone,quo_phone_number,role");
    const { data: leadRows } = await sb.from("leads").select("id,name,phone,assigned_to,stage,status,ai_stage,automation_paused,call_attempts,activity,first_attempt_at");

    const candidates = [from, to].filter(Boolean) as string[];
    let staffId: string | null = null;
    let leadId: string | null = null;
    for (const num of candidates) {
      const d = last10(num);
      if (!staffId) {
        const s = (staffRows || []).find((u) => last10(u.phone as string) === d || last10(u.quo_phone_number as string) === d);
        if (s) staffId = s.id as string;
      }
      if (!leadId) {
        const l = (leadRows || []).find((x) => last10(x.phone as string) === d);
        if (l) leadId = l.id as string;
      }
    }
    if (!leadId) {
      console.log("quo-call-webhook: no matching lead for call", callId, from, to);
      return new Response(JSON.stringify({ ok: true, note: "no matching lead" }), { headers: CORS_HEADERS });
    }
    const lead = (leadRows || []).find((l) => l.id === leadId)!;
    if (!staffId) staffId = (lead.assigned_to as string) || null;

    // Log the call itself -- every real call, answered or not, not just
    // ones that produce a transcript. Dedupe on quoCallId so this stays
    // idempotent if both call.completed and call.recording.completed fire
    // for the same call.
    const existingAttempts = (Array.isArray(lead.call_attempts) ? lead.call_attempts : []) as Array<Record<string, unknown>>;
    const alreadyLogged = existingAttempts.some((a) => a.quoCallId === callId);
    if (!alreadyLogged) {
      const outcome = inferOutcome(status, duration);
      const outcomeLabel = outcome === "connected" ? "Connected" : outcome === "left-voicemail" ? "Left voicemail" : "No answer";
      const d = new Date().toISOString().slice(0, 10);
      const newAttempts = [...existingAttempts, { date: d, outcome, notes: "Logged automatically from Quo", quoCallId: callId }];
      const activity = (Array.isArray(lead.activity) ? lead.activity : []) as Array<Record<string, unknown>>;
      activity.push({ date: d, type: "call", text: "Call logged — " + outcomeLabel + " (via Quo)", author: staffId ? ((staffRows || []).find((u) => u.id === staffId)?.name as string) || "System" : "System" });
      const patch: Record<string, unknown> = {
        call_attempts: newAttempts, activity, last_contact_at: d,
        first_attempt_at: lead.first_attempt_at || new Date().toISOString(),
      };
      if (outcome === "connected") {
        if (lead.stage === "new" || lead.stage === "attempting") patch.stage = "qualifying";
        if (lead.ai_stage && !lead.automation_paused) {
          patch.automation_paused = true;
          activity.push({ date: d, type: "system", text: "AI automation paused — you connected with the client directly, follow up per your call", author: "System" });
        }
      }
      await sb.from("leads").update(patch).eq("id", leadId);
      console.log("quo-call-webhook: logged call attempt", callId, leadId, outcome);
    }

    if (!isRecordingEvent) {
      return new Response(JSON.stringify({ ok: true, leadId, staffId, note: "call logged, not a recording event" }), { headers: CORS_HEADERS });
    }

    // Give Quo's summary generation a moment if this fires right as the
    // recording finishes -- the summary/transcript can lag slightly behind.
    let summaryText = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch("https://api.quo.com/v1/call-summaries/" + callId, {
        headers: { "Authorization": QUO_API_KEY },
      });
      const data = await res.json();
      if (res.ok && data?.data?.summary) {
        const summary: string[] = data.data.summary || [];
        const nextSteps: string[] = data.data.nextSteps || [];
        summaryText = summary.join(" ") + (nextSteps.length ? ("\nSuggested next steps: " + nextSteps.join(" ")) : "");
        break;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
    }
    if (!summaryText) {
      console.log("quo-call-webhook: no summary available yet for call", callId);
      return new Response(JSON.stringify({ ok: true, note: "no summary available" }), { headers: CORS_HEADERS });
    }

    const genRes = await fetch(SUPABASE_URL + "/functions/v1/generate-coaching-note", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ leadId, staffId, source: "call", callContext: summaryText }),
    });
    const genData = await genRes.json();
    return new Response(JSON.stringify({ ok: true, leadId, staffId, coaching: genData }), { headers: CORS_HEADERS });
  } catch (err) {
    console.error("quo-call-webhook: error", String(err));
    return new Response(JSON.stringify({ ok: true, error: String(err) }), { headers: CORS_HEADERS });
  }
});
