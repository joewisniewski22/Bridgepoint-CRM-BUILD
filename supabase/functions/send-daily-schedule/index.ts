// Runs every 10 minutes via pg_cron. Almost every tick is a no-op -- it
// only actually sends anything inside a 10-minute window around 8:00am
// Eastern (all staff are NY/FL), computed with Intl/America-New_York so DST
// shifts handle themselves rather than needing the cron schedule adjusted
// twice a year -- same pattern as check-call-quota. Joe's ask 2026-09-28:
// "we need a daily like 'you have these appointments today' to be sent to
// everyone at 8 am".
//
// Covers both kinds of scheduled contact: booked appointments (the
// appointments table, whether staff booked it or a client self-booked
// through the public link) and client-requested callbacks
// (leads.next_follow_up_at, set from the Log Call "Requested call back"
// flow) -- the same two sources send-appointment-reminders and
// send-callback-reminders already text people about individually as they
// come up; this is just the once-a-day "here's your whole day" version.
// Sends nothing to someone with an empty day rather than a pointless text.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CHECKPOINT_HOUR = 8;
const CHECKPOINT_MINUTE = 0;
const WINDOW_MINUTES = 10; // matches the cron cadence below

function easternNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10) % 24,
    minute: parseInt(get("minute"), 10),
  };
}

function easternTimeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

Deno.serve(async () => {
  const now = easternNow();
  const nowMinutes = now.hour * 60 + now.minute;
  const cpMinutes = CHECKPOINT_HOUR * 60 + CHECKPOINT_MINUTE;
  if (nowMinutes < cpMinutes || nowMinutes >= cpMinutes + WINDOW_MINUTES) {
    return new Response(JSON.stringify({ ok: true, skipped: "not_checkpoint_time" }), { headers: { "Content-Type": "application/json" } });
  }

  // Claim the whole day first (one digest per user per day) -- a conflict
  // here means this already ran today, so bail before doing any work.
  const { error: claimErr } = await sb.from("daily_schedule_sent").insert({ reminder_date: now.dateStr });
  if (claimErr) return new Response(JSON.stringify({ ok: true, skipped: "already_sent_today" }), { headers: { "Content-Type": "application/json" } });

  // Eastern-local "today" as a UTC range, so appointments/callbacks that
  // fall on today's Eastern calendar date are matched correctly regardless
  // of how close to midnight UTC we are. Computes Eastern's current UTC
  // offset from Intl rather than hardcoding -04:00/-05:00, so it's correct
  // on both sides of the DST switch without needing a manual update.
  const tzOffsetMs = (() => {
    const utcNow = new Date();
    const easternStr = utcNow.toLocaleString("en-US", { timeZone: "America/New_York" });
    const easternAsUtc = new Date(easternStr + " UTC");
    return utcNow.getTime() - easternAsUtc.getTime();
  })();
  const rangeStart = new Date(new Date(now.dateStr + "T00:00:00Z").getTime() + tzOffsetMs).toISOString();
  const rangeEnd = new Date(new Date(now.dateStr + "T00:00:00Z").getTime() + tzOffsetMs + 24 * 60 * 60 * 1000).toISOString();

  const { data: staff, error: staffErr } = await sb.from("users").select("id,name,phone")
    .in("role", ["loan_officer", "owner", "processor"]).neq("id", "demo").neq("id", "demo-processor");
  if (staffErr) return new Response(JSON.stringify({ error: staffErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  const { data: appts } = await sb.from("appointments").select("id,user_id,lead_id,name,phone,notes,start_at")
    .eq("status", "scheduled").gte("start_at", rangeStart).lt("start_at", rangeEnd);
  const { data: callbacks } = await sb.from("leads").select("id,name,phone,assigned_to,next_follow_up_at,next_follow_up_note")
    .eq("status", "active").not("next_follow_up_at", "is", null).gte("next_follow_up_at", rangeStart).lt("next_follow_up_at", rangeEnd);

  type Item = { at: string; label: string };
  const byUser: Record<string, Item[]> = {};
  for (const a of appts || []) {
    const uid = a.user_id as string;
    if (!byUser[uid]) byUser[uid] = [];
    const notesBit = a.notes ? (" — " + String(a.notes).slice(0, 100)) : "";
    byUser[uid].push({ at: a.start_at as string, label: easternTimeLabel(a.start_at as string) + " Appt: " + (a.name || "a client") + (a.phone ? (" (" + a.phone + ")") : "") + notesBit });
  }
  for (const c of callbacks || []) {
    const uid = (c.assigned_to as string) || "owner";
    if (!byUser[uid]) byUser[uid] = [];
    const noteBit = c.next_follow_up_note ? (" — " + String(c.next_follow_up_note).replace(/^Call back requested:?\s*/, "").slice(0, 100)) : "";
    byUser[uid].push({ at: c.next_follow_up_at as string, label: easternTimeLabel(c.next_follow_up_at as string) + " Call back: " + (c.name || "a client") + (c.phone ? (" (" + c.phone + ")") : "") + noteBit });
  }

  const sent: Array<Record<string, unknown>> = [];
  for (const u of staff || []) {
    const items = byUser[u.id as string];
    if (!items || !items.length) continue;
    items.sort((a, b) => a.at.localeCompare(b.at));
    const text = "Good morning! Today's schedule:\n" + items.map((i) => i.label).join("\n") + "\n" + CRM_URL;

    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: u.id, lead_id: null, kind: "daily-schedule",
      text: "Today's schedule: " + items.length + " item(s)", date: now.dateStr, read: false,
    });
    if (u.phone) {
      await fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: u.phone, text: text, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    sent.push({ userId: u.id, name: u.name, count: items.length, texted: !!u.phone });
  }

  return new Response(JSON.stringify({ ok: true, dateStr: now.dateStr, sent }), { headers: { "Content-Type": "application/json" } });
});
