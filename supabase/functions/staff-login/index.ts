// Real per-staff login. Validates username+PIN exactly like the old
// public.login() RPC always did, but then mints a REAL Supabase Auth
// session for that staff member (via generateLink + verifyOtp, so no
// password ever needs to exist or be stored) instead of just trusting
// the client to remember "I am now viewing as this role." That real
// session is what lets database-level RLS actually tell one loan
// officer's browser apart from another's -- see 046_staff_auth_and_lead_rls.sql.
//
// Demo accounts (demo / demo-processor) have no linked auth_id on
// purpose -- they're not real security-sensitive accounts, so they keep
// working exactly as before (session: null, frontend falls back to the
// plain anon key, same as pre-migration behavior).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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
    const { username, pin } = await req.json();
    if (!username || !pin) {
      return new Response(JSON.stringify({ error: "missing_credentials" }), { status: 400, headers: CORS_HEADERS });
    }

    const sbService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Same validation the app has always used -- SECURITY DEFINER function,
    // compares against public.users.pin, returns null on no match.
    const { data: userRow, error: loginErr } = await sbService.rpc("login", { p_username: username, p_pin: pin });
    if (loginErr || !userRow) {
      return new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401, headers: CORS_HEADERS });
    }

    // Demo accounts: no real auth account exists for these on purpose.
    if (userRow.id === "demo" || userRow.id === "demo-processor") {
      return new Response(JSON.stringify({ ok: true, user: userRow, session: null }), { headers: CORS_HEADERS });
    }

    const { data: authRow } = await sbService.from("users").select("auth_id, email").eq("id", userRow.id).single();
    if (!authRow?.auth_id || !authRow?.email) {
      // A real staff member somehow has no linked auth account -- fail
      // closed (no session) rather than silently letting them in with
      // only the old, broad anon-key access.
      return new Response(JSON.stringify({ error: "no_auth_account" }), { status: 500, headers: CORS_HEADERS });
    }

    const { data: linkData, error: linkErr } = await sbService.auth.admin.generateLink({
      type: "magiclink",
      email: authRow.email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return new Response(JSON.stringify({ error: "session_mint_failed", detail: linkErr?.message }), { status: 500, headers: CORS_HEADERS });
    }

    const sbAnon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: verifyData, error: verifyErr } = await sbAnon.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    });
    if (verifyErr || !verifyData?.session) {
      return new Response(JSON.stringify({ error: "session_verify_failed", detail: verifyErr?.message }), { status: 500, headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({
      ok: true,
      user: userRow,
      session: {
        access_token: verifyData.session.access_token,
        refresh_token: verifyData.session.refresh_token,
      },
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
