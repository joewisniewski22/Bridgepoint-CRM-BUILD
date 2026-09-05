// Safety net, not a nudge campaign: catches only leads whose LAST activity
// entry is a client message that never got any reply (the AI handoff in
// receive-text failed both its attempts, or some other gap). Never
// proactively re-pings someone who already got an answer and went quiet --
// that would be exactly the pushy behavior Joe explicitly doesn't want.
// Run on a schedule via pg_cron (see migration 053) so a stalled real
// question doesn't just sit there until someone happens to open the file.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { data: leads, error } = await sb
      .from("leads")
      .select("id, activity")
      .not("ai_stage", "is", null)
      .eq("automation_paused", false);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });

    const stalled: string[] = [];
    for (const lead of leads || []) {
      const activity = (lead.activity as Array<Record<string, unknown>>) || [];
      if (!activity.length) continue;
      const last = activity[activity.length - 1];
      // Only ever an inbound message with literally nothing after it --
      // never a lead that already got a reply and simply hasn't answered
      // back yet.
      if (last.type === "text" && typeof last.text === "string" && last.text.indexOf("Received (via Quo):") === 0) {
        stalled.push(lead.id as string);
      }
    }

    const results: Record<string, unknown>[] = [];
    for (const leadId of stalled) {
      const res = await fetch(SUPABASE_URL + "/functions/v1/ai-lead-engage", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ leadId }),
      }).catch((e) => null);
      const data = res ? await res.json().catch(() => null) : null;
      results.push({ leadId, ok: !!(res && res.ok && data && !data.error), data });
    }

    return new Response(JSON.stringify({ ok: true, checked: (leads || []).length, stalled: stalled.length, results }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
