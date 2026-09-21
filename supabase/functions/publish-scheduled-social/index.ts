// Runs on a timer (pg_cron) to publish due Instagram posts. Facebook posts
// don't need this -- they're created in social-post-manager with a native
// scheduled_publish_time and Meta's own systems publish them on time.
// Instagram's Graph API has no equivalent (Content Publishing API only
// publishes immediately when called), so this is the only thing standing
// in for a "scheduler" on that side: check for posts whose time has come
// and haven't been pushed to Instagram yet, publish them, record the
// result.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_AD_ACCOUNT_ID = Deno.env.get("META_AD_ACCOUNT_ID")!;
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = "https://graph.facebook.com/" + GRAPH_VERSION;
const MEDIA_BUCKET = "public-assets";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function graphFetch(path: string, params: Record<string, unknown> = {}, method: "GET" | "POST" = "GET") {
  const url = new URL(GRAPH_BASE + path);
  let body: string | undefined;
  if (method === "GET") {
    url.searchParams.set("access_token", META_ACCESS_TOKEN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    body = JSON.stringify({ ...params, access_token: META_ACCESS_TOKEN });
  }
  const res = await fetch(url.toString(), { method, headers: method === "GET" ? undefined : { "Content-Type": "application/json" }, body });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

Deno.serve(async () => {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await sb.from("social_posts")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_at", nowIso)
    .is("ig_post_id", null);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });

  const igDue = (due || []).filter((p) => Array.isArray(p.platforms) && (p.platforms as string[]).includes("instagram"));
  if (!igDue.length) {
    // Still mark any pure-Facebook posts whose time has passed as
    // "published" for calendar-display purposes -- Meta already published
    // them natively, this is just bookkeeping.
    const fbOnly = (due || []).filter((p) => Array.isArray(p.platforms) && !(p.platforms as string[]).includes("instagram"));
    for (const p of fbOnly) {
      await sb.from("social_posts").update({ status: "published" }).eq("id", p.id);
    }
    return new Response(JSON.stringify({ ok: true, published: 0, fbMarked: fbOnly.length }), { headers: { "Content-Type": "application/json" } });
  }

  const igAccounts = await graphFetch("/act_" + META_AD_ACCOUNT_ID + "/instagram_accounts", { fields: "id,username" });
  const igUserId = igAccounts.ok ? igAccounts.data?.data?.[0]?.id : null;
  if (!igUserId) {
    console.error("publish-scheduled-social: no Instagram account connected yet", JSON.stringify(igAccounts.data));
    return new Response(JSON.stringify({ ok: true, published: 0, note: "no Instagram account connected" }), { headers: { "Content-Type": "application/json" } });
  }

  let published = 0;
  for (const post of igDue) {
    if (!post.media_path) {
      await sb.from("social_posts").update({ status: "failed", error: "Instagram requires an image or video -- text-only posts aren't supported." }).eq("id", post.id);
      continue;
    }
    const { data: pub } = sb.storage.from(MEDIA_BUCKET).getPublicUrl(post.media_path as string);
    const isVideo = ((post.media_type as string) || "").includes("video") || ((post.media_type as string) || "").includes("mp4");

    const containerParams: Record<string, unknown> = { caption: post.caption };
    if (isVideo) { containerParams.video_url = pub.publicUrl; containerParams.media_type = "REELS"; }
    else { containerParams.image_url = pub.publicUrl; }

    const container = await graphFetch("/" + igUserId + "/media", containerParams, "POST");
    if (!container.ok || !container.data?.id) {
      await sb.from("social_posts").update({ status: "failed", error: "IG container: " + JSON.stringify(container.data) }).eq("id", post.id);
      continue;
    }

    const publishRes = await graphFetch("/" + igUserId + "/media_publish", { creation_id: container.data.id }, "POST");
    if (!publishRes.ok || !publishRes.data?.id) {
      await sb.from("social_posts").update({ status: "failed", error: "IG publish: " + JSON.stringify(publishRes.data) }).eq("id", post.id);
      continue;
    }

    await sb.from("social_posts").update({ status: "published", ig_post_id: publishRes.data.id }).eq("id", post.id);
    published++;
  }

  return new Response(JSON.stringify({ ok: true, published }), { headers: { "Content-Type": "application/json" } });
});
