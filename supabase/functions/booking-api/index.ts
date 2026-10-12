// Server side of the public scheduling page (?book=<user id>). Until 10/12/2026 that page read the
// calendar tables and wrote appointments directly with the public key. Now it only gets the host's
// availability and the busy time slots (no names, phones or notes), and books through this function.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const clip = (v: unknown, n: number) => (v == null ? null : String(v).slice(0, n));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const userId = String(body.userId || "");
  const { data: host } = await sb.from("users").select("id,name,email,phone").eq("id", userId).maybeSingle();
  if (!host) return json({ ok: false, error: "invalid" }, 404);

  if (body.action === "slots") {
    const [rules, appts] = await Promise.all([
      sb.from("availability_rules").select("*").eq("user_id", userId),
      sb.from("appointments").select("id,user_id,start_at,end_at,status").eq("user_id", userId).neq("status", "canceled"),
    ]);
    // busy times only: the page needs to know a slot is taken, never who took it
    const busy = (appts.data || []).map((a: any) => ({ id: a.id, user_id: a.user_id, lead_id: null, name: "", phone: null, email: null, notes: null, start_at: a.start_at, end_at: a.end_at, status: a.status }));
    return json({ ok: true, rules: rules.data || [], appointments: busy });
  }

  if (body.action === "book") {
    const a = (body.appt && typeof body.appt === "object") ? body.appt : {};
    const name = clip(a.name, 120), startAt = new Date(a.startAt), endAt = new Date(a.endAt);
    if (!name || isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt || endAt.getTime() - startAt.getTime() > 4 * 3600 * 1000 || startAt.getTime() < Date.now() - 60000 || startAt.getTime() > Date.now() + 120 * 86400000) {
      return json({ ok: false, error: "bad_request" }, 400);
    }
    let leadId: string | null = null;
    if (a.leadId) { const { data: l } = await sb.from("leads").select("id").eq("id", String(a.leadId)).maybeSingle(); leadId = l ? l.id : null; }
    const row = { id: "apt-" + crypto.randomUUID(), user_id: userId, lead_id: leadId, name, phone: clip(a.phone, 40), email: clip(a.email, 160), notes: clip(a.notes, 1000),
      start_at: startAt.toISOString(), end_at: endAt.toISOString(), status: "scheduled" };
    const { error } = await sb.from("appointments").insert(row);
    if (error) return json({ ok: false, error: error.code === "23505" ? "slot_taken" : "book_failed" }, error.code === "23505" ? 409 : 500);

    const when = startAt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    const alertText = name + " booked a time with you: " + when + " ET" + (row.phone ? " — " + row.phone : "");
    await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: userId, lead_id: null, kind: "appointment", text: alertText, date: new Date().toISOString().slice(0, 10), read: false });
    const auth = { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY };
    if (host.phone) await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers: auth, body: JSON.stringify({ to: host.phone, text: "Bridgepoint CRM: " + alertText }) }).catch(() => null);
    if (host.email) await fetch(SUPABASE_URL + "/functions/v1/send-email", { method: "POST", headers: auth, body: JSON.stringify({ to: host.email, subject: "New booking: " + name, text: alertText, fromName: "Bridgepoint CRM" }) }).catch(() => null);
    return json({ ok: true, appointment: row });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
