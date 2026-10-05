// One-click unsubscribe for CRM marketing emails (the Deal Analyzer campaign etc.).
// GET /email-unsubscribe?l=<leadId>&t=<token>  -> marks the lead nurture_off (no more automated messages), logs it,
// then sends the person to a confirmation page on bplending.com. The token is derived from the lead id, so links can't be guessed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const DONE = "https://bplending.com/unsubscribed/";

async function token(leadId: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(leadId + ":unsub:" + SERVICE_ROLE_KEY));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
const go = (ok: boolean) => new Response(null, { status: 302, headers: { Location: DONE + (ok ? "" : "?error=1") } });

Deno.serve(async (req: Request) => {
  try {
    const u = new URL(req.url);
    const id = (u.searchParams.get("l") || "").slice(0, 60), t = u.searchParams.get("t") || "";
    if (!id || t !== (await token(id))) return go(false);
    const { data: lead } = await sb.from("leads").select("activity").eq("id", id).maybeSingle();
    if (!lead) return go(false);
    const activity = Array.isArray(lead.activity) ? lead.activity : [];
    if (!activity.some((a: { text?: string }) => (a.text || "").indexOf("Unsubscribed from marketing email") === 0)) {
      activity.push({ date: new Date().toISOString().slice(0, 10), type: "system", text: "Unsubscribed from marketing email (clicked the unsubscribe link). Automated messages turned off for this contact.", author: "System" });
    }
    await sb.from("leads").update({ nurture_off: true, activity }).eq("id", id);
    return go(true);
  } catch (e) {
    console.error("email-unsubscribe", String(e));
    return go(false);
  }
});
