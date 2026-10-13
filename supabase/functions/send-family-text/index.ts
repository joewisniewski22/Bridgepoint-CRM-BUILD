// Narrow text-message path for Declan's separate 62 app (Joe 2026-10-13). The 62 backend must NOT hold the lending
// system's master key, so it calls this function instead with a shared secret. This function can only text the few
// family numbers on its allowlist, only short messages, and only so many per day.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("FAMILY_TEXT_SECRET") || "";
const ALLOWED = (Deno.env.get("FAMILY_TEXT_ALLOWED") || "").split(",").map((s) => s.replace(/\D/g, "").slice(-10)).filter(Boolean);
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SECRET || req.headers.get("x-family-secret") !== SECRET) return json({ error: "not_authorized" }, 403);
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const to = String(body.to || ""), text = String(body.text || "").trim();
  const digits = to.replace(/\D/g, "").slice(-10);
  if (!digits || !ALLOWED.includes(digits)) return json({ error: "number_not_allowed" }, 403);
  if (!text || text.length > 320) return json({ error: "bad_text" }, 400);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await sb.from("family_text_log").select("id", { count: "exact", head: true }).eq("to_digits", digits).gte("created_at", since);
  if ((count || 0) >= 80) return json({ error: "daily_limit" }, 429);
  await sb.from("family_text_log").insert({ to_digits: digits });

  const res = await fetch(SUPABASE_URL + "/functions/v1/send-text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY },
    body: JSON.stringify({ to: "+1" + digits, text, fromName: "62 App" }),
  }).then((r) => r.json()).catch(() => null);
  return json(res && res.ok ? { ok: true } : { ok: false, error: "send_failed" }, res && res.ok ? 200 : 502);
});
