// Content calendar for the 6-month social posting campaign (Joe's ask,
// 2026-09-17) -- replaces what's currently scheduled in HighLevel, part
// of the broader "Bridgepoint replaces GHL entirely" goal for this build.
//
// Facebook natively supports scheduled publishing in the Graph API
// (scheduled_publish_time), so a Facebook post is created here immediately
// with that future timestamp and Meta's own systems publish it -- no
// polling needed on our side for Facebook.
//
// Instagram's Graph API has NO native scheduling -- it only publishes the
// instant you call it. Instagram posts are just recorded here as
// "scheduled" and the separate publish-scheduled-social function (run on
// a timer via pg_cron) actually fires them at the right time.
//
// Actions (all via POST, body: { action, ...params }):
//   "create" -> create/schedule a post (caption, mediaBase64, mediaType,
//               platforms: ["facebook","instagram"], scheduledAt ISO string)
//   "list"   -> list posts (optionally ?status=)
//   "delete" -> cancel a not-yet-published post
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const META_PAGE_ID = Deno.env.get("META_PAGE_ID")!;
const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = "https://graph.facebook.com/" + GRAPH_VERSION;
const MEDIA_BUCKET = "public-assets";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Posting AS the Page (even an unpublished/scheduled post) requires a
// Page-specific access token, not the System User's own token -- Meta
// rejects it otherwise with "(#200) Unpublished posts must be posted to
// a page as the page itself." The System User token IS allowed to fetch
// this, now that it has pages_read_engagement (see meta-ads's
// page-token-check, 2026-09-17). Not cached -- these calls are
// infrequent enough that fetching fresh each time isn't worth the
// staleness risk if the token is ever rotated.
async function getPageAccessToken(): Promise<string> {
  const url = new URL(GRAPH_BASE + "/" + META_PAGE_ID);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", META_ACCESS_TOKEN);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    console.error("social-post-manager: couldn't get page access token", JSON.stringify(data));
    return META_ACCESS_TOKEN; // fall back, will surface Meta's real error downstream
  }
  return data.access_token as string;
}

