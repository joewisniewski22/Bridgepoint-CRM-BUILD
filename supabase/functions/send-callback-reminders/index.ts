// Runs every 5 minutes via pg_cron. When a call back that a client requested
// (set from the call log's "Requested call back" outcome, stored as
// leads.next_follow_up_at) is coming up, texts the assigned loan officer and
// adds an in-app notification. Originally fired AT the due moment (Joe's
// 2026-09-21 ask); changed 2026-09-28 to fire ~10 minutes BEFORE instead, to
// match the appointment-reminder heads-up pattern and give the LO a moment
// to pull the file up before dialing -- "10 minutes before each a text with
// who they're calling and about what".
//
// Dedupe lives in its own table (callback_reminders_sent, keyed by lead +
// due time) rather than a flag on the lead: the CRM client keeps its own copy
// of every lead and re-saves it, which would overwrite a flag written here and
// cause a second reminder. Rescheduling a callback gives it a new due_at, so it
// gets a fresh reminder.
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

const REMINDER_LEAD_MS = 10 * 60 * 1000; // remind ~10 min before due
const CATCH_WINDOW_MS = 10 * 60 * 1000; // 5-min cron cadence + buffer, so nothing falls between runs

Deno.serve(async () => {
  const now = Date.now();
  const windowStart = new Date(now + REMINDER_LEAD_MS - CATCH_WINDOW_MS).toISOString();
  const windowEnd = new Date(now + REMINDER_LEAD_MS).toISOString();

  const { data: leads, error } = await sb.from("leads")
    .select("id, name, phone, assigned_to, next_follow_up_at, next_follow_up_note, status")
    .not("next_follow_up_at", "is", null)
    .gte("next_follow_up_at", windowStart)
    .lte("next_follow_up_at", windowEnd)
    .eq("status", "active");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  let sent = 0;
  for (const lead of leads || []) {
    const dueAt = lead.next_follow_up_at as string;
    // Claim it first: the insert fails if this exact (lead, due time) was already reminded.
    const { error: claimErr } = await sb.from("callback_reminders_sent").insert({ lead_id: lead.id, due_at: dueAt });
    if (claimErr) continue;

    const staffId = (lead.assigned_to as string) || "owner";
    const { data: staff } = await sb.from("users").select("phone").eq("id", staffId).single();
    const link = CRM_URL + "?lead=" + lead.id;
    const noteBit = lead.next_follow_up_note ? (" — " + String(lead.next_follow_up_note).replace(/^Call back requested:?\s*/, "")) : "";
    const dueLocal = new Date(dueAt).toLocaleTimeString("en-US", { timeZone: await staffTz(staffId), hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const text = "⏰ Call back " + lead.name + " at " + dueLocal + " (" + (lead.phone || "no phone on file") + ")" + noteBit + " — open & dial: " + link;

    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: staffId, lead_id: lead.id, kind: "callback",
      text: "⏰ Call back " + lead.name + " at " + dueLocal + noteBit, date: new Date().toISOString().slice(0, 10), read: false,
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
  return new Response(JSON.stringify({ ok: true, checked: (leads || []).length, sent }), { headers: { "Content-Type": "application/json" } });
});
