// Postmark's Open Tracking webhook -- configured in the Postmark dashboard
// (Server > Webhooks > add this function's URL, check "Open"). Fires once
// per real open (FirstOpen flags the very first one). We only notify Joe on
// FirstOpen per email so re-opens don't spam him -- he asked "I want to know
// when they have opened it", which is a first-open question, not a
// read-count question.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  }
  try {
    const body = await req.json();
    if (body.RecordType && body.RecordType !== "Open") {
      // Postmark can be configured to send other event types to the same
      // URL -- ignore anything that isn't an Open event rather than erroring.
      return new Response(JSON.stringify({ ok: true, ignored: body.RecordType }));
    }
    const messageId: string | null = body.MessageID || null;
    const recipient: string | null = body.Recipient || null;
    const firstOpen: boolean = body.FirstOpen === true;
    if (!messageId) return new Response(JSON.stringify({ ok: true, skipped: "no_message_id" }));

    const { data: emailRow } = await sb.from("emails").select("id,subject,to_address,opened_at,open_count")
      .eq("postmark_message_id", messageId).single();
    if (!emailRow) return new Response(JSON.stringify({ ok: true, skipped: "unknown_message" }));

    const isFirst = firstOpen || !emailRow.opened_at;
    await sb.from("emails").update({
      open_count: (emailRow.open_count || 0) + 1,
      opened_at: emailRow.opened_at || new Date().toISOString(),
    }).eq("id", emailRow.id);

    if (isFirst) {
      const { data: recipientUser } = await sb.from("users").select("name").eq("email", recipient || emailRow.to_address).maybeSingle();
      const who = recipientUser?.name || recipient || emailRow.to_address;
      const alertText = "📖 " + who + " opened your email: \"" + emailRow.subject + "\"";
      await sb.from("notifications").insert({
        id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: null,
        kind: "email-opened", text: alertText, date: new Date().toISOString().slice(0, 10), read: false,
      });
      const { data: owner } = await sb.from("users").select("phone").eq("id", "owner").single();
      if (owner?.phone) {
        fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: owner.phone, text: alertText, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify({ ok: true, firstOpen: isFirst }));
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500 });
  }
});
