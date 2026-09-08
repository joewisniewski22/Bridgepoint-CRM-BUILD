// One-time setup helper: creates the real Quo webhook subscription for
// call.completed + call.recording.completed, pointed at quo-call-webhook,
// using the QUO_API_KEY already configured in this project. Not part of
// the app's runtime -- run once, then this can be left alone or removed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const QUO_API_KEY = Deno.env.get("QUO_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QUO_CALL_WEBHOOK_TOKEN = Deno.env.get("QUO_CALL_WEBHOOK_TOKEN")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const targetUrl = SUPABASE_URL.replace(".supabase.co", ".supabase.co") + "/functions/v1/quo-call-webhook?token=" + QUO_CALL_WEBHOOK_TOKEN;

  const res = await fetch("https://api.quo.com/v1/webhooks/calls", {
    method: "POST",
    headers: { "Authorization": QUO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      url: targetUrl,
      events: ["call.completed", "call.recording.completed"],
      resourceIds: ["*"],
      label: "Call logging + AI coaching (Bridgepoint CRM)",
      status: "enabled",
    }),
  });
  const data = await res.json();
  return new Response(JSON.stringify({ ok: res.ok, status: res.status, data }), { headers: CORS_HEADERS });
});
