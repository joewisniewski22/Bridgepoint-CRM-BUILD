// Staff-only diagnostics (10/10: Joe pressed 1 on a new-lead ring, connected to Ida, heard her,
// but she couldn't hear him). Reads Telnyx's own call event log -- read-only.
// Auth: the ad_followup_auth secret. Telnyx ignores the time/session filters on this endpoint,
// so we page through (oldest first) and keep only the events inside [from, to].
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const from = Date.parse(String(body.from || "")), to = Date.parse(String(body.to || ""));
  if (!from || !to) return json({ error: "from and to required" }, 400);
  const startPage = Math.max(1, Number(body.startPage) || 1);
  const out: unknown[] = [];
  let page = startPage, lastSeen = "", pagesRead = 0;
  for (; pagesRead < 40; page++, pagesRead++) {
    const r = await fetch("https://api.telnyx.com/v2/call_events?page[size]=250&page[number]=" + page, { headers: { Authorization: "Bearer " + TELNYX_API_KEY } }).then((x) => x.json()).catch(() => null);
    const rows = (r && r.data) || [];
    if (!rows.length) break;
    let past = false;
    for (const e of rows) {
      const t = Date.parse(e.occurred_at.replace(" ", "T") + (/[zZ+]/.test(e.occurred_at.slice(19)) ? "" : "Z"));
      lastSeen = e.occurred_at;
      if (t > to) { past = true; continue; }
      if (t < from) continue;
      const m = (e.payload && Object.keys(e.payload).length ? e.payload : e.metadata) || {}; const p = m.payload || m;
      if (body.raw === true) { out.push({ at: e.occurred_at, name: e.name, metadata: m }); continue; }
      out.push({ at: e.occurred_at, name: e.name, session: p.call_session_id, leg: p.call_leg_id, from: p.from, to: p.to, direction: p.direction, state: p.state,
        hangup_cause: p.hangup_cause, sip_code: p.sip_hangup_cause, quality: p.call_quality_stats || undefined, client_state: p.client_state ? "yes" : undefined });
    }
    if (past) break;
  }
  return json({ count: out.length, pagesRead, nextPage: page, lastSeen, events: out });
});
