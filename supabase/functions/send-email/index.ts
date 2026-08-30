// Sends an outbound email through Postmark and logs it to the CRM.
// Called from the CRM frontend with the Supabase publishable (anon) key as the Bearer token.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const POSTMARK_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN")!;
const INBOUND_ADDRESS = Deno.env.get("POSTMARK_INBOUND_ADDRESS")!; // e.g. 1c3c...@inbound.postmarkapp.com
const FROM_ADDRESS = Deno.env.get("SEND_FROM_ADDRESS") || "leads@bplending.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOGO_URL = SUPABASE_URL + "/storage/v1/object/public/public-assets/logo.jpg";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function insertPlusTag(address: string, tag: string): string {
  const [user, domain] = address.split("@");
  return user + "+" + tag + "@" + domain;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildHtmlBody(text: string, photoUrl?: string | null): string {
  const lines = escapeHtml(text).split("\n").map((l) => l || "&nbsp;").join("<br>\n");
  const photoImg = photoUrl
    ? '<img src="' + photoUrl + '" alt="" width="64" height="64" style="border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:12px">'
    : "";
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1c1a15;line-height:1.5">' +
    lines +
    '<div style="margin-top:18px;display:flex;align-items:center">' + photoImg +
      '<img src="' + LOGO_URL + '" alt="Bridgepoint Lending" width="220" style="max-width:220px;height:auto;display:block">' +
    '</div>' +
  '</div>';
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const leadId: string | null = body.leadId || null;
    const to: string = body.to;
    const subject: string = body.subject;
    const text: string = body.text;
    const fromName: string | null = body.fromName || null;
    const fromUserId: string | null = body.fromUserId || null;
    // Each team member's own @bplending.com address, passed from the CRM
    // (their Team record's email field) — falls back to the shared address
    // for system-generated sends with no specific sender.
    const fromAddress: string = body.fromAddress || FROM_ADDRESS;
    const fromPhotoUrl: string | null = body.fromPhotoUrl || null;

    if (!to || !subject || !text) {
      return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });
    }

    const replyTo = leadId ? insertPlusTag(INBOUND_ADDRESS, leadId) : INBOUND_ADDRESS;

    const pmRes = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": POSTMARK_TOKEN,
      },
      body: JSON.stringify({
        From: fromName ? (fromName + " <" + fromAddress + ">") : fromAddress,
        To: to,
        ReplyTo: replyTo,
        Subject: subject,
        TextBody: text,
        HtmlBody: buildHtmlBody(text, fromPhotoUrl),
        MessageStream: "outbound",
      }),
    });
    const pmData = await pmRes.json();
    if (!pmRes.ok) {
      return new Response(JSON.stringify({ error: "postmark_error", detail: pmData }), { status: 502, headers: CORS_HEADERS });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const emailId = "em-" + crypto.randomUUID();

    await sb.from("emails").insert({
      id: emailId,
      lead_id: leadId,
      direction: "outbound",
      from_address: fromAddress,
      to_address: to,
      subject: subject,
      body: text,
      sent_by: fromUserId,
      postmark_message_id: pmData.MessageID,
    });

    if (leadId) {
      const { data: leadRow } = await sb.from("leads").select("activity").eq("id", leadId).single();
      const activity = (leadRow && leadRow.activity) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10),
        type: "email",
        text: "Emailed " + to + ": " + subject,
        author: fromName || "System",
      });
      await sb.from("leads").update({ activity: activity }).eq("id", leadId);
    }

    return new Response(JSON.stringify({ ok: true, messageId: pmData.MessageID }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
