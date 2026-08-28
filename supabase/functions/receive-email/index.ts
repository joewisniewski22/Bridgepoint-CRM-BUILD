// Receives Postmark's inbound webhook when someone replies to a CRM email
// and files it onto the matching lead. Deploy with JWT verification OFF —
// Postmark calls this directly and does not send a Supabase auth header.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function extractPlusTag(address: string): string | null {
  const match = address.match(/\+([^@]+)@/);
  return match ? match[1] : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  try {
    const payload = await req.json();
    const originalRecipient: string = payload.OriginalRecipient || payload.To || "";
    const leadId = extractPlusTag(originalRecipient);
    const fromAddress: string = payload.From || (payload.FromFull && payload.FromFull.Email) || "";
    const subject: string = payload.Subject || "(no subject)";
    const text: string = payload.StrippedTextReply || payload.TextBody || "";

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const emailId = "em-" + crypto.randomUUID();

    await sb.from("emails").insert({
      id: emailId,
      lead_id: leadId,
      direction: "inbound",
      from_address: fromAddress,
      to_address: originalRecipient,
      subject: subject,
      body: text,
      postmark_message_id: payload.MessageID,
    });

    if (leadId) {
      const { data: leadRow } = await sb.from("leads").select("activity, assigned_to, name").eq("id", leadId).single();
      if (leadRow) {
        const activity = leadRow.activity || [];
        activity.push({
          date: new Date().toISOString().slice(0, 10),
          type: "email-in",
          text: "Reply received from " + fromAddress + ": " + subject,
          author: leadRow.name || "Borrower",
        });
        await sb.from("leads").update({ activity: activity }).eq("id", leadId);

        if (leadRow.assigned_to) {
          await sb.from("notifications").insert({
            id: "notif-" + crypto.randomUUID(),
            to_user_id: leadRow.assigned_to,
            lead_id: leadId,
            kind: "email",
            text: "New email reply from " + (leadRow.name || fromAddress),
            date: new Date().toISOString().slice(0, 10),
            read: false,
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
