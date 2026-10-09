// 5-minute lead handoff (Joe 2026-10-09). Cron runs this every minute.
//
// Joe's rules, as he gave them:
// - Daytime (9am-10pm ET, every day): a new inbound lead goes to the rotation LO and their phone
//   rings (new-lead-ring). If they don't pick up and press 1, or call the lead themselves, within
//   5 minutes, the lead moves to the next LO on the list, whose phone rings, and so on. If nobody
//   in the pool calls it, it lands with Joe and he gets a text.
//     English Facebook / website pool: Joe, Fiore, Taeya, Theresa (Joe 30%, the rest split 70%).
//     Connected Investors / PrivateLenders pool: Joe and Fiore (50/50); if both miss it, it goes
//     to Taeya / Theresa / Fanis on a rotation, then back to Joe as the last stop.
// - Overnight (10pm-9am ET): the lead stays with the LO it was given to -- "not fair to take a lead
//   cause it came over in middle of night". At 9am their phone rings for it; if it still hasn't
//   been called by noon, Joe gets a text (alert only, nothing moves).
// - Language leads (Spanish -> Fanis) never move. If Fanis hasn't called a daytime one in 15
//   minutes, Joe gets a text.
// "Called" means a real dial to the borrower (leads.lo_dialed_at, set on press-1 / in-app call /
// direct dial, or a call the LO logged) -- a text doesn't count.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

// Leads that came in before this went live are never moved.
const HANDOFF_START = "2026-10-09T18:30:00Z";
const WINDOW_MS = 5 * 60000;
const DAY_START = 9 * 60, DAY_END = 22 * 60; // ET minutes
const POOLS: Record<string, string[]> = {
  english: ["owner", "lo-fiore", "lo-taeya", "lo-theresa"],
  ci: ["owner", "lo-fiore"],
};
// Joe 10/9: "if me and fiore miss our window ... have it go out to entire team on a rotation"
// -- a Connected Investors lead both of them missed goes to the other LOs (any language; they
// all speak English), same 5-minute rule, rotating who goes first.
const OVERFLOW: Record<string, string[]> = { ci: ["lo-taeya", "lo-theresa", "lo-fanis"] };
const INBOUND = /^(Facebook|Meta Ads|Website|Connected Investors|Private ?Lenders)/i;

function et(d: Date) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { date: p.year + "-" + p.month + "-" + p.day, minutes: (+p.hour % 24) * 60 + +p.minute, seconds: +p.second };
}
const isDay = (m: number) => m >= DAY_START && m < DAY_END;
function poolOf(l: any): string | null {
  const src = String(l.source || "");
  if (l.preferred_language === "es" || /^Facebook$/i.test(src)) return null; // language lead: pinned
  if (/^(Connected Investors|Private ?Lenders)/i.test(src)) return "ci";
  if (/^(Meta Ads|Website)/i.test(src)) return "english";
  return null;
}
function dialed(l: any): boolean {
  if (l.lo_dialed_at) return true;
  // Any logged call counts, except texts and the auto-ring the LO themselves didn't pick up.
  return ((l.call_attempts || []) as any[]).some((a) => a && a.outcome && a.outcome !== "texted" && !/went unanswered before reaching/i.test(String(a.notes || "")));
}

const staffCache: Record<string, any> = {};
async function staff(id: string) {
  if (!(id in staffCache)) {
    const { data } = await sb.from("users").select("id,name,phone,email,out_date").eq("id", id).maybeSingle();
    staffCache[id] = data || null;
  }
  return staffCache[id];
}
async function textStaff(id: string, text: string, leadId: string | null) {
  if (DRY) return;
  const u = await staff(id);
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: id, lead_id: leadId, kind: "hot-lead", text, date: new Date().toISOString().slice(0, 10), read: false });
  if (u && u.phone) {
    await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ to: u.phone, text, fromName: "Bridgepoint CRM" }) }).catch(() => null);
  }
}
async function ring(leadId: string, reason: string) {
  if (DRY) return { dry: true };
  return await fetch(SUPABASE_URL + "/functions/v1/new-lead-ring", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadId, secret: SECRET, handoff: true, reason }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
}
async function once(leadId: string, kind: string) {
  if (DRY) return true;
  const { error } = await sb.from("lead_handoff_alerts").insert({ lead_id: leadId, kind });
  return !error;
}
async function note(leadId: string, text: string, assignTo?: string) {
  if (DRY) return;
  const { data } = await sb.from("leads").select("activity").eq("id", leadId).maybeSingle();
  const activity = ((data && data.activity) as unknown[]) || [];
  activity.push({ date: new Date().toISOString().slice(0, 10), at: new Date().toISOString(), type: "system", author: "System", text });
  const patch: Record<string, unknown> = { activity };
  if (assignTo) patch.assigned_to = assignTo;
  await sb.from("leads").update(patch).eq("id", leadId);
}

