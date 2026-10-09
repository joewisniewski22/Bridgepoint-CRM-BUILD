// Runs every 5 minutes via pg_cron. Texts the staff member an appointment
// is coming up in ~10 minutes -- whether they booked it themselves or a
// client self-booked it through the public booking link (appointments.user_id
// is who it's for either way). Joe's ask 2026-09-28: "send me text reminders
// of this and all of my appointments whether i make them or the client
// does" -- widened to the whole team, then refined the same day to "10
// minutes before each a text with who they're calling and about what" (was
// originally 30 minutes, with no topic in the text).
//
// Dedupe lives in its own table (appointment_reminders_sent, keyed by
// appointment + start time) rather than a flag on the appointment row, same
// reasoning as send-callback-reminders: keeps a reschedule (new start_at)
// getting its own fresh reminder without any client-side state to conflict with.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Each staff member's own time zone (set with their hours in My Schedule; default Eastern). 10/9/26.
async function staffTz(userId: string): Promise<string> {
  const { data } = await sb.from("availability_rules").select("timezone").eq("user_id", userId).limit(1);
  return (data && data[0] && data[0].timezone) || "America/New_York";
}

const REMINDER_LEAD_MS = 10 * 60 * 1000; // remind ~10 min before start
const CATCH_WINDOW_MS = 10 * 60 * 1000; // 5-min cron cadence + buffer, so nothing falls between runs

Deno.serve(async () => {
  const now = Date.now();
  const windowStart = new Date(now + REMINDER_LEAD_MS - CATCH_WINDOW_MS).toISOString();
  const windowEnd = new Date(now + REMINDER_LEAD_MS).toISOString();

  const { data: appts, error } = await sb.from("appointments")
    .select("id, user_id, lead_id, name, phone, notes, start_at, status")
    .eq("status", "scheduled")
    .gte("start_at", windowStart)
    .lte("start_at", windowEnd);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  let sent = 0;
  for (const appt of appts || []) {
    const startAt = appt.start_at as string;
    // Claim it first: the insert fails if this exact (appointment, start time) was already reminded.
    const { error: claimErr } = await sb.from("appointment_reminders_sent").insert({ appointment_id: appt.id, start_at: startAt });
    if (claimErr) continue;

    const userId = appt.user_id as string;
    const { data: staff } = await sb.from("users").select("phone").eq("id", userId).single();
    const tz = await staffTz(userId);
    const startLocal = new Date(startAt).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const link = appt.lead_id ? (CRM_URL + "?lead=" + appt.lead_id) : CRM_URL;
    const notesBit = appt.notes ? (" — " + String(appt.notes).slice(0, 160)) : "";
    const text = "📅 " + (appt.name || "A client") + " at " + startLocal + (appt.phone ? (" (" + appt.phone + ")") : "") + notesBit + " — " + link;

    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: userId, lead_id: appt.lead_id || null, kind: "appointment",
      text: text, date: new Date().toISOString().slice(0, 10), read: false,
    });
    if (staff?.phone) {
      await fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: staff.phone, text: "Bridgepoint CRM: " + text, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    sent++;
  }
  return new Response(JSON.stringify({ ok: true, checked: (appts || []).length, sent }), { headers: { "Content-Type": "application/json" } });
});
