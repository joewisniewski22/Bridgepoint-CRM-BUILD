// Friday-evening "Application Sent" check for Joe (2026-10-17: 41 files were stuck in Application Sent; deadline Fri 10/23).
// Compares today against the baseline saved in appsent_baseline (the 41 files as of 10/17): per loan officer, how many moved forward,
// moved back, were closed out (lost/cold), or are STILL stuck -- plus any NEW file that has been sitting in Application Sent more than 2 days.
// Runs from pg_cron every 10 minutes and only sends Fridays 6:00-6:10pm Eastern, once per day (ledger = lead_handoff_alerts).
// Sends nothing once nothing is stuck. Email only -- Joe does not want extra texts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const ORDER = ["new", "attempting", "qualifying", "app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
const LABEL: Record<string, string> = { new: "New Lead", attempting: "Attempting Contact", qualifying: "Contacted / Qualifying", app_sent: "Application Sent", app_completed: "Application Completed", docs: "Docs Collection", processing: "Processing", underwriting: "Underwriting", approved: "Conditional Approval", ctc: "Clear to Close", closed: "Closed / Funded", postclosing: "Post-Closing" };

function easternNow() {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { date: p.year + "-" + p.month + "-" + p.day, minutes: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday };
}
function daysSince(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null;
  const a = new Date(String(iso).slice(0, 10) + "T12:00:00Z").getTime(), b = new Date(today + "T12:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}
function prettyDate(iso: string) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* cron sends a small JSON body */ }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(auth && body.secret === auth.secret) && bearer !== SERVICE_KEY) return json({ error: "not_authorized" }, 403);

  const now = easternNow();
  const force = body.force === true;
  if (!force && !(now.weekday === "Fri" && now.minutes >= 18 * 60 && now.minutes < 18 * 60 + 10)) return json({ ok: true, skipped: "not report time" });
  if (!force) {
    const { error } = await sb.from("lead_handoff_alerts").insert({ lead_id: "appsent-report", kind: now.date });
    if (error) return json({ ok: true, skipped: "already sent today" });
  }

  const { data: base } = await sb.from("appsent_baseline").select("*");
  const baseline = (base || []) as Array<{ lead_id: string; lead_name: string; lo_id: string; lo_name: string; snapshot_date: string }>;
  const snapDate = baseline[0] ? String(baseline[0].snapshot_date).slice(0, 10) : "2026-10-17";
  const baseIds = baseline.map((b) => b.lead_id);
  const { data: curRows } = await sb.from("leads").select("id,name,stage,status,assigned_to,application_sent_at,created_at").in("id", baseIds.length ? baseIds : ["-"]);
  const cur: Record<string, any> = {};
  (curRows || []).forEach((l: any) => { cur[l.id] = l; });

  const { data: users } = await sb.from("users").select("id,name");
  const userName: Record<string, string> = {};
  (users || []).forEach((u: any) => { userName[u.id] = u.name; });

  // Every active Application Sent file NOT in the baseline that has sat more than 2 days.
  const { data: allApp } = await sb.from("leads").select("id,name,assigned_to,application_sent_at,created_at").eq("stage", "app_sent").eq("status", "active");
  const newStuck = (allApp || []).filter((l: any) => !baseIds.includes(l.id) && !String(l.id).startsWith("LDEMO"))
    .map((l: any) => ({ ...l, days: daysSince(l.application_sent_at || l.created_at, now.date) }))
    .filter((l: any) => (l.days ?? 0) > 2);

  const byLo: Record<string, { name: string; moved: string[]; back: string[]; closed: string[]; stuck: Array<{ name: string; days: number }>; total: number }> = {};
  for (const b of baseline) {
    const key = b.lo_id;
    const g = byLo[key] || (byLo[key] = { name: b.lo_name, moved: [], back: [], closed: [], stuck: [], total: 0 });
    g.total++;
    const c = cur[b.lead_id];
    if (!c) { g.closed.push(b.lead_name + " (removed)"); continue; }
    if (c.status !== "active") { g.closed.push(c.name + " (" + c.status + ")"); continue; }
    const si = ORDER.indexOf(c.stage), ai = ORDER.indexOf("app_sent");
    if (si > ai) g.moved.push(c.name + " -> " + (LABEL[c.stage] || c.stage));
    else if (si >= 0 && si < ai) g.back.push(c.name + " -> " + (LABEL[c.stage] || c.stage));
    else g.stuck.push({ name: c.name, days: daysSince(c.application_sent_at || c.created_at, now.date) ?? 0 });
  }

  const totals = { total: baseline.length, moved: 0, back: 0, closed: 0, stuck: 0 };
  Object.values(byLo).forEach((g) => { totals.moved += g.moved.length; totals.back += g.back.length; totals.closed += g.closed.length; totals.stuck += g.stuck.length; });
  const stillOver2 = Object.values(byLo).reduce((n, g) => n + g.stuck.filter((s) => s.days > 2).length, 0) + newStuck.length;
  if (!force && totals.stuck === 0 && newStuck.length === 0) return json({ ok: true, skipped: "nothing stuck - report retired" });

  const lines: string[] = [];
  lines.push("Application Sent - check-in for " + prettyDate(now.date));
  lines.push("");
  lines.push("On " + prettyDate(snapDate) + " there were " + totals.total + " files in Application Sent. Today:");
  lines.push("  - Still in Application Sent: " + totals.stuck + " (" + stillOver2 + " older than 2 days, including " + newStuck.length + " new since then)");
  lines.push("  - Moved forward (Application Completed or beyond): " + totals.moved);
  lines.push("  - Moved back to an earlier stage: " + totals.back);
  lines.push("  - Closed out (lost / cold / removed): " + totals.closed);
  const order = ["owner", "lo-fanis", "lo-fiore", "lo-taeya", "lo-theresa"];
  const keys = Object.keys(byLo).sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
  for (const k of keys) {
    const g = byLo[k];
    lines.push("");
    lines.push(g.name.toUpperCase() + " - started with " + g.total + ": " + g.moved.length + " moved forward, " + g.back.length + " moved back, " + g.closed.length + " closed out, " + g.stuck.length + " still stuck");
    g.stuck.sort((a, b) => b.days - a.days).forEach((s) => lines.push("   STILL STUCK: " + s.name + " (" + s.days + " days)"));
    g.moved.forEach((s) => lines.push("   moved: " + s));
    g.back.forEach((s) => lines.push("   moved back: " + s));
    g.closed.forEach((s) => lines.push("   closed out: " + s));
  }
  const nb = newStuck.sort((a: any, b: any) => (b.days ?? 0) - (a.days ?? 0));
  if (nb.length) {
    lines.push("");
    lines.push("NEW since " + prettyDate(snapDate) + " and already sitting more than 2 days:");
    nb.forEach((l: any) => lines.push("   " + l.name + " (" + (userName[l.assigned_to] || l.assigned_to) + ", " + l.days + " days)"));
  }
  lines.push("");
  lines.push("Sent automatically every Friday at 6pm ET until nothing is left in Application Sent.");

  const subject = (force ? "[Preview] " : "") + "Application Sent check-in: " + totals.stuck + " of " + totals.total + " still stuck (" + prettyDate(now.date) + ")";
  const r = await fetch(SUPABASE_URL + "/functions/v1/send-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_KEY },
    body: JSON.stringify({ to: "joe@bplending.com", subject, text: lines.join("\n"), fromName: "Bridgepoint CRM", fromAddress: "joe@bplending.com", fromUserId: "owner" }),
  });
  return json({ ok: r.ok, status: r.status, totals, stillOver2, newStuck: newStuck.length });
});
