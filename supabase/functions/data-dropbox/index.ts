// One-time data drop box (10/10: moving Insula portal data from the browser into a spreadsheet).
// A JSON upload is accepted only with a single-use code from data_dropbox (created by staff via
// SQL); the code is burned on use. Nothing can be read back through this endpoint.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch (_) { return new Response('{"error":"bad_request"}', { status: 400, headers: CORS }); }
  const code = String(body.code || "");
  if (!/^[a-f0-9]{32}$/.test(code)) return new Response('{"error":"bad_code"}', { status: 403, headers: CORS });
  const { data, error } = await sb.from("data_dropbox").update({ payload: body.data ?? null, used_at: new Date().toISOString() }).eq("code", code).is("used_at", null).select("code");
  if (error || !data || !data.length) return new Response('{"error":"code_used_or_unknown"}', { status: 403, headers: CORS });
  return new Response('{"ok":true}', { headers: CORS });
});
