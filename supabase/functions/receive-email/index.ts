// Receives Postmark's inbound webhook when someone replies to a CRM email
// and files it onto the matching lead. Deploy with JWT verification OFF —
// Postmark calls this directly and does not send a Supabase auth header.
//
// Also auto-files attachments: if the sender matches a Title Company or
// Insurance Agent contact on the lead, their attachment is filed as a
// Title Commitment / Insurance Policy document automatically.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface ThirdParty {
  role?: string;
  email?: string;
}
interface DocEntry {
  name: string;
  status: string;
  receivedAt?: string;
  fileName?: string;
  storagePath?: string;
  requestedAt?: string;
}
interface Attachment {
  Name?: string;
  Content?: string;
  ContentType?: string;
}

function extractPlusTag(address: string): string | null {
  const match = address.match(/\+([^@]+)@/);
  return match ? match[1] : null;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function docLabelForRole(role: string | undefined): string | null {
  if (role === "Title Company") return "Title Commitment";
  if (role === "Insurance Agent") return "Insurance Policy";
  return null;
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
    const attachments: Attachment[] = Array.isArray(payload.Attachments) ? payload.Attachments : [];

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
      const { data: leadRow } = await sb.from("leads")
        .select("activity, assigned_to, name, third_parties, documents")
        .eq("id", leadId).single();

      if (leadRow) {
        const activity = leadRow.activity || [];
        const documents: DocEntry[] = leadRow.documents || [];
        const thirdParties: ThirdParty[] = leadRow.third_parties || [];
        const matchedTp = thirdParties.find((tp) => (tp.email || "").toLowerCase() === fromAddress.toLowerCase());
        const docLabel = matchedTp ? docLabelForRole(matchedTp.role) : null;

        const filedNames: string[] = [];
        for (const att of attachments) {
          if (!att.Content || !att.Name) continue;
          const bytes = base64ToBytes(att.Content);
          const safeName = att.Name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const path = leadId + "/" + Date.now() + "-" + safeName;
          const { error: upErr } = await sb.storage.from("lead-documents").upload(path, bytes, {
            contentType: att.ContentType || "application/octet-stream",
            upsert: false,
          });
          if (upErr) continue;

          const name = docLabel || att.Name;
          filedNames.push(name);
          const existingIdx = documents.findIndex((d) => d.name === name && d.status !== "received");
          const docEntry: DocEntry = {
            name,
            status: "received",
            receivedAt: new Date().toISOString().slice(0, 10),
            fileName: att.Name,
            storagePath: path,
          };
          if (existingIdx !== -1) documents[existingIdx] = Object.assign({}, documents[existingIdx], docEntry);
          else documents.push(docEntry);
        }

        activity.push({
          date: new Date().toISOString().slice(0, 10),
          type: filedNames.length ? "document" : "email-in",
          text: filedNames.length
            ? filedNames.join(", ") + " received via email from " + fromAddress
            : "Reply received from " + fromAddress + ": " + subject,
          author: leadRow.name || "Borrower",
        });

        await sb.from("leads").update({ activity: activity, documents: documents }).eq("id", leadId);

        const notifyText = filedNames.length
          ? filedNames.join(", ") + " received from " + (matchedTp ? matchedTp.role : fromAddress)
          : "New email reply from " + (leadRow.name || fromAddress);

        if (leadRow.assigned_to) {
          await sb.from("notifications").insert({
            id: "notif-" + crypto.randomUUID(),
            to_user_id: leadRow.assigned_to,
            lead_id: leadId,
            kind: "email",
            text: notifyText,
            date: new Date().toISOString().slice(0, 10),
            read: false,
          });
        }

        // Title/insurance requests are coordinated through processing --
        // make sure they see it land too, not just the assigned LO.
        if (docLabel) {
          const { data: processors } = await sb.from("users").select("id").eq("role", "processor");
          for (const p of processors || []) {
            await sb.from("notifications").insert({
              id: "notif-" + crypto.randomUUID(),
              to_user_id: p.id,
              lead_id: leadId,
              kind: "email",
              text: docLabel + " returned for " + (leadRow.name || "a borrower") + " — " + notifyText,
              date: new Date().toISOString().slice(0, 10),
              read: false,
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
