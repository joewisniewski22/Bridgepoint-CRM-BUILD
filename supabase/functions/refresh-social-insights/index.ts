// Pulls real Meta engagement data for recently-published posts and feeds
// it back into social_posts (impressions/engagement), which is what
// generate-social-content's pickLanguage()/pickPostingHour() actually
// learn from. Run on a daily pg_cron schedule -- Joe's ask (2026-09-17):
// language and posting time should be "determined on effectiveness,"
// which only means something once real numbers are flowing back in.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = "https://graph.facebook.com/" + GRAPH_VERSION;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function graphFetch(path: string, params: Record<string, unknown> = {}) {
  const url = new URL(GRAPH_BASE + path);
  url.searchParams.set("access_token", META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

Deno.serve(async () => {
  // Only posts published in the last 30 days -- Meta's insights are most
  // meaningful in the days right after publishing, and there's no point
  // re-checking a post from months ago every single day forever.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: posts, error } = await sb.from("social_posts")
    .select("id, fb_post_id, ig_post_id")
    .eq("status", "published")
    .gte("scheduled_at", cutoff)
    .or("fb_post_id.not.is.null,ig_post_id.not.is.null");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  let updated = 0;
  for (const post of posts || []) {
    let impressions = 0;
    let engagement = 0;

    if (post.fb_post_id) {
      const res = await graphFetch("/" + post.fb_post_id + "/insights", { metric: "post_impressions,post_engaged_users" });
      if (res.ok && Array.isArray(res.data?.data)) {
        for (const metric of res.data.data) {
          const value = metric.values?.[0]?.value || 0;
          if (metric.name === "post_impressions") impressions += value;
          if (metric.name === "post_engaged_users") engagement += value;
        }
      }
    }
    if (post.ig_post_id) {
      const res = await graphFetch("/" + post.ig_post_id + "/insights", { metric: "impressions,engagement" });
      if (res.ok && Array.isArray(res.data?.data)) {
        for (const metric of res.data.data) {
          const value = metric.values?.[0]?.value || 0;
          if (metric.name === "impressions") impressions += value;
          if (metric.name === "engagement") engagement += value;
        }
      }
    }

    if (impressions > 0 || engagement > 0) {
      await sb.from("social_posts").update({ impressions, engagement }).eq("id", post.id);
      updated++;
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: (posts || []).length, updated }), { headers: { "Content-Type": "application/json" } });
});
