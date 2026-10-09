// Instant call-connect for new leads (Joe 2026-10-09: "when a new lead comes in the LO's phone
// rings to connect, similar to how we set up the app phone system for the mobile app").
//
// A database trigger on public.leads (migration 095) calls this for every new lead. If it's a
// real inbound lead with a phone, assigned to an LO with a cell on file, and it's 8am-8pm
// Mon-Sat in the LO's own time zone, it starts the existing "call my cell first" flow
// (make-call sequential mode): the LO's cell rings from the company number, they hear
// "New Facebook lead: Maria, DSCR rental, Florida. Press 1 to call them now.", and pressing 1
// connects them to the borrower (voice-webhook). No key press = nothing reaches the borrower.
// One ring attempt per lead (lead_ring_log). Leads an LO typed in themselves never ring.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

// Inbound sources only -- never a file an LO created by hand or an import.
const RING_SOURCES = /^(Facebook|Meta Ads|Website|Connected Investors|Private ?Lenders)/i;
const STATE_NAMES: Record<string, string> = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"D C",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };
const LOAN_WORDS: Record<string, string> = { "DSCR":"D S C R rental", "Fix & Flip":"fix and flip", "Bridge":"bridge", "Ground Up Construction":"ground up construction", "Portfolio/Blanket":"portfolio", "Mixed-Use":"mixed use" };

function localNow(tz: string) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { dow: p.weekday, minutes: (+p.hour % 24) * 60 + +p.minute };
}

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const leadId = String(body.leadId || "");
  if (!leadId) return json({ error: "leadId required" }, 400);

  // Let the intake finish (assignment, notes) before reading the file.
  await new Promise((r) => setTimeout(r, 4000));
  const { data: lead } = await sb.from("leads").select("id,name,phone,source,status,stage,assigned_to,loan_type,property_address,first_attempt_at,automation_paused,preferred_language,created_at_ts").eq("id", leadId).maybeSingle();
  const skip = (why: string) => json({ ok: true, skipped: why });
  if (!lead) return skip("no_lead");
  if (!RING_SOURCES.test(String(lead.source || "")) || /referral partner/i.test(String(lead.source || ""))) return skip("source " + lead.source);
  // Only brand-new leads: a backfill/import of older form leads must never ring anyone.
  if (!lead.created_at_ts || Date.now() - new Date(lead.created_at_ts).getTime() > 15 * 60000) return skip("not_new");
  if (lead.status !== "active" || /^TEST/i.test(String(lead.name || ""))) return skip("not_active_or_test");
  if (!lead.phone || String(lead.phone).replace(/\D/g, "").length < 10) return skip("no_phone");
  if (lead.first_attempt_at) return skip("already_called");
  if (!lead.assigned_to) return skip("unassigned");

  const { data: staff } = await sb.from("users").select("id,name,phone").eq("id", lead.assigned_to).maybeSingle();
  if (!staff || !staff.phone) return skip("lo_has_no_cell");
  const { data: rule } = await sb.from("availability_rules").select("timezone").eq("user_id", staff.id).limit(1);
  const tz = (rule && rule[0] && rule[0].timezone) || "America/New_York";
  const t = localNow(tz);
  if (t.dow === "Sun" || t.minutes < 8 * 60 || t.minutes >= 20 * 60) return skip("outside_hours " + tz);

  // One ring per lead, ever.
  const { error: claimErr } = await sb.from("lead_ring_log").insert({ lead_id: leadId, user_id: staff.id });
  if (claimErr) return skip("already_rang");

  const first = String(lead.name || "a new lead").trim().split(/\s+/)[0];
  const src = /^Facebook/i.test(lead.source) ? "Spanish Facebook" : /^Meta Ads/i.test(lead.source) ? "Facebook" : /^Website/i.test(lead.source) ? "website" : /^Connected/i.test(lead.source) ? "Connected Investors" : "new";
  const st = (String(lead.property_address || "").match(/\b([A-Z]{2})\b(?:\s+\d{5})?(?:,\s*USA)?\s*$/) || [])[1];
  const announce = "New " + src + " lead: " + first + (lead.loan_type ? ", " + (LOAN_WORDS[lead.loan_type] || lead.loan_type) : "") + (st && STATE_NAMES[st] ? ", " + STATE_NAMES[st] : "") + ".";

  const res = await fetch(SUPABASE_URL + "/functions/v1/make-call", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
    body: JSON.stringify({ leadId, userId: staff.id, announce }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  await sb.from("lead_ring_log").update({ result: JSON.stringify(res).slice(0, 300) }).eq("lead_id", leadId);
  const { data: l2 } = await sb.from("leads").select("activity").eq("id", leadId).maybeSingle();
  const act = ((l2 && l2.activity) as unknown[]) || [];
  act.push({ date: new Date().toISOString().slice(0, 10), type: "system", author: "System", text: res && (res as any).ok ? "Auto-rang " + staff.name + "'s cell to connect with this new lead (press 1 to call)." : "Tried to auto-ring " + staff.name + " for this new lead but the call couldn't be placed." });
  await sb.from("leads").update({ activity: act }).eq("id", leadId);
  return json({ ok: true, rang: staff.id, announce, result: res });
});
