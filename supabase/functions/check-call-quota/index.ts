// Runs every 15 minutes via pg_cron. Almost every tick is a no-op --
// it only actually does anything inside a 15-minute window around each
// checkpoint (2:00pm and 4:30pm Eastern, all staff are NY/FL), computed
// with Intl/America-New_York so DST shifts handle themselves rather than
// needing the cron schedule adjusted twice a year. Real accountability,
// not a badge someone can ignore: any LO (owner included) short of the
// checkpoint's threshold gets a real text, deduped per (user, date,
// checkpoint) so retries/overlap can never double-send.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DAILY_CALL_QUOTA = 20;
const WINDOW_MINUTES = 15; // matches the cron cadence below

type Checkpoint = { key: string; hour: number; minute: number; threshold: number; message: (count: number) => string };
const CHECKPOINTS: Checkpoint[] = [
  {
    key: "midday", hour: 14, minute: 0, threshold: 10,
    message: (count) => `Bridgepoint: you're at ${count} of ${DAILY_CALL_QUOTA} calls today. Keep the pace up to hit quota by end of day.`,
  },
  {
    key: "eod", hour: 16, minute: 30, threshold: DAILY_CALL_QUOTA,
    message: (count) => `Bridgepoint: you're at ${count} of ${DAILY_CALL_QUOTA} calls today with the day winding down. Log into the CRM and knock out a few more from your queue.`,
  },
];

function easternNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10) % 24,
    minute: parseInt(get("minute"), 10),
    weekday: get("weekday"),
  };
}

Deno.serve(async () => {
  const now = easternNow();
  if (now.weekday === "Sat" || now.weekday === "Sun") {
    return new Response(JSON.stringify({ ok: true, skipped: "weekend" }), { headers: { "Content-Type": "application/json" } });
  }

  const nowMinutes = now.hour * 60 + now.minute;
  const due = CHECKPOINTS.find((cp) => {
    const cpMinutes = cp.hour * 60 + cp.minute;
    return nowMinutes >= cpMinutes && nowMinutes < cpMinutes + WINDOW_MINUTES;
  });
  if (!due) {
    return new Response(JSON.stringify({ ok: true, skipped: "no_checkpoint_due" }), { headers: { "Content-Type": "application/json" } });
  }

  // call_attempts dates are stamped client-side via todayISO(), which is
  // toISOString().slice(0,10) -- a UTC calendar date, not Eastern-local.
  // At both checkpoint hours (2pm/4:30pm ET) that's still the same
  // calendar day as Eastern, so matching on today's real UTC date here is
  // safe and correct without needing a separate date-matching scheme.
  const todayUtc = new Date().toISOString().slice(0, 10);

  const { data: staff, error: staffErr } = await sb.from("users").select("id,name,phone")
    .in("role", ["loan_officer", "owner"]).neq("id", "demo").neq("id", "demo-processor");
  if (staffErr) return new Response(JSON.stringify({ error: staffErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  const { data: leads, error: leadsErr } = await sb.from("leads").select("assigned_to,status,stage,call_attempts");
  if (leadsErr) return new Response(JSON.stringify({ error: leadsErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  // The 20/day quota is new-business potential only (new-lead cadence,
  // cold/lost win-back, closed-client referral asks) -- a call logged on a
  // loan already in progress (app_sent and beyond) doesn't count here,
  // matching index.html's isNewBusinessLead().
  const CADENCE_STAGES = ["new", "attempting", "qualifying"];
  function isNewBusinessLead(l: Record<string, unknown>): boolean {
    const status = l.status as string;
    if (status === "cold" || status === "lost" || status === "closed") return true;
    if (status === "active" && CADENCE_STAGES.includes(l.stage as string)) return true;
    return false;
  }

  const callsByUser: Record<string, number> = {};
  (leads || []).forEach((l) => {
    const assignedTo = l.assigned_to as string | null;
    if (!assignedTo || !isNewBusinessLead(l)) return;
    const attempts = Array.isArray(l.call_attempts) ? (l.call_attempts as Array<Record<string, unknown>>) : [];
    const todays = attempts.filter((a) => a.date === todayUtc).length;
    if (todays) callsByUser[assignedTo] = (callsByUser[assignedTo] || 0) + todays;
  });

  const sent: Array<Record<string, unknown>> = [];
  for (const u of staff || []) {
    const count = callsByUser[u.id as string] || 0;
    if (count >= due.threshold) continue;

    // Atomic dedup via the table's primary key -- a conflict here means
    // this checkpoint already fired for this user today, so skip silently.
    const { error: insertErr } = await sb.from("call_quota_reminders").insert({
      user_id: u.id, reminder_date: now.dateStr, checkpoint: due.key,
    });
    if (insertErr) continue;

    if (u.phone) {
      await fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: u.phone, text: due.message(count), fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    sent.push({ userId: u.id, name: u.name, count, checkpoint: due.key, texted: !!u.phone });
  }

  return new Response(JSON.stringify({ ok: true, checkpoint: due.key, easternTime: `${now.hour}:${String(now.minute).padStart(2, "0")}`, sent }), { headers: { "Content-Type": "application/json" } });
});
