// Meta Marketing API integration -- lets the CRM (and the AI Assistant)
// read ad performance and adjust campaign budgets on Joe's behalf, and is
// the foundation for tying ad spend to real closed-loan outcomes (Joe's
// original ask, 2026-09-xx). Uses a Business-scoped System User token
// (ads_management + ads_read), not a personal user token, so it doesn't
// expire when anyone's personal Facebook session does.
//
// Actions (all via POST, body: { action, ...params }):
//   "campaigns"     -> list campaigns with id/name/status/objective
//   "insights"      -> spend/performance for one campaign or the whole
//                      ad account over a date range
//   "update-budget" -> change a campaign's daily budget
const META_APP_ID = Deno.env.get("META_APP_ID")!;
const META_APP_SECRET = Deno.env.get("META_APP_SECRET")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_AD_ACCOUNT_ID = Deno.env.get("META_AD_ACCOUNT_ID")!; // numeric, no "act_" prefix
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = "https://graph.facebook.com/" + GRAPH_VERSION;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function actAccount(): string {
  return "act_" + META_AD_ACCOUNT_ID.replace(/^act_/, "");
}

async function graphFetch(path: string, params: Record<string, string> = {}, method = "GET") {
  const url = new URL(GRAPH_BASE + path);
  const searchParams: Record<string, string> = { access_token: META_ACCESS_TOKEN, ...params };
  if (method === "GET") {
    Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return { ok: res.ok, status: res.status, data: await res.json() };
  }
  const body = new URLSearchParams(searchParams);
  const res = await fetch(url.toString(), { method, body });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const action: string = body.action;

    if (action === "campaigns") {
      const result = await graphFetch("/" + actAccount() + "/campaigns", {
        fields: "id,name,status,objective,daily_budget,lifetime_budget",
        limit: "100",
      });
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, campaigns: result.data.data }), { headers: CORS_HEADERS });
    }

    if (action === "insights") {
      // campaignId optional -- omit for whole-ad-account totals.
      const campaignId: string | null = body.campaignId || null;
      const datePreset: string = body.datePreset || "last_30d"; // e.g. today, yesterday, last_7d, last_30d, this_month
      const path = campaignId ? "/" + campaignId + "/insights" : "/" + actAccount() + "/insights";
      const result = await graphFetch(path, {
        fields: "campaign_name,spend,impressions,clicks,cpc,cpm,ctr,actions",
        date_preset: datePreset,
        level: campaignId ? "campaign" : "account",
      });
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, insights: result.data.data }), { headers: CORS_HEADERS });
    }

    if (action === "update-budget") {
      const campaignId: string = body.campaignId;
      const dailyBudgetCents: number = body.dailyBudgetCents; // Meta budgets are in cents
      if (!campaignId || !dailyBudgetCents) {
        return new Response(JSON.stringify({ error: "missing_fields", detail: "campaignId and dailyBudgetCents are required" }), { status: 400, headers: CORS_HEADERS });
      }
      const result = await graphFetch("/" + campaignId, { daily_budget: String(dailyBudgetCents) }, "POST");
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, result: result.data }), { headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ error: "unknown_action", detail: action }), { status: 400, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
