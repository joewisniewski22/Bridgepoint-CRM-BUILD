// Staff-only diagnostics (10/10: Nicole's reply to an email we sent never reached the CRM inbox
// or Joe's Outlook). Lists Postmark's recent inbound messages and their webhook status, and can
// return one message's body. Read-only. Auth: the ad_followup_auth secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const pm = (path: string) => fetch("https://api.postmarkapp.com" + path, { headers: { Accept: "application/json", "X-Postmark-Server-Token": TOKEN } }).then((r) => r.json()).catch((e) => ({ error: String(e) }));

Deno.serve(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  if (typeof body.messageId === "string" && /^[0-9a-f-]{20,}$/i.test(body.messageId)) {
    const m: any = await pm("/messages/inbound/" + body.messageId + "/details");
    return json({ from: m.From, subject: m.Subject, date: m.Date, text: m.TextBody, attachments: (m.Attachments || []).map((a: any) => a.Name), status: m.Status });
  }
  const list: any = await pm("/messages/inbound?count=" + (Number(body.count) || 10) + "&offset=0");
  return json({ total: list.TotalCount, messages: (list.InboundMessages || []).map((m: any) => ({ id: m.MessageID, from: m.From, to: m.To, subject: m.Subject, date: m.Date, status: m.Status })), raw: list.InboundMessages ? undefined : list });
});
