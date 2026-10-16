// Reads what staff type about a client (call notes, live notes, file notes) and does something with it (Joe 2026-10-16: "when notes are
// entered on a call, system wide, they need to be scanned and implemented into follow-ups -- and the AI should learn from the notes for custom
// communication with the clients and LOs"). Staff only (or a server job with the service key).
//   1. FOLLOW-UPS: dates/times and promised actions in the note become real follow-up tasks for the file's loan officer (the same tasks the LO
//      scheduler makes: the engine texts the LO when due). Said-outright times are exact; implied ones ("waiting on docs") are marked inferred.
//   2. INSIGHTS: durable facts (preferences, objections, timeline, issues, commitments, suggested deal updates) are saved to lead_insights so the
//      call briefs, borrower texts/emails and the AI assistant know them next time.
// It never changes loan fields, never texts or emails the borrower, and reads each note exactly once (note_scan_log).
//   POST { leadId, source: "call"|"note", notes, outcome?, by?, at? }  -> scan one note now (the CRM calls this when a call is logged)
//   POST { sweep: true }                                               -> catch-all: scan recent notes nobody has scanned (called every few minutes by followup-engine)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-sonnet-5-5";
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const TZ = "America/New_York";

function hash(s: string): string { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function etDate(d = new Date()): string { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function etWeekday(d = new Date()): string { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(d); }
// "YYYY-MM-DD" + hour/minute in New York time -> a real instant.
function etToMs(date: string, hh: number, mm: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm);
  for (const off of [4, 5]) {
    const t = base + off * 3600000;
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(t)).replace(/\D/g, "")) % 24;
    if (h === hh) return t;
  }
  return base + 4 * 3600000;
}
function addDaysStr(date: string, n: number): string { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function weekdayOf(date: string): number { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function nextBusinessDay(date: string): string { let x = date; while ([0, 6].includes(weekdayOf(x))) x = addDaysStr(x, 1); return x; }
function label(ms: number): string { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)); }

const SYSTEM = "You read a loan officer's (or processor's) typed note about a client of Bridgepoint Lending (business-purpose real estate investor loans only) and pull out what the system should DO and REMEMBER. " +
  "Use ONLY what is in the note and the file facts. Never invent facts, numbers, names, dates or promises. If the note doesn't say it, leave it out. " +
  "Output ONLY valid JSON, no markdown fences, with exactly these keys:\n" +
  "\"followups\": array (max 3) of {\"title\": short action e.g. \"Call back about the ARV\", \"channel\": \"call\"|\"text\"|\"email\", \"date\": \"YYYY-MM-DD\" or null, \"time\": \"HH:MM\" 24h Eastern or null, \"when_text\": the exact words from the note that set the timing, or null, \"kind\": \"explicit\" (the note states a day/date/time, including relative ones like 'Thursday', 'tomorrow', 'in two weeks', 'after the 15th' -- resolve them yourself from today's date) or \"inferred\" (the note implies a next action with no timing: e.g. 'waiting on his bank statements' -> check in on them; 'will send him the term sheet' -> send it), \"reason\": one short sentence}. " +
  "Only include a follow-up when the note really implies one. A plain 'left voicemail' / 'no answer' with no purpose stated is NOT a follow-up (the normal call cadence already retries). BUT a voicemail, message or call that raises a specific problem, question or request the client still has to answer or fix (e.g. 'left voicemail about the ARV being lower than price plus rehab', 'asked him for the bank statements') IS an inferred follow-up: title it around getting THAT specific thing resolved. Do not repeat the same action twice.\n" +
  "\"insights\": array (max 6) of {\"kind\": \"preference\" (how/when they like to be contacted, language, communication style), \"personal\" (personal details they shared that help rapport), \"objection\" (a concern or reason they hesitate), \"timeline\" (when they need to close/fund, deadlines), \"deal_fact\" (a fact about the deal or property they told us), \"issue\" (a problem with the file or numbers, e.g. a likely typo or inconsistency, a missing item, a credit/title/appraisal problem), \"commitment\" (something WE promised them, or they promised us, with the date if stated), \"sentiment\" (how ready or frustrated they sound), \"deal_update\" (a CHANGE the note says should be made to the file's numbers or details -- state it plainly, e.g. 'ARV should be $X'; this is only a suggestion), \"text\": one short plain sentence (max 160 chars)}. Only durable, useful facts.\n" +
  "\"temperature\": \"hot\"|\"warm\"|\"cold\"|null.";

