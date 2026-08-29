// One-time setup: creates the private "lead-documents" storage bucket used
// to hold files auto-filed from third-party email replies (title
// commitments, insurance policies). Safe to call more than once.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (_req: Request) => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: buckets } = await sb.storage.listBuckets();
  const exists = (buckets || []).some((b: { name: string }) => b.name === "lead-documents");
  if (exists) {
    return new Response(JSON.stringify({ ok: true, message: "already exists" }), { headers: { "Content-Type": "application/json" } });
  }
  const { error } = await sb.storage.createBucket("lead-documents", {
    public: false,
    fileSizeLimit: "25MB",
  });
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, message: "created" }), { headers: { "Content-Type": "application/json" } });
});
