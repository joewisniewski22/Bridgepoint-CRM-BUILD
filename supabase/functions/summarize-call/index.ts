// Turns a loan officer's own rough call notes into a clean recap on the lead (Joe 2026-10-12).
// Nothing here hears the call: the only input is what the loan officer typed in the Live notes box or the log form,
// so there is no recording or transcription to disclose. Staff only; the lead is read with the caller's own
// session, so a loan officer can only recap a file they can see. Never changes the lead itself: it returns a
// recap for the CRM to attach.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-haiku-4-5-20251001";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

const SYSTEM = "You turn a loan officer's rough notes from a phone call with a real estate investor into a clean record for the loan file. " +
  "Use ONLY what is in the notes and the file facts given. Never invent facts, numbers, names or dates. If something isn't in the notes, leave it out or use null. " +
  "Output ONLY valid JSON, no markdown fences, with exactly these keys: " +
  "\"summary\" (1-3 plain sentences, past tense, what was discussed and decided), " +
  "\"key_points\" (array of up to 5 short strings: deal details, timeline, concerns, objections, anything the borrower asked for), " +
  "\"next_step\" (one short sentence, or null if the notes don't say), " +
  "\"follow_up_date\" (YYYY-MM-DD ONLY when the notes state an exact calendar date such as 'Oct 20' or '11/3'; for relative times like 'next Tuesday' or 'in two weeks' use null and put the wording in next_step instead - never calculate dates), " +
  "\"temperature\" (\"hot\", \"warm\", or \"cold\" - how ready the borrower sounds to move, judged only from the notes).";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: au } = token ? await svc.auth.getUser(token) : { data: { user: null } } as any;
  if (!au || !au.user) return json({ ok: false, error: "not_authorized" }, 401);
  const { data: staff } = await svc.from("users").select("id,name").eq("auth_id", au.user.id).maybeSingle();
  if (!staff) return json({ ok: false, error: "not_authorized" }, 403);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_) { return json({ ok: false, error: "bad_request" }, 400); }
  const notes = String(body.notes || "").trim().slice(0, 4000);
  if (notes.length < 25) return json({ ok: false, error: "notes_too_short" }, 400);

  // read the lead as the caller, so database access rules apply
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: "Bearer " + token } } });
  const { data: lead } = await asUser.from("leads").select("name,loan_type,stage,property_address,loan_amount,purchase_price,rate").eq("id", String(body.leadId || "")).maybeSingle();
  if (!lead) return json({ ok: false, error: "no_access" }, 403);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const prompt = "Today's date: " + today + "\nOutcome the loan officer logged: " + String(body.outcome || "unknown") + "\n" +
    "File: " + [lead.name, lead.loan_type, lead.stage && ("stage " + lead.stage), lead.property_address, lead.loan_amount && ("loan $" + lead.loan_amount), lead.purchase_price && ("price $" + lead.purchase_price)].filter(Boolean).join(" | ") +
    "\n\nLoan officer's notes:\n" + notes;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  }).catch(() => null);
  if (!res || !res.ok) return json({ ok: false, error: "ai_unavailable" }, 502);
  const data = await res.json();
  const text = String((data.content || []).map((c: any) => c.text || "").join("")).replace(/^```(?:json)?|```$/g, "").trim();
  let recap: any;
  try { recap = JSON.parse(text); } catch (_) { return json({ ok: false, error: "bad_ai_output" }, 502); }
  const clean = {
    summary: String(recap.summary || "").slice(0, 600),
    keyPoints: (Array.isArray(recap.key_points) ? recap.key_points : []).map((x: unknown) => String(x).slice(0, 200)).slice(0, 5),
    nextStep: recap.next_step ? String(recap.next_step).slice(0, 240) : null,
    followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(String(recap.follow_up_date || "")) ? String(recap.follow_up_date) : null,
    temperature: ["hot", "warm", "cold"].includes(recap.temperature) ? recap.temperature : null,
  };
  if (!clean.summary) return json({ ok: false, error: "empty" }, 502);
  return json({ ok: true, recap: clean });
});
