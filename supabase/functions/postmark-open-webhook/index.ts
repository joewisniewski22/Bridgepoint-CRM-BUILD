// Postmark's Delivery/Open/Bounce webhooks, all pointed at this one URL
// (configured in the Postmark dashboard: Server > Webhooks > add this
// function's URL, check "Delivery", "Open", and "Bounce"). RecordType tells
// them apart. This is what actually confirms "did it arrive," not just "did
// the API accept it" -- send-email's own response only ever confirms the
// latter, and a real submission (Stormfield, 2026-09-14) silently bounced
// after reporting success, with nobody finding out until Joe asked directly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function textOwner(text: string) {
  const { data: owner } = await sb.from("users").select("phone").eq("id", "owner").single();
  if (!owner?.phone) return;
  await fetch(SUPABASE_URL + "/functions/v1/send-text", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
    body: JSON.stringify({ to: owner.phone, text, fromName: "Bridgepoint CRM" }),
  }).catch(() => {});
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  }
  try {
    const body = await req.json();
    const recordType: string = body.RecordType || "Open"; // Open events omit RecordType on some Postmark accounts
    const messageId: string | null = body.MessageID || null;
    if (!messageId) return new Response(JSON.stringify({ ok: true, skipped: "no_message_id" }));

    const { data: emailRow } = await sb.from("emails")
      .select("id,subject,to_address,opened_at,open_count,delivery_status")
      .eq("postmark_message_id", messageId).single();
    if (!emailRow) return new Response(JSON.stringify({ ok: true, skipped: "unknown_message" }));

    if (recordType === "Delivery") {
      await sb.from("emails").update({
        delivery_status: "delivered",
        delivered_at: body.DeliveredAt || new Date().toISOString(),
      }).eq("id", emailRow.id);
      return new Response(JSON.stringify({ ok: true, recordType }));
    }

    if (recordType === "Bounce") {
      const isHard = body.Type === "HardBounce" || body.TypeCode === 1;
      await sb.from("emails").update({
        delivery_status: isHard ? "bounced" : "soft_bounced",
        bounced_at: body.BouncedAt || new Date().toISOString(),
        bounce_reason: body.Description || body.Details || body.Type || "Unknown",
      }).eq("id", emailRow.id);
      // A bounce is a real "this never arrived" event -- always worth a
      // text, not just first-time, since each bounce is its own new failure.
      const alertText = "⚠ Email bounced -- \"" + emailRow.subject + "\" to " + emailRow.to_address + " (" + (body.Description || body.Type || "bounced") + ")";
      await sb.from("notifications").insert({
        id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: null,
        kind: "email-bounced", text: alertText, date: new Date().toISOString().slice(0, 10), read: false,
      });
      await textOwner(alertText);
      return new Response(JSON.stringify({ ok: true, recordType }));
    }

    // Open (default/fallback for accounts that omit RecordType on this event)
    const recipient: string | null = body.Recipient || null;
    const firstOpen: boolean = body.FirstOpen === true;
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
      await textOwner(alertText);
    }

    return new Response(JSON.stringify({ ok: true, recordType, firstOpen: isFirst }));
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500 });
  }
});
