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
// ctaUrl is always a real, code-constructed URL (never raw AI/template
// output) -- the marker survives escapeHtml untouched (no <, >, or &) and
// is swapped for a real anchor afterward, so this can never inject
// arbitrary HTML from a template body.
const CTA_MARKER = "@@CTA_LINK@@";
function buildHtmlBody(text: string, photoUrl?: string | null, ctaUrl?: string | null): string {
  var escaped = escapeHtml(text);
  if (ctaUrl) {
    escaped = escaped.split(CTA_MARKER).join('<a href="' + ctaUrl + '" style="color:#1b2a47;font-weight:600;text-decoration:underline">HERE</a>');
  }
  const lines = escaped.split("\n").map((l) => l || "&nbsp;").join("<br>\n");
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
    // Optional single PDF attachment (base64), e.g. a generated Pre-Approval
    // Letter / Term Sheet from the generate-doc-pdf function.
    const attachmentBase64: string | null = body.attachmentBase64 || null;
    const attachmentName: string | null = body.attachmentName || null;
    const attachmentContentType: string = body.attachmentContentType || "application/pdf";
    // Optional call-to-action link -- if the caller put the CTA_MARKER
    // token in `text` (instead of a raw URL), the HTML version renders it
    // as a real "HERE" hyperlink; the plain-text fallback just gets the URL.
    const ctaUrl: string | null = body.ctaUrl || null;
    // See send-text's initiatedBy for why this exists -- lets speed-to-lead
    // reporting count only genuine LO actions, not AI/automated ones.
    const initiatedBy: string = body.initiatedBy === "ai" ? "ai" : "staff";
    // Mailbox fields (2026-10-13): Cc/Bcc, any number of attachments (base64), and the draft this send came from (deleted once sent).
    const ccList: string = body.cc ? String(body.cc) : "";
    const bccList: string = body.bcc ? String(body.bcc) : "";
    const extraAtts: Array<{ name: string; contentType?: string; content: string }> = Array.isArray(body.attachments) ? body.attachments.filter((a: any) => a && a.name && a.content).slice(0, 10) : [];
    const draftId: string | null = body.draftId ? String(body.draftId) : null;

    if (!to || !subject || !text) {
      return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });
    }

    // This function is public (the anon key ships in the page), so without a
    // check anyone could send email from our domain to anyone -- which burns
    // the domain's sender reputation. Server jobs (service-role key) and
    // signed-in staff send freely; anyone else (borrower portal / application
    // page) may only email a staff member, or a lead's own address on a real file.
    const mailToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    let mailTrusted = mailToken === SERVICE_ROLE_KEY;
    const mailAuthSb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (!mailTrusted && mailToken) {
      const { data: u } = await mailAuthSb.auth.getUser(mailToken).catch(() => ({ data: null }));
      mailTrusted = !!(u && u.user);
    }
    if (!mailTrusted) {
      const target = (to || "").trim().toLowerCase();
      let allowed = false;
      const { data: staff } = await mailAuthSb.from("users").select("email");
      allowed = !!(staff || []).some((s: { email: string | null }) => (s.email || "").trim().toLowerCase() === target);
      if (!allowed && leadId) {
        const { data: lead } = await mailAuthSb.from("leads").select("email,co_email").eq("id", leadId).maybeSingle();
        // the file's own address, or its co-borrower's address, are valid recipients
        allowed = !!(lead && ((lead.email || "").trim().toLowerCase() === target || (lead.co_email || "").trim().toLowerCase() === target));
      }
      if (!allowed) {
        return new Response(JSON.stringify({ error: "not_authorized" }), { status: 403, headers: CORS_HEADERS });
      }
    }

    // Files the compose pane uploaded to private storage (drafts/<user>/<draft>/...) -- pulled in here so the browser never has to base64 them.
    const draftAttPaths: string[] = mailTrusted && Array.isArray(body.attachmentPaths)
      ? body.attachmentPaths.map((a: any) => String(a && a.path || "")).filter((p: string) => p.startsWith("drafts/") && !p.includes("..")).slice(0, 10)
      : [];
    for (const p of draftAttPaths) {
      const { data: blob } = await mailAuthSb.storage.from("mail-attachments").download(p);
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const orig = (body.attachmentPaths as any[]).find((a: any) => a && a.path === p);
      extraAtts.push({ name: (orig && orig.name) || p.split("/").pop()!.replace(/^\d+-/, ""), contentType: (orig && orig.contentType) || blob.type || "application/octet-stream", content: btoa(bin) });
    }

    const plainText = ctaUrl ? text.split(CTA_MARKER).join(ctaUrl) : text;
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
        // Optional CC (staff/server sends only -- anonymous callers are limited to
        // a staff member or the lead's own address above, so they can't use this).
        ...(mailTrusted && ccList ? { Cc: ccList } : {}),
        ...(mailTrusted && bccList ? { Bcc: bccList } : {}),
        ReplyTo: replyTo,
        Subject: subject,
        TextBody: plainText,
        HtmlBody: buildHtmlBody(text, fromPhotoUrl, ctaUrl),
        MessageStream: "outbound",
        TrackOpens: true,
        ...((attachmentBase64 && attachmentName) || (mailTrusted && extraAtts.length) ? {
          Attachments: (attachmentBase64 && attachmentName ? [{ Name: attachmentName, Content: attachmentBase64, ContentType: attachmentContentType }] : [])
            .concat(mailTrusted ? extraAtts.map((a) => ({ Name: a.name, Content: a.content, ContentType: a.contentType || "application/octet-stream" })) : []),
        } : {}),
      }),
    });
    const pmData = await pmRes.json();
    if (!pmRes.ok) {
      return new Response(JSON.stringify({ error: "postmark_error", detail: pmData }), { status: 502, headers: CORS_HEADERS });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const emailId = "em-" + crypto.randomUUID();

    // Mailbox fields: whose mailbox, which folder, which conversation, and the attachments (copied into private storage so they open later).
    let mailboxUser: string | null = fromUserId;
    if (!mailboxUser && leadId) {
      const { data: lr } = await sb.from("leads").select("assigned_to").eq("id", leadId).maybeSingle();
      mailboxUser = (lr && lr.assigned_to) || null;
    }
    const attMeta: Array<{ name: string; size: number; contentType: string; path: string | null }> = [];
    const allAtts = (attachmentBase64 && attachmentName ? [{ name: attachmentName, contentType: attachmentContentType, content: attachmentBase64 }] : []).concat(mailTrusted ? extraAtts : []);
    for (const a of allAtts) {
      try {
        const bin = atob(a.content); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const safe = a.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = emailId + "/" + safe;
        const { error: upErr } = await sb.storage.from("mail-attachments").upload(path, bytes, { contentType: a.contentType || "application/octet-stream", upsert: true });
        attMeta.push({ name: a.name, size: bytes.length, contentType: a.contentType || "application/octet-stream", path: upErr ? null : path });
      } catch (_) { attMeta.push({ name: a.name, size: 0, contentType: a.contentType || "", path: null }); }
    }
    const isAutomated = initiatedBy === "ai" || !fromUserId;
    const threadKey = subject.toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "") + "|" + (leadId || to.trim().toLowerCase());
    await sb.from("emails").insert({
      id: emailId,
      lead_id: leadId,
      direction: "outbound",
      from_address: fromAddress,
      to_address: to,
      subject: subject,
      body: plainText,
      sent_by: fromUserId,
      postmark_message_id: pmData.MessageID,
      mailbox_user_id: mailboxUser,
      folder: isAutomated ? "automated" : "sent",
      automated: isAutomated,
      is_read: true,
      cc_address: ccList || null,
      bcc_address: bccList || null,
      thread_key: threadKey,
      attachments: attMeta,
    });
    if (draftId) {
      await sb.from("emails").delete().eq("id", draftId).eq("folder", "drafts");
    }
    if (draftAttPaths.length) await sb.storage.from("mail-attachments").remove(draftAttPaths).catch(() => {});

    if (leadId) {
      const { data: leadRow } = await sb.from("leads").select("activity").eq("id", leadId).single();
      const activity = (leadRow && leadRow.activity) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10),
        type: "email",
        text: "Emailed " + to + ": " + subject,
        author: fromName || "System",
        initiatedBy,
      });
      await sb.from("leads").update({ activity: activity }).eq("id", leadId);
    }

    return new Response(JSON.stringify({ ok: true, messageId: pmData.MessageID }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
