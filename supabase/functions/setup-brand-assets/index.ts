// One-time setup: creates a public storage bucket for brand assets (logo,
// staff photos) and uploads a file into it. Uses the service role key so
// no RLS policy juggling is needed -- this is an admin-only utility, not
// something the client app calls directly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "public-assets";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: buckets } = await sb.storage.listBuckets();
    const exists = (buckets || []).some((b) => b.name === BUCKET);
    if (!exists) {
      const { error: bucketErr } = await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: "10MB" });
      if (bucketErr) return new Response(JSON.stringify({ error: "bucket_error", detail: bucketErr }), { status: 500, headers: CORS_HEADERS });
    }

    const body = await req.json();
    const path: string = body.path;
    const contentBase64: string = body.contentBase64;
    const contentType: string = body.contentType || "application/octet-stream";
    if (!path || !contentBase64) {
      return new Response(JSON.stringify({ ok: true, bucketReady: true, note: "no file provided, bucket ensured only" }), { headers: CORS_HEADERS });
    }

    const bytes = base64ToBytes(contentBase64);
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (upErr) return new Response(JSON.stringify({ error: "upload_error", detail: upErr }), { status: 500, headers: CORS_HEADERS });

    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return new Response(JSON.stringify({ ok: true, url: pub.publicUrl }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
