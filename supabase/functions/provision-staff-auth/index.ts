// Provisions the real Supabase Auth account a new staff member needs to
// actually log in -- see 046_staff_auth_and_lead_rls.sql and staff-login.
// Called from the CRM right after a new team member's public.users row
// is created (create_user RPC). Without this step, staff-login fails
// closed with "no_auth_account" forever -- the users row alone is not
// enough (this is exactly the gap Taeya fell into, added through the
// UI after the one-time backfill that gave everyone else an auth_id).
// Idempotent: safe to call again for someone who already has an
// auth_id, or whose email already has an auth account from some other
// path (looks it up by email rather than blindly creating a duplicate).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const { userId } = await req.json();
    if (!userId) return new Response(JSON.stringify({ error: "missing_userId" }), { status: 400, headers: CORS_HEADERS });

    const { data: userRow, error: fetchErr } = await sb.from("users").select("id,email,auth_id").eq("id", userId).single();
    if (fetchErr || !userRow) return new Response(JSON.stringify({ error: "user_not_found" }), { status: 404, headers: CORS_HEADERS });
    if (userRow.auth_id) return new Response(JSON.stringify({ ok: true, alreadyProvisioned: true }), { headers: CORS_HEADERS });
    if (!userRow.email) return new Response(JSON.stringify({ error: "no_email_on_file", detail: "Add an email to this staff member's profile, then retry -- staff-login requires one." }), { status: 400, headers: CORS_HEADERS });

    // Look up by email first -- avoid creating a second orphaned auth
    // account if one already exists for this address from some other path.
    let authId: string | null = null;
    const { data: existingList } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = (existingList?.users || []).find((u) => (u.email || "").toLowerCase() === userRow.email.toLowerCase());
    if (existing) {
      authId = existing.id;
    } else {
      const { data: created, error: createErr } = await sb.auth.admin.createUser({ email: userRow.email, email_confirm: true });
      if (createErr || !created?.user) {
        return new Response(JSON.stringify({ error: "auth_create_failed", detail: createErr?.message }), { status: 500, headers: CORS_HEADERS });
      }
      authId = created.user.id;
    }

    const { error: updErr } = await sb.from("users").update({ auth_id: authId }).eq("id", userId);
    if (updErr) return new Response(JSON.stringify({ error: updErr.message }), { status: 500, headers: CORS_HEADERS });

    return new Response(JSON.stringify({ ok: true, authId }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
