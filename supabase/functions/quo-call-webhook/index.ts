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

function extractCallEvent(body: Record<string, unknown>): { callId: string | null; from: string | null; to: string | null } {
  const data = (body.data as Record<string, unknown>) || body;
  const object = (data.object as Record<string, unknown>) || data;
  const callId = (object.id as string) || (object.callId as string) || (data.callId as string) || null;
  const from = (object.from as string) || (object.participants as string[] | undefined)?.[0] || null;
  const to = (object.to as string) || (Array.isArray(object.to) ? (object.to as string[])[0] : null);
  return { callId, from: from as string | null, to: to as string | null };
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

    const { callId, from, to } = extractCallEvent(body);
    if (!callId) {
      console.log("quo-call-webhook: no callId found in payload, skipping");
      return new Response(JSON.stringify({ ok: true, note: "no callId in payload" }), { headers: CORS_HEADERS });
    }

    // One of from/to is a staff member's Quo line, the other is the lead's
    // phone -- check both directions against both tables.
    const { data: staffRows } = await sb.from("users").select("id,name,phone,quo_phone_number,role");
    const { data: leadRows } = await sb.from("leads").select("id,name,phone,assigned_to");

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
    if (!staffId) {
      const lead = (leadRows || []).find((l) => l.id === leadId);
      staffId = (lead && (lead.assigned_to as string)) || null;
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