let SECRET = "";
// dryRun: decide everything, change nothing (includes TEST leads, so a test file can be walked through).
let DRY = false;

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* */ }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  SECRET = auth.secret as string;
  DRY = body.dryRun === true;

  const now = new Date();
  const t = et(now);
  const day = isDay(t.minutes);
  // Today's 9:00am ET as an instant.
  const nineAm = new Date(now.getTime() - ((t.minutes - DAY_START) * 60 + t.seconds) * 1000);
  const since = new Date(Math.max(DRY ? 0 : Date.parse(HANDOFF_START), now.getTime() - 36 * 3600000)).toISOString();

  const { data: leads } = await sb.from("leads")
    .select("id,name,phone,source,status,assigned_to,preferred_language,created_at_ts,lo_dialed_at,call_attempts,next_follow_up_at")
    .gte("created_at_ts", since).eq("status", "active");
  const ids = (leads || []).map((l: any) => l.id);
  const { data: rows } = ids.length ? await sb.from("lead_handoff").select("*").in("lead_id", ids) : { data: [] as any[] };
  const byId: Record<string, any> = {};
  (rows || []).forEach((r: any) => { byId[r.lead_id] = r; });
  const log: unknown[] = [];

  for (const l of (leads || []) as any[]) {
    const src = String(l.source || "");
    if (!INBOUND.test(src) || /referral partner/i.test(src) || (!DRY && /^TEST/i.test(String(l.name || "")))) continue;
    if (!l.phone || String(l.phone).replace(/\D/g, "").length < 10 || !l.assigned_to || !l.created_at_ts) continue;
    // An LO set a later callback (e.g. "don't call until Monday") -- leave it alone.
    if (l.next_follow_up_at && new Date(l.next_follow_up_at) > now) continue;
    const created = new Date(l.created_at_ts);
    const createdDay = isDay(et(created).minutes);
    const pool = poolOf(l);
    const first = String(l.name || "a lead").trim().split(/\s+/)[0];
    const link = CRM_URL + "?lead=" + l.id;
    let row = byId[l.id];

    if (dialed(l)) {
      if (row && row.status === "watching" && !DRY) await sb.from("lead_handoff").update({ status: "worked", updated_at: now.toISOString() }).eq("lead_id", l.id);
      continue;
    }

    // Leads that waited overnight (or stalled past 10pm): ring the LO at 9am, alert Joe at noon.
    if (day && created < nineAm) {
      if (await once(l.id, "morning-" + t.date)) {
        const r = await ring(l.id, "morning");
        log.push({ lead: l.id, morningRing: r });
      }
      if (t.minutes >= 12 * 60 && await once(l.id, "noon-" + t.date)) {
        const lo = await staff(l.assigned_to);
        await textStaff("owner", "Heads up: overnight lead " + l.name + " (" + (lo ? lo.name : l.assigned_to) + ") still hasn't been called. " + link, l.id);
        log.push({ lead: l.id, noonAlert: true });
      }
      continue;
    }

    // Spanish / language leads never move -- Joe gets a text if a daytime one sits 15 minutes.
    if (!pool) {
      if (day && createdDay && now.getTime() - created.getTime() >= 15 * 60000 && await once(l.id, "lang15")) {
        const lo = await staff(l.assigned_to);
        await textStaff("owner", "Heads up: " + (lo ? lo.name : l.assigned_to) + " hasn't called new lead " + l.name + " in 15 min. " + link, l.id);
        log.push({ lead: l.id, lang15: true });
      }
      continue;
    }

    // The 5-minute handoff -- only for leads that came in during the day.
    if (!createdDay) continue;
    if (!row) {
      row = { lead_id: l.id, pool, first_lo: l.assigned_to, tried: [l.assigned_to], clock_start: l.created_at_ts, moves: 0, status: "watching" };
      const { error } = DRY ? { error: null } : await sb.from("lead_handoff").insert(row);
      if (error) continue; // another run got it
    }
    if (row.status !== "watching") continue;
    if (!day) { // hit 10pm without a call: it stays where it is (morning ring picks it up)
      if (!DRY) await sb.from("lead_handoff").update({ status: "night", updated_at: now.toISOString() }).eq("lead_id", l.id);
      continue;
    }
    if (now.getTime() - new Date(row.clock_start).getTime() < WINDOW_MS) continue;

    const list = POOLS[row.pool] || POOLS.english;
    const tried: string[] = row.tried || [];
    const cur = l.assigned_to;
    const start = Math.max(0, list.indexOf(cur));
    let next: string | null = null;
    for (let i = 1; i <= list.length; i++) {
      const cand = list[(start + i) % list.length];
      // LOs marked "out today" are skipped (Joe as the last stop never is).
      const u = await staff(cand);
      if (!tried.includes(cand) && !(u && u.out_date === t.date)) { next = cand; break; }
    }
    if (!next && OVERFLOW[row.pool]) {
      const open: string[] = [];
      for (const cand of OVERFLOW[row.pool]) {
        const u = await staff(cand);
        if (!tried.includes(cand) && !(u && u.out_date === t.date)) open.push(cand);
      }
      if (open.length) {
        // Rotate: whoever has received the fewest overflow leads goes first.
        const { data: got } = await sb.from("rotation_picks").select("lo").eq("pool", row.pool + "-overflow").in("lo", open);
        const n: Record<string, number> = {};
        (got || []).forEach((g: any) => { n[g.lo] = (n[g.lo] || 0) + 1; });
        open.sort((a, b) => (n[a] || 0) - (n[b] || 0));
        next = open[0];
      }
    }
    let finalStop = false;
    if (!next) { finalStop = true; next = cur === "owner" ? null : "owner"; }

    // Claim the move (a slow earlier run can't double-move it).
    const { data: claimed } = DRY ? { data: [{ lead_id: l.id }] } : await sb.from("lead_handoff").update({
      tried: next && !tried.includes(next) ? [...tried, next] : tried, clock_start: now.toISOString(), moves: row.moves + 1,
      status: finalStop ? "final" : "watching", updated_at: now.toISOString(),
    }).eq("lead_id", l.id).eq("moves", row.moves).select("lead_id");
    if (!claimed || !claimed.length) continue;

    const from = await staff(cur);
    const fromName = from ? from.name : cur;
    if (!next) {
      await note(l.id, "No one in the rotation called this lead within 5 minutes; it stays with " + fromName + ".");
      await textStaff("owner", "Nobody called new lead " + l.name + " -- it's yours. Call now: " + link, l.id);
      log.push({ lead: l.id, final: "owner_kept" });
      continue;
    }
    const to = await staff(next);
    const toName = to ? to.name : next;
    await note(l.id, "Not called within 5 minutes by " + fromName + " -- automatically passed to " + toName + (finalStop ? " (last stop)." : "."), next);
    await textStaff(cur, "Lead " + l.name + " was passed to " + toName + " -- not called within 5 minutes.", l.id);
    await textStaff(next, (finalStop ? "Nobody else called " : "Passed to you: ") + l.name + (finalStop ? " -- it's yours now. " : " wasn't called in 5 min. Call " + first + " now: ") + link, l.id);
    if (!DRY) {
      // The receiver's share counts this lead; the LO who missed it keeps theirs (Joe 10/9: missing leads costs you leads).
      const overflow = (OVERFLOW[row.pool] || []).includes(next);
      await sb.from("rotation_picks").insert({ pool: overflow ? row.pool + "-overflow" : row.pool, lo: next, kind: "handoff", lead_id: l.id });
      // Any meeting the borrower already booked moves to the new LO's calendar.
      await sb.from("appointments").update({ user_id: next }).eq("lead_id", l.id).eq("status", "scheduled").gt("start_at", now.toISOString());
    }
    const r = await ring(l.id, "handoff");
    log.push({ lead: l.id, from: cur, to: next, final: finalStop, ring: r });
  }
  return json({ ok: true, day, et: t, actions: log });
});
