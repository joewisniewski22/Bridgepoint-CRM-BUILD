// Conference calls for the dialer (Joe 2026-10-15: "add a conference call option to the dialer ... a way to add other people to a call, for instance
// Taeya needs me on a call she's having"). Staff-only, same auth as make-call.
//
// How it works (Telnyx Call Control conference, no changes to normal dialer calls):
//   start: rings the loan officer's own cell first. When they answer and press 1 (same safeguard as the normal dialer so a voicemail never joins),
//          voice-webhook creates a Telnyx conference from that leg and then dials the client (and anyone chosen up front) into it.
//   add:   dials one more person (a colleague's cell or any number) and joins them to the live conference.
//   end:   hangs up everyone.
// A call that was ALREADY started from the browser phone cannot be converted (those calls are on the browser's own connection, not under Call
// Control), so a planned 3-way has to be started with the Conference button.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const TELNYX_CONNECTION_ID = Deno.env.get("TELNYX_CONNECTION_ID")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });
function toE164(phone: string | null | undefined): string {
  const d = (phone || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length === 10 ? "+1" + d : d.length === 11 && d.startsWith("1") ? "+" + d : "+" + d;
}
const b64 = (o: unknown) => btoa(JSON.stringify(o));

async function telnyx(path: string, body: Record<string, unknown> | null, method = "POST") {
  const r = await fetch("https://api.telnyx.com/v2" + path, { method, headers: { Authorization: "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Staff only: server jobs (service key) and signed-in staff.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let trusted = token === SERVICE_ROLE_KEY;
  if (!trusted && token) {
    const { data: u } = await createClient(SUPABASE_URL, SERVICE_ROLE_KEY).auth.getUser(token).catch(() => ({ data: null }));
    trusted = !!(u && u.user);
  }
  if (!trusted) return json({ error: "not_authorized" }, 403);

  try {
    const b = await req.json();
    const action = String(b.action || "start");

    if (action === "start") {
      const userId = String(b.userId || "");
      const { data: staff } = await sb.from("users").select("id,name,phone").eq("id", userId).maybeSingle();
      if (!staff || !staff.phone) return json({ error: "no_staff_phone", detail: "Add your cell number in your profile first." }, 400);
      let leadName: string | null = null, clientPhone = toE164(b.to);
      if (b.leadId) {
        const { data: lead } = await sb.from("leads").select("id,name,phone").eq("id", String(b.leadId)).maybeSingle();
        if (lead) { leadName = lead.name; if (!clientPhone) clientPhone = toE164(lead.phone); }
      }
      if (!clientPhone) return json({ error: "no_client_phone", detail: "There's no phone number to call." }, 400);
      const guests = (Array.isArray(b.guests) ? b.guests : []).map((g: any) => ({ name: String(g.name || "Guest").slice(0, 60), phone: toE164(g.phone), role: "guest" })).filter((g: any) => g.phone).slice(0, 4);
      const participants = [{ name: leadName || String(b.targetName || "Client"), phone: clientPhone, role: "client" }, ...guests];
      const confName = "bpc-" + crypto.randomUUID().slice(0, 8);
      await sb.from("voice_conferences").insert({ name: confName, lead_id: b.leadId || null, lead_name: leadName || b.targetName || null, started_by: staff.id, status: "ringing_staff", participants });
      const staffPhone = toE164(staff.phone);
      const state = { v: 1, stage: "conf_staff", confName, userId: staff.id, staffName: staff.name, leadId: b.leadId || null, leadName: leadName || b.targetName || null };
      const r = await telnyx("/calls", { connection_id: TELNYX_CONNECTION_ID, to: staffPhone, from: TELNYX_FROM_NUMBER, timeout_secs: 30, client_state: b64(state) });
      if (!r.ok) { await sb.from("voice_conferences").update({ status: "failed" }).eq("name", confName); return json({ error: "dial_failed", detail: JSON.stringify(r.data).slice(0, 200) }, 502); }
      return json({ ok: true, confName, calling: staff.name + "'s cell" });
    }

    if (action === "add") {
      const confName = String(b.confName || "");
      const { data: row } = await sb.from("voice_conferences").select("*").eq("name", confName).maybeSingle();
      if (!row || !row.telnyx_conference_id) return json({ error: "not_live", detail: "The conference isn't live yet. Answer your phone and press 1 first." }, 409);
      if (row.status === "ended") return json({ error: "ended", detail: "That conference has ended." }, 409);
      const phone = toE164(b.to);
      if (!phone) return json({ error: "no_phone", detail: "Pick someone or enter a number." }, 400);
      const name = String(b.name || "Guest").slice(0, 60);
      // Joe 2026-10-17: Joe was dialed twice on Taeya's first conference (picked up front AND tapped Add). One leg per number.
      const l10 = (x: string) => (x || "").replace(/\D/g, "").slice(-10);
      if ((row.participants || []).some((p: any) => l10(p.phone) === l10(phone))) return json({ error: "already_on_call", detail: name + " is already on this call (or being dialed)." }, 409);
      const state = { v: 1, stage: "conf_join", confName, role: "guest", leadId: null, leadName: name, userId: row.started_by };
      const r = await telnyx("/calls", { connection_id: TELNYX_CONNECTION_ID, to: phone, from: TELNYX_FROM_NUMBER, timeout_secs: 40, client_state: b64(state) });
      if (!r.ok) return json({ error: "dial_failed", detail: JSON.stringify(r.data).slice(0, 200) }, 502);
      const parts = (row.participants || []).concat([{ name, phone, role: "guest", added: true, dialed: true }]);
      await sb.from("voice_conferences").update({ participants: parts }).eq("name", confName);
      return json({ ok: true, calling: name });
    }

    if (action === "end") {
      const confName = String(b.confName || "");
      const { data: row } = await sb.from("voice_conferences").select("*").eq("name", confName).maybeSingle();
      if (!row) return json({ error: "not_found" }, 404);
      if (row.telnyx_conference_id) {
        const p = await telnyx("/conferences/" + row.telnyx_conference_id + "/participants?page[size]=50", null, "GET");
        const list: any[] = (p.data && p.data.data) || [];
        for (const x of list) { if (x && x.call_control_id) await telnyx("/calls/" + x.call_control_id + "/actions/hangup", {}); }
      }
      await sb.from("voice_conferences").update({ status: "ended" }).eq("name", confName);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: "server_error", detail: String(err).slice(0, 200) }, 500);
  }
});
