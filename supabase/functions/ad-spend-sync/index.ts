// Daily ad-spend ledger (Joe 2026-10-14, growth tracker): pulls spend / impressions / clicks / leads per campaign per day from Meta into
// ad_spend_daily so cost per lead, per application and per FUNDED loan can be computed against real CRM outcomes.
// Cron (shared-secret, like ad-optimizer) refreshes the last 7 days daily; {backfillDays: 90} loads history.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_TOKEN = Deno.env.get("META_ACCESS_TOKEN") || "";
const META_ACCT = (Deno.env.get("META_AD_ACCOUNT_ID") || "").replace(/^act_/, "");
const GRAPH = "https://graph.facebook.com/v21.0";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* cron sends a body */ }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(auth && body.secret === auth.secret) && bearer !== SERVICE_ROLE_KEY) return json({ error: "not_authorized" }, 403);
  if (!META_TOKEN || !META_ACCT) return json({ error: "meta_not_configured" }, 500);
  const days = Math.min(Math.max(Number(body.backfillDays) || 7, 1), 180);
  const until = new Date(), since = new Date(Date.now() - (days - 1) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  let url: string | null = GRAPH + "/act_" + META_ACCT + "/insights?" + new URLSearchParams({
    access_token: META_TOKEN, level: "campaign", time_increment: "1", limit: "500",
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,date_start",
    time_range: JSON.stringify({ since: iso(since), until: iso(until) }),
  }).toString();
  let pages = 0;
  while (url && pages < 20) {
    const r: any = await fetch(url).then((x) => x.json()).catch(() => null);
    if (!r || r.error) return json({ error: "meta_error", detail: r && r.error ? r.error.message : "no response" }, 502);
    for (const d of (r.data || [])) {
      const leads = ((d.actions || []).find((a: any) => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped") || {}).value;
      rows.push({ day: d.date_start, campaign_id: d.campaign_id, campaign_name: d.campaign_name, spend: Number(d.spend || 0), impressions: Number(d.impressions || 0),
        clicks: Number(d.clicks || 0), leads: Number(leads || 0), updated_at: new Date().toISOString() });
    }
    url = r.paging && r.paging.next ? r.paging.next : null; pages++;
  }
  if (rows.length) {
    const { error } = await sb.from("ad_spend_daily").upsert(rows, { onConflict: "day,campaign_id" });
    if (error) return json({ error: "db_error", detail: error.message }, 500);
  }
  return json({ ok: true, days, rows: rows.length, spend: Math.round(rows.reduce((s, r) => s + (r.spend as number), 0) * 100) / 100 });
});
