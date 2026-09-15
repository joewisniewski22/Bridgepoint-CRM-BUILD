// Meta Marketing API integration -- lets the CRM (and the AI Assistant)
// read ad performance and adjust campaign budgets on Joe's behalf, and is
// the foundation for tying ad spend to real closed-loan outcomes (Joe's
// original ask, 2026-09-xx). Uses a Business-scoped System User token
// (ads_management + ads_read), not a personal user token, so it doesn't
// expire when anyone's personal Facebook session does.
//
// Actions (all via POST, body: { action, ...params }):
//   "campaigns"       -> list campaigns with id/name/status/objective
//   "insights"        -> spend/performance for one campaign or the whole
//                        ad account over a date range
//   "update-budget"   -> change a campaign's daily budget
//   "set-status"      -> pause/activate a campaign
//   "adsets"          -> list ad sets under a campaign (targeting, optimization goal)
//   "ads"             -> list ads + creative under a campaign or ad set
//   "create-campaign" -> create a new campaign
//   "create-adset"    -> create a new ad set under a campaign
//   "create-ad"       -> create a new ad (creative + ad) under an ad set
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

    if (action === "page-instagram") {
      const pageId: string = body.pageId;
      if (!pageId) return new Response(JSON.stringify({ error: "missing_fields", detail: "pageId is required" }), { status: 400, headers: CORS_HEADERS });
      const result = await graphFetch("/" + pageId, { fields: "instagram_business_account,connected_instagram_account" });
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, result: result.data }), { headers: CORS_HEADERS });
    }

    if (action === "set-status") {
      const campaignId: string = body.campaignId;
      const status: string = body.status; // "ACTIVE" | "PAUSED"
      if (!campaignId || !status) {
        return new Response(JSON.stringify({ error: "missing_fields", detail: "campaignId and status are required" }), { status: 400, headers: CORS_HEADERS });
      }
      const result = await graphFetch("/" + campaignId, { status }, "POST");
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, result: result.data }), { headers: CORS_HEADERS });
    }

    if (action === "adsets") {
      const campaignId: string = body.campaignId;
      if (!campaignId) return new Response(JSON.stringify({ error: "missing_fields", detail: "campaignId is required" }), { status: 400, headers: CORS_HEADERS });
      const result = await graphFetch("/" + campaignId + "/adsets", {
        fields: "id,name,status,optimization_goal,destination_type,billing_event,targeting,promoted_object,daily_budget",
        limit: "100",
      });
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, adsets: result.data.data }), { headers: CORS_HEADERS });
    }

    if (action === "ads") {
      const parentId: string = body.campaignId || body.adsetId;
      if (!parentId) return new Response(JSON.stringify({ error: "missing_fields", detail: "campaignId or adsetId is required" }), { status: 400, headers: CORS_HEADERS });
      const result = await graphFetch("/" + parentId + "/ads", {
        fields: "id,name,status,adset_id,creative{id,object_story_spec,image_hash,body,title,link_url,call_to_action_type}",
        limit: "100",
      });
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, ads: result.data.data }), { headers: CORS_HEADERS });
    }

    if (action === "create-campaign") {
      const name: string = body.name;
      const objective: string = body.objective || "OUTCOME_TRAFFIC";
      const status: string = body.status || "PAUSED";
      const dailyBudgetCents: number | null = body.dailyBudgetCents || null;
      if (!name) return new Response(JSON.stringify({ error: "missing_fields", detail: "name is required" }), { status: 400, headers: CORS_HEADERS });
      const params: Record<string, string> = {
        name, objective, status,
        special_ad_categories: JSON.stringify([]),
        bid_strategy: body.bidStrategy || "LOWEST_COST_WITHOUT_CAP",
      };
      if (dailyBudgetCents) params.daily_budget = String(dailyBudgetCents);
      const result = await graphFetch("/" + actAccount() + "/campaigns", params, "POST");
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, result: result.data }), { headers: CORS_HEADERS });
    }

    if (action === "create-adset") {
      const campaignId: string = body.campaignId;
      const name: string = body.name;
      const dailyBudgetCents: number | null = body.dailyBudgetCents || null; // omit for CBO campaigns (budget lives on the campaign)
      const optimizationGoal: string = body.optimizationGoal || "LINK_CLICKS";
      const billingEvent: string = body.billingEvent || "IMPRESSIONS";
      const status: string = body.status || "PAUSED";
      const targeting = body.targeting || { age_min: 18, age_max: 65, geo_locations: { countries: ["US"] }, targeting_automation: { advantage_audience: 1 } };
      if (!campaignId || !name) {
        return new Response(JSON.stringify({ error: "missing_fields", detail: "campaignId and name are required" }), { status: 400, headers: CORS_HEADERS });
      }
      const params: Record<string, string> = {
        name, campaign_id: campaignId,
        optimization_goal: optimizationGoal, billing_event: billingEvent, status,
        targeting: JSON.stringify(targeting),
      };
      if (dailyBudgetCents) params.daily_budget = String(dailyBudgetCents);
      if (body.promotedObject) params.promoted_object = JSON.stringify(body.promotedObject);
      const result = await graphFetch("/" + actAccount() + "/adsets", params, "POST");
      if (!result.ok) return new Response(JSON.stringify({ error: "meta_error", detail: result.data }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, result: result.data }), { headers: CORS_HEADERS });
    }

    if (action === "create-ad") {
      const adsetId: string = body.adsetId;
      const name: string = body.name;
      const pageId: string = body.pageId;
      const linkUrl: string = body.linkUrl;
      const message: string = body.message;
      const headline: string = body.headline;
      const description: string = body.description || "";
      const imageHash: string = body.imageHash;
      const ctaType: string = body.ctaType || "LEARN_MORE";
      const status: string = body.status || "PAUSED";
      if (!adsetId || !name || !pageId || !linkUrl || !message || !headline || !imageHash) {
        return new Response(JSON.stringify({ error: "missing_fields", detail: "adsetId, name, pageId, linkUrl, message, headline and imageHash are required" }), { status: 400, headers: CORS_HEADERS });
      }
      const objectStorySpec = {
        page_id: pageId,
        link_data: {
          link: linkUrl, message, name: headline, description,
          image_hash: imageHash,
          call_to_action: { type: ctaType, value: { link: linkUrl } },
        },
      };
      const creativeResult = await graphFetch("/" + actAccount() + "/adcreatives", {
        name: name + " Creative",
        object_story_spec: JSON.stringify(objectStorySpec),
      }, "POST");
      if (!creativeResult.ok) return new Response(JSON.stringify({ error: "meta_error", detail: creativeResult.data }), { status: 502, headers: CORS_HEADERS });
      const creativeId = creativeResult.data.id;
      const adResult = await graphFetch("/" + actAccount() + "/ads", {
        name, adset_id: adsetId, status,
        creative: JSON.stringify({ creative_id: creativeId }),
      }, "POST");
      if (!adResult.ok) return new Response(JSON.stringify({ error: "meta_error", detail: adResult.data, creativeId }), { status: 502, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, creativeId, result: adResult.data }), { headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ error: "unknown_action", detail: action }), { status: 400, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
