// Asks recently funded borrowers for a Google review, one polite text from their own loan officer.
// Controlled by site_config: review_link (the Google review URL) and review_requests_mode = off | shadow | live.
//   off    -> does nothing (default)
//   shadow -> returns who WOULD be texted and the exact message, sends nothing, logs nothing
//   live   -> texts them (max 5 per run), 9am-7pm Eastern only, once per borrower ever
// Never texts: opted-out numbers, lost files, referral partners, anyone already asked, or anyone funded less than
// 2 days or more than 45 days ago. Called by the owner (Authorization: owner session) or by a scheduled job (service key).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

async function authorized(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === SERVICE_ROLE_KEY) return true;
  const { data } = await sb.auth.getUser(token).catch(() => ({ data: null }));
  if (!data || !data.user) return false;
  const { data: u } = await sb.from("users").select("role").eq("auth_id", data.user.id).maybeSingle();
  return !!u && u.role === "owner";
}
function etHour(): number {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(new Date()));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await authorized(req))) return json({ error: "not_authorized" }, 403);
  try {
    const { data: cfgRows } = await sb.from("site_config").select("key,value").in("key", ["review_link", "review_requests_mode"]);
    const cfg: Record<string, string> = {};
    (cfgRows || []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value || ""; });
    const mode = cfg.review_requests_mode || "off", link = (cfg.review_link || "").trim();
    if (mode === "off") return json({ ok: true, skipped: "mode is off" });
    if (!/^https:\/\//.test(link)) return json({ ok: true, skipped: "no review link set" });

    const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10), to = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const { data: leads } = await sb.from("leads").select("id,name,phone,assigned_to,source,sms_opt_out,close_date,property_address,stage,status")
      .eq("status", "closed").neq("stage", "lost").gte("close_date", from).lte("close_date", to).limit(200);
    const { data: logged } = await sb.from("review_request_log").select("lead_id");
    const done = new Set((logged || []).map((r: { lead_id: string }) => r.lead_id));
    const { data: users } = await sb.from("users").select("id,name");
    const nameOf = (id: string) => ((users || []).find((u: { id: string; name: string }) => u.id === id) || { name: "your loan officer" }).name;

    const todo = (leads || []).filter((l: Record<string, unknown>) => !done.has(l.id as string) && !l.sms_opt_out && l.phone && !/Referral Partner/i.test(String(l.source || ""))).slice(0, 5);
    const plan = todo.map((l: Record<string, unknown>) => {
      const first = String(l.name || "").split(/\s+/)[0] || "there";
      const lo = nameOf(String(l.assigned_to || "owner")).split(/\s+/)[0];
      const text = "Hi " + first + ", it's " + lo + " at Bridgepoint Lending. Thank you again for trusting us with your loan. If we earned it, would you take a minute to leave a quick Google review? It helps other investors find us: " + link + "  (Reply STOP to opt out.)";
      return { leadId: l.id, name: l.name, to: l.phone, text };
    });
    if (mode === "shadow") return json({ ok: true, mode, wouldSend: plan });
    if (mode !== "live") return json({ ok: true, skipped: "unknown mode" });
    const h = etHour();
    if (h < 9 || h >= 19) return json({ ok: true, skipped: "outside 9am-7pm Eastern", waiting: plan.length });

    const sent: string[] = [];
    for (const p of plan) {
      const r = await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ leadId: p.leadId, to: p.to, text: p.text, fromName: nameOf(String(todo.find((t: Record<string, unknown>) => t.id === p.leadId)?.assigned_to || "owner")), initiatedBy: "ai" }) }).catch(() => null);
      if (r && r.ok) { await sb.from("review_request_log").insert({ lead_id: p.leadId as string, mode: "live", channel: "sms" }); sent.push(p.leadId as string); }
    }
    return json({ ok: true, mode, sent });
  } catch (e) {
    console.error("review-requests", String(e));
    return json({ error: "server_error" }, 500);
  }
});