async function ai(model: string, prompt: string): Promise<any | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 900, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  const text = String(((data && data.content) || []).map((c: any) => c.text || "").join("")).replace(/^```(?:json)?|```$/g, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_e) { return null; }
}

type Note = { leadId: string; source: "call" | "note"; notes: string; outcome?: string; by?: string; at?: string };

async function scanOne(n: Note): Promise<Record<string, unknown>> {
  const notes = String(n.notes || "").trim().slice(0, 4000);
  if (notes.length < 12) return { ok: true, skipped: "too_short" };
  const key = (n.source === "call" ? "c:" : "n:") + n.leadId + ":" + hash(notes);
  const { data: seen } = await sb.from("note_scan_log").select("key").eq("key", key).maybeSingle();
  if (seen) return { ok: true, skipped: "already_scanned" };

  const { data: lead } = await sb.from("leads").select("id,name,loan_type,stage,status,assigned_to,property_address,loan_amount,purchase_price,arv,rehab_budget,current_value,rate,credit_score,activity,preferred_language").eq("id", n.leadId).maybeSingle();
  if (!lead) return { ok: false, error: "lead_not_found" };
  const today = etDate();
  const facts = [lead.name, lead.loan_type, "stage " + lead.stage, lead.property_address, lead.purchase_price && ("price $" + lead.purchase_price), lead.rehab_budget && ("rehab $" + lead.rehab_budget), lead.arv && ("ARV $" + lead.arv),
    lead.current_value && ("value $" + lead.current_value), lead.loan_amount && ("loan $" + lead.loan_amount), lead.rate && ("rate " + lead.rate + "%"), lead.credit_score && ("credit " + lead.credit_score)].filter(Boolean).join(" | ");
  const prompt = "Today is " + etWeekday() + " " + today + " (Eastern time).\nNote written by: " + (n.by || "staff") + (n.outcome ? ("\nCall outcome logged: " + n.outcome) : "") + "\nFile: " + facts + "\n\nNote:\n" + notes;
  const out = (await ai(MODEL, prompt)) || (await ai(FALLBACK_MODEL, prompt));
  if (!out) return { ok: false, error: "ai_unavailable" };   // not logged as scanned, so the sweep retries it

  const now = Date.now();
  const created: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  const assignee = lead.assigned_to || n.by || "owner";
  const { data: openTasks } = await sb.from("followup_tasks").select("due_at").eq("lead_id", n.leadId).eq("status", "open");
  const openMs = (openTasks || []).map((t: any) => new Date(t.due_at).getTime());

  let i = 0;
  for (const f of (Array.isArray(out.followups) ? out.followups : []).slice(0, 3)) {
    i++;
    const title = String(f.title || "").trim().slice(0, 120);
    if (!title) continue;
    const channel = ["call", "text", "email"].includes(f.channel) ? f.channel : "call";
    const explicit = f.kind === "explicit" && /^\d{4}-\d{2}-\d{2}$/.test(String(f.date || ""));
    let date = explicit ? String(f.date) : "";
    if (explicit && (date < today || date > addDaysStr(today, 150))) { skipped.push("date out of range: " + title); continue; }
    if (!date) date = (f.kind === "inferred" && /wait|pending|collect|from (him|her|them)|send(s|ing)? (us|me)/i.test(String(f.reason || "") + " " + String(f.title || ""))) ? addDaysStr(today, 3) : addDaysStr(today, 1);
    date = nextBusinessDay(date);
    let hh = 10, mm = 0;
    if (/^\d{1,2}:\d{2}$/.test(String(f.time || ""))) { const [a, b] = String(f.time).split(":").map(Number); if (a >= 8 && a <= 19) { hh = a; mm = b; } }
    let dueMs = etToMs(date, hh, mm);
    if (dueMs < now + 15 * 60000) dueMs = now + 60 * 60000;      // a time that has already passed today -> an hour from now
    if (openMs.some((m: number) => Math.abs(m - dueMs) < 6 * 3600000)) { skipped.push("already have a follow-up near that time: " + title); continue; }
    const row = {
      lead_id: n.leadId, assigned_to: assignee, situation: "scheduled", step_key: "note:" + hash(key) + ":" + i, step_n: 0, channel,
      title: title + " — " + String(lead.name).split(" ")[0], goal: String(f.reason || title).slice(0, 240),
      lever: f.when_text ? ("From the note: “" + String(f.when_text).slice(0, 120) + "”") : "Pulled from the note you wrote after the last call.",
      due_at: new Date(dueMs).toISOString(), priority: 80, urgent: false, status: "open",
      meta: { manual: true, source: "note-scan", inferred: f.kind !== "explicit", phrase: f.when_text || null, noteKey: key, by: n.by || null },
    };
    const { data: ins, error } = await sb.from("followup_tasks").insert(row).select("id").single();
    if (error) { skipped.push("couldn't save: " + title); continue; }
    openMs.push(dueMs);
    created.push({ id: ins.id, title: row.title, channel, dueAt: row.due_at, label: label(dueMs), inferred: f.kind !== "explicit" });
  }

  const KINDS = ["preference", "personal", "objection", "timeline", "deal_fact", "issue", "commitment", "sentiment", "deal_update"];
  const { data: have } = await sb.from("lead_insights").select("kind,text").eq("lead_id", n.leadId).eq("active", true);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const haveSet = new Set((have || []).map((h: any) => h.kind + "|" + norm(h.text)));
  const insights: Array<Record<string, unknown>> = [];
  for (const x of (Array.isArray(out.insights) ? out.insights : []).slice(0, 6)) {
    const kind = KINDS.includes(x.kind) ? x.kind : "deal_fact", text = String(x.text || "").trim().slice(0, 200);
    if (!text || haveSet.has(kind + "|" + norm(text))) continue;
    haveSet.add(kind + "|" + norm(text));
    insights.push({ lead_id: n.leadId, kind, text, source_key: key, source_by: n.by || null, source_at: n.at || new Date().toISOString(), meta: { source: n.source } });
  }
  if (insights.length) await sb.from("lead_insights").insert(insights);

  await sb.from("note_scan_log").upsert({ key, lead_id: n.leadId, result: { followups: created.length, insights: insights.length, temperature: out.temperature || null } });
  return { ok: true, key, leadName: lead.name, followups: created, insights: insights.map((x) => ({ kind: x.kind, text: x.text })), skipped, temperature: out.temperature || null };
}

