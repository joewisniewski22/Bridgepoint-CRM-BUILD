// Meta conversion feedback (Joe 2026-10-09: "do everything in your power to maximize roi").
//
// A trigger on leads (migration 100) calls this whenever a Facebook lead-form lead's stage,
// status, or first dial changes. We send Meta's Conversions API the funnel steps that lead has
// reached (CRM integration: user_data.lead_id = the Facebook leadgen id), once each, so Meta
// learns which form-fillers become applications and closed loans and can optimize toward them
// ("conversion leads"). Nothing borrower-facing; no personal data beyond Meta's own lead id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN") || "";
const DATASET_ID = Deno.env.get("META_PIXEL_ID") || "828172673668690"; // "BridgePoint Lending" pixel (active)
const GRAPH = "https://graph.facebook.com/v21.0";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

// Funnel, in order. Reaching a later step also reports any earlier step not yet sent.
const STEPS = ["Contacted", "Application Submitted", "In Processing", "Approved", "Closed"];
const STAGE_STEP: Record<string, number> = {
  contacted: 0, app_sent: 0, app_completed: 1, docs: 1,
  processing: 2, underwriting: 2, approved: 3, ctc: 3, closed: 4, postclosing: 4,
};

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const leadId = String(body.leadId || "");
  const { data: l } = await sb.from("leads").select("id,stage,status,lo_dialed_at,call_attempts,meta_leadgen_id,loan_amount,points_charged").eq("id", leadId).maybeSingle();
  if (!l || !l.meta_leadgen_id || !/^\d+$/.test(String(l.meta_leadgen_id))) return json({ ok: true, skipped: "no_leadgen_id" });
  if (!META_TOKEN) return json({ ok: false, error: "no_meta_token" });

  let reached = STAGE_STEP[String(l.stage || "")] ?? -1;
  const called = l.lo_dialed_at || ((l.call_attempts || []) as any[]).some((a) => a && a.outcome && a.outcome !== "texted");
  if (called && reached < 0) reached = 0;
  const wanted: string[] = [];
  for (let i = 0; i <= reached; i++) wanted.push(STEPS[i]);
  // A lead we mark spam/lost before it ever applied tells Meta "this kind of lead doesn't convert".
  if ((l.status === "spam" || l.status === "lost") && reached < 1) wanted.push("Disqualified");
  // Form answers say this one can close (660+ credit, funds ready, needs it within 60 days) --
  // sent at intake by meta-leads-webhook so Meta gets a quality signal the same minute.
  if (body.qualified === true && l.status === "active") wanted.unshift("Qualified Lead");
  if (!wanted.length) return json({ ok: true, skipped: "nothing_to_send" });

  const { data: done } = await sb.from("meta_crm_events").select("event_name").eq("lead_id", leadId);
  const sent = new Set((done || []).map((d: any) => d.event_name));
  const todo = wanted.filter((e) => !sent.has(e));
  if (!todo.length) return json({ ok: true, skipped: "already_sent" });

  const now = Math.floor(Date.now() / 1000);
  const data = todo.map((event_name) => {
    const ev: Record<string, unknown> = {
      event_name, event_time: now, action_source: "system_generated",
      user_data: { lead_id: Number(l.meta_leadgen_id) },
      custom_data: { event_source: "crm", lead_event_source: "Bridgepoint CRM" },
    };
    // Closed: the value is our origination on the loan, so Meta can weigh bigger deals.
    if (event_name === "Closed" && l.loan_amount && l.points_charged) {
      (ev.custom_data as Record<string, unknown>).value = Math.round(Number(l.loan_amount) * Number(l.points_charged) / 100);
      (ev.custom_data as Record<string, unknown>).currency = "USD";
    }
    return ev;
  });
  const params = new URLSearchParams({ data: JSON.stringify(data), access_token: META_TOKEN });
  if (typeof body.testEventCode === "string" && body.testEventCode) params.set("test_event_code", body.testEventCode);
  const res = await fetch(GRAPH + "/" + DATASET_ID + "/events", { method: "POST", body: params }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const ok = res && !res.error && (res.events_received || 0) > 0;
  if (ok && !body.testEventCode) {
    await sb.from("meta_crm_events").insert(todo.map((event_name) => ({ lead_id: leadId, event_name, response: JSON.stringify(res).slice(0, 300) })));
  }
  return json({ ok, sent: todo, meta: res });
});
