// Mints a short-lived Telnyx WebRTC login token (JWT) for a staff member's
// browser softphone. The Telnyx API key never reaches the browser -- this
// is the one server-side hop the Telnyx docs require for that reason.
//
// Softphone build (2026-09-17): Joe's final word after the team's phone-
// system poll went unanswered -- no cell-phone ring at all when dialing
// out, staff talk to clients straight through the computer. Each staff
// member has their own Telnyx Telephony Credential (never share one
// across users -- that's what causes registration conflicts), created
// once via the Telnyx API and stored as users.telnyx_credential_id. This
// function just refreshes the JWT on demand; the credential itself is
// long-lived and was provisioned out-of-band.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  try {
    const { userId } = await req.json();
    if (!userId) return new Response(JSON.stringify({ error: "userId required" }), { status: 400, headers: CORS_HEADERS });

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: user } = await sb.from("users").select("id, telnyx_credential_id").eq("id", userId).single();
    if (!user?.telnyx_credential_id) {
      return new Response(JSON.stringify({ error: "No softphone credential set up for this user yet -- ask an admin." }), { status: 400, headers: CORS_HEADERS });
    }

    const res = await fetch(`https://api.telnyx.com/v2/telephony_credentials/${user.telnyx_credential_id}/token`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + TELNYX_API_KEY },
    });
    const token = await res.text();
    if (!res.ok) {
      console.error("get-webrtc-token: telnyx token mint failed", token);
      return new Response(JSON.stringify({ error: "Couldn't get a softphone token from Telnyx." }), { status: 502, headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ ok: true, token: token.replace(/^"|"$/g, "") }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
