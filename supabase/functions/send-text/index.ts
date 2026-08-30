// Sends an outbound SMS through Quo (formerly OpenPhone) and logs it to the CRM.
// Called from the CRM frontend with the Supabase publishable (anon) key.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const QUO_API_KEY = Deno.env.get("QUO_API_KEY")!;
const QUO_FROM_NUMBER = Deno.env.get("QUO_FROM_NUMBER") || "";
const QUO_DEFAULT_USER_ID = Deno.env.get("QUO_DEFAULT_USER_ID") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function toE164(raw: string): string {
  if (!raw) return raw;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return raw; // let Quo reject it with a clear error rather than silently mis-format
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
    // Each team member's own Quo line, passed from the CRM (their Team
    // record) -- falls back to the shared office line when not set.
    const fromNumber = toE164(body.fromNumber || QUO_FROM_NUMBER);
    const toNumber = toE164(to);

    if (!to || !text) {
      return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });
    }
    if (!fromNumber) {
      return new Response(JSON.stringify({ error: "no_from_number", detail: "No Quo number to send from -- set a personal line in Signature settings, or set the QUO_FROM_NUMBER secret for a shared default." }), { status: 500, headers: CORS_HEADERS });
    }

    const quoRes = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": QUO_API_KEY,
      },
      body: JSON.stringify({
        content: text,
        from: fromNumber,
        to: [toNumber],
        userId: QUO_DEFAULT_USER_ID || undefined,
      }),
    });
    const quoData = await quoRes.json();
    if (!quoRes.ok) {
      return new Response(JSON.stringify({ error: "quo_error", detail: quoData }), { status: 502, headers: CORS_HEADERS });
    }

    if (leadId) {
      const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const { data: leadRow } = await sb.from("leads").select("activity").eq("id", leadId).single();
      const activity = (leadRow && leadRow.activity) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10),
        type: "text",
        text: "Texted (via Quo): " + text,
        author: fromName || "System",
      });
      await sb.from("leads").update({ activity: activity }).eq("id", leadId);
    }

    return new Response(JSON.stringify({ ok: true, messageId: (quoData.data && quoData.data.id) || null }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