async function graphFetch(path: string, params: Record<string, unknown> = {}, method: "GET" | "POST" | "DELETE" = "GET", tokenOverride?: string) {
  const token = tokenOverride || META_ACCESS_TOKEN;
  const url = new URL(GRAPH_BASE + path);
  let body: string | undefined;
  if (method === "GET") {
    url.searchParams.set("access_token", token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    body = JSON.stringify({ ...params, access_token: token });
  }
  const res = await fetch(url.toString(), {
    method,
    headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
    body,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const action = body.action;

    if (action === "list") {
      let query = sb.from("social_posts").select("*").order("scheduled_at", { ascending: true });
      if (body.status) query = query.eq("status", body.status);
      const { data, error } = await query;
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true, posts: data }), { headers: CORS_HEADERS });
    }

    if (action === "update") {
      // Lets a still-scheduled post be revised -- Joe's ask (2026-09-17):
      // the ability to sharpen a post's copy/timing before it goes out,
      // e.g. after reviewing how similar earlier posts performed or
      // reacting to a market move. Only touches posts that haven't
      // published yet; a live/failed post is left alone.
      const id: string = body.id;
      if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: CORS_HEADERS });
      const { data: post } = await sb.from("social_posts").select("*").eq("id", id).single();
      if (!post) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: CORS_HEADERS });
      if (post.status !== "scheduled") {
        return new Response(JSON.stringify({ error: "Only a still-scheduled (not yet published) post can be edited." }), { status: 400, headers: CORS_HEADERS });
      }

      const patch: Record<string, unknown> = {};
      if (body.caption != null) patch.caption = body.caption;
      if (body.scheduledAt != null) patch.scheduled_at = body.scheduledAt;
      if (body.platforms != null) patch.platforms = body.platforms;

      // If Facebook already has this post queued, push the edit to Meta too.
      if (post.fb_post_id) {
        const fbParams: Record<string, unknown> = {};
        if (patch.caption != null) fbParams.message = patch.caption;
        if (patch.scheduled_at != null) fbParams.scheduled_publish_time = Math.floor(new Date(patch.scheduled_at as string).getTime() / 1000);
        if (Object.keys(fbParams).length) {
          const pageToken = await getPageAccessToken();
          const fbResult = await graphFetch("/" + post.fb_post_id, fbParams, "POST", pageToken);
          if (!fbResult.ok) {
            return new Response(JSON.stringify({ error: "Facebook rejected the edit", detail: fbResult.data }), { status: 502, headers: CORS_HEADERS });
          }
        }
      }

      const { error: updateErr } = await sb.from("social_posts").update(patch).eq("id", id);
      if (updateErr) return new Response(JSON.stringify({ error: updateErr.message }), { status: 500, headers: CORS_HEADERS });
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }

    if (action === "delete") {
      const id: string = body.id;
      if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: CORS_HEADERS });
      const { data: post } = await sb.from("social_posts").select("*").eq("id", id).single();
      if (post?.fb_post_id) {
        const pageToken = await getPageAccessToken();
        await graphFetch("/" + post.fb_post_id, {}, "DELETE", pageToken).catch(() => {});
      }
      await sb.from("social_posts").delete().eq("id", id);
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }

    if (action === "create") {
      const caption: string = body.caption || "";
      const platforms: string[] = Array.isArray(body.platforms) ? body.platforms : [];
      const scheduledAt: string = body.scheduledAt;
      const mediaBase64: string | undefined = body.mediaBase64;
      const mediaType: string = body.mediaType || "image/jpeg";
      const createdBy: string = body.createdBy || "owner";
      if (!caption || !platforms.length || !scheduledAt) {
        return new Response(JSON.stringify({ error: "caption, platforms, and scheduledAt are required" }), { status: 400, headers: CORS_HEADERS });
      }

      const id = "SP" + crypto.randomUUID().slice(0, 12);
      let mediaPath: string | null = null;
      let mediaPublicUrl: string | null = null;
      if (mediaBase64) {
        const ext = mediaType.includes("mp4") ? "mp4" : mediaType.includes("png") ? "png" : "jpg";
        mediaPath = "social/" + id + "." + ext;
        const bytes = base64ToBytes(mediaBase64);
        const { error: upErr } = await sb.storage.from(MEDIA_BUCKET).upload(mediaPath, bytes, { contentType: mediaType, upsert: true });
        if (upErr) return new Response(JSON.stringify({ error: "upload_failed", detail: upErr.message }), { status: 500, headers: CORS_HEADERS });
        const { data: pub } = sb.storage.from(MEDIA_BUCKET).getPublicUrl(mediaPath);
        mediaPublicUrl = pub.publicUrl;
      }

      const scheduledUnix = Math.floor(new Date(scheduledAt).getTime() / 1000);
      let fbPostId: string | null = null;
      let status = "scheduled";
      let errorMsg: string | null = null;

      // Facebook: create now with scheduled_publish_time -- Meta's own
      // systems handle the actual publish timing from here on.
      if (platforms.includes("facebook")) {
        const minLead = Math.floor(Date.now() / 1000) + 600; // Meta requires >=10 min out
        if (scheduledUnix < minLead) {
          errorMsg = "Facebook requires the scheduled time to be at least 10 minutes in the future.";
        } else {
          const fbParams: Record<string, unknown> = {
            message: caption, published: false, scheduled_publish_time: scheduledUnix,
          };
          const pageToken = await getPageAccessToken();
          let fbResult;
          if (mediaPublicUrl && mediaType.startsWith("image")) {
            fbResult = await graphFetch("/" + META_PAGE_ID + "/photos", { ...fbParams, url: mediaPublicUrl }, "POST", pageToken);
          } else {
            fbResult = await graphFetch("/" + META_PAGE_ID + "/feed", fbParams, "POST", pageToken);
          }
          if (fbResult.ok) {
            fbPostId = fbResult.data?.id || fbResult.data?.post_id || null;
          } else {
            errorMsg = "Facebook: " + JSON.stringify(fbResult.data);
          }
        }
      }

      const { error: insertErr } = await sb.from("social_posts").insert({
        id, caption, media_path: mediaPath, media_type: mediaBase64 ? mediaType : null,
        platforms, scheduled_at: scheduledAt, status, fb_post_id: fbPostId,
        error: errorMsg, created_by: createdBy,
        language: body.language || "en", post_hour: body.postHour != null ? body.postHour : null,
      });
      if (insertErr) return new Response(JSON.stringify({ error: insertErr.message }), { status: 500, headers: CORS_HEADERS });

      return new Response(JSON.stringify({ ok: true, id, fbPostId, error: errorMsg }), { headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({ error: "unknown_action" }), { status: 400, headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
