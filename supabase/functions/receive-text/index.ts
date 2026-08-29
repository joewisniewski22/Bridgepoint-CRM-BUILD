// Inbound webhook for texts received via Quo (formerly OpenPhone). Point
// Quo's webhook (message.received event) at this function's URL.
//
// Quo's own docs disagree with themselves on the exact payload shape across
// two doc versions found during setup, so this parses defensively and
// accepts either the newer nested shape or the older flatter one rather
// than assuming one is correct. If Quo's real payload turns out to be a
// third shape, check the "raw" activity note this logs and adjust.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function extractMessage(body: Record<string, unknown>) {
  const data = (body.data as Record<string, unknown>) || {};
  // Newer shape: data.resource.text / data.context.senderIdentifier / recipientIdentifiers
  const resource = data.resource as Record<string, unknown> | undefined;
  const context = data.context as Record<string, unknown> | undefined;
  if (resource && typeof resource.text === "string") {
    return {
      from: (context && (context.senderIdentifier as string)) || null,
      to: (context && Array.isArray(context.recipientIdentifiers) ? (context.recipientIdentifiers as string[])[0] : null),
      text: resource.text as string,
      direction: (resource.direction as string) || "incoming",
    };
  }
  // Older shape: data.object.from / to / body
  const obj = data.object as Record<string, unknown> | undefined;
  if (obj && typeof obj.body === "string") {
    return {
      from: (obj.from as string) || null,
      to: Array.isArray(obj.to) ? (obj.to as string[])[0] : (obj.to as string) || null,
      text: obj.body as string,
      direction: (obj.direction as string) || "incoming",
    };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const msg = extractMessage(body);
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (!msg || !msg.from) {
      // Log the raw payload shape so it can be inspected/fixed without losing the event.
      console.log("receive-text: unrecognized payload", JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true, note: "payload not recognized, logged for inspection" }), { headers: CORS_HEADERS });
    }
    if (msg.direction === "outgoing" || msg.direction === "outbound") {
      // Ignore delivery receipts for our own outbound sends.
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }

    const senderDigits = msg.from.replace(/\D/g, "");
    const { data: leads } = await sb.from("leads").select("id, phone, name, activity, assigned_to");
    const match = (leads || []).find((l: Record<string, unknown>) => {
      const phone = (l.phone as string) || "";
      return phone.replace(/\D/g, "").slice(-10) === senderDigits.slice(-10);
    });

    if (match) {
      const activity = (match.activity as unknown[]) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10),
        type: "text",
        text: "Received (via Quo): " + msg.text,
        author: (match.name as string) || "Borrower",
      });
      await sb.from("leads").update({ activity }).eq("id", match.id as string);

      if (match.assigned_to) {
        await sb.from("notifications").insert({
          id: "N" + crypto.randomUUID().slice(0, 8),
          to_user_id: match.assigned_to,
          lead_id: match.id,
          kind: "text",
          text: (match.name as string) + " replied: " + msg.text.slice(0, 80),
          date: new Date().toISOString().slice(0, 10),
          read: false,
        });
      }
    } else {
      console.log("receive-text: no lead matched sender", msg.from);
    }

    return new Response(JSON.stringify({ ok: true, matched: !!match }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