// Catch-all for notes typed anywhere (mobile, the AI assistant, imports, older screens): recent staff-written call notes and file notes nobody has scanned yet.
async function sweep(): Promise<Record<string, unknown>> {
  const since = Date.now() - 3 * 86400000;
  const { data: users } = await sb.from("users").select("id,name");
  const staffByName = new Map((users || []).map((u: any) => [String(u.name).toLowerCase(), u.id]));
  const { data: leads } = await sb.from("leads").select("id,call_attempts,activity,last_contact_at").in("status", ["active", "cold"]).gte("last_contact_at", new Date(since).toISOString().slice(0, 10)).limit(250);
  const cands: Note[] = [];
  for (const l of (leads || []) as any[]) {
    for (const a of (Array.isArray(l.call_attempts) ? l.call_attempts : [])) {
      const t = a && a.at ? new Date(a.at).getTime() : (a && a.date ? new Date(a.date + "T12:00:00Z").getTime() : 0);
      // Auto-written call entries ("Outbound call connected with ... via X's cell", missed-call texts, voicemail drops) carry no human information.
      if (a && a.notes && /^(Outbound call|Inbound call|Dialer call|Call (connected|ended)|Missed call|Texted|Text sent|Emailed|Voicemail (dropped|left via))/i.test(String(a.notes).trim())) continue;
      if (a && a.notes && String(a.notes).trim().length >= 12 && t >= since) cands.push({ leadId: l.id, source: "call", notes: String(a.notes), outcome: a.outcome, by: a.by, at: a.at });
    }
    for (const a of (Array.isArray(l.activity) ? l.activity : [])) {
      if (!a || (a.type !== "note" && a.type !== "note-manual") || typeof a.text !== "string" || a.text.length < 20) continue;
      const t = a.at ? new Date(a.at).getTime() : (a.date ? new Date(a.date + "T12:00:00Z").getTime() : 0);
      const by = staffByName.get(String(a.author || "").toLowerCase());
      if (!by || t < since) continue;                                         // only notes a real staff member wrote
      if (/^(Underwriting condition|AI recap|Guarantor\/entity|Marked|Points charged|Property address|Loan type|Term reset|Added \d+ checklist)/i.test(a.text)) continue;
      cands.push({ leadId: l.id, source: "note", notes: a.text, by, at: a.at });
    }
  }
  if (!cands.length) return { ok: true, scanned: 0 };
  const keys = cands.map((c) => (c.source === "call" ? "c:" : "n:") + c.leadId + ":" + hash(String(c.notes).trim().slice(0, 4000)));
  const { data: done } = await sb.from("note_scan_log").select("key").in("key", keys);
  const doneSet = new Set((done || []).map((d: any) => d.key));
  const todo = cands.filter((_, i) => !doneSet.has(keys[i])).slice(0, 8);
  const results: unknown[] = [];
  for (const c of todo) {
    const r = await scanOne(c);
    results.push({ lead: c.leadId, followups: ((r as any).followups || []).length, insights: ((r as any).insights || []).length, err: (r as any).error || null });
    // sweep path has no CRM screen open to record it, so leave a trace on the file itself
    if ((r as any).ok && (((r as any).followups || []).length)) {
      const { data: l2 } = await sb.from("leads").select("activity").eq("id", c.leadId).single();
      const act = Array.isArray(l2 && l2.activity) ? l2!.activity : [];
      act.push({ date: etDate(), type: "system", text: "Notes scanned: booked " + ((r as any).followups as any[]).map((f) => f.title + " (" + f.label + ")").join("; "), author: "System" });
      await sb.from("leads").update({ activity: act }).eq("id", c.leadId);
    }
  }
  return { ok: true, scanned: todo.length, pending: Math.max(0, cands.length - doneSet.size - todo.length), results };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let trusted = !!token && token === SERVICE_KEY;
  let caller: { id: string } | null = null;
  if (!trusted && token) {
    const { data: au } = await sb.auth.getUser(token).catch(() => ({ data: null } as any));
    if (au && au.user) { const { data: u } = await sb.from("users").select("id").eq("auth_id", au.user.id).maybeSingle(); if (u) { trusted = true; caller = u; } }
  }
  if (!trusted) return json({ ok: false, error: "not_authorized" }, 403);
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_e) { return json({ ok: false, error: "bad_request" }, 400); }
  try {
    if (body.sweep) return json(await sweep());
    if (!body.leadId) return json({ ok: false, error: "missing_leadId" }, 400);
    return json(await scanOne({ leadId: String(body.leadId), source: body.source === "note" ? "note" : "call", notes: String(body.notes || ""), outcome: body.outcome, by: (caller && caller.id) || body.by, at: body.at }));
  } catch (err) {
    return json({ ok: false, error: "server_error", detail: String(err).slice(0, 200) }, 500);
  }
});
