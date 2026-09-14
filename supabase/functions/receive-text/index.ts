// Telnyx's webhook for both inbound texts (message.received) and outbound
// delivery status (message.finalized), pointed at this one URL -- same
// "one URL, branch on event type" pattern as postmark-open-webhook.
// Configure in the Telnyx portal: Messaging Profile > Webhooks.
//
// Replaces the old Quo-based version (2026-09-14). Quo's inbound webhook
// payload shape was never fully confirmed (its docs disagreed with
// themselves), and Quo gave no reliable outbound delivery confirmation at
// all -- a batch of test sends all returned ok:true but never arrived,
// with nobody finding out until Joe tested it directly. Telnyx's webhook
// shape is well-documented and message.finalized gives a real per-
// recipient delivered/failed status, so that class of silent failure is
// now actually detectable.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function dialLink(leadPhone: string, fromNumber?: string | null): string {
  const digits = (leadPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  const e164 = digits.length === 10 ? ("+1" + digits) : ("+" + digits);
  let url = "tel:" + encodeURIComponent(e164);
  return url;
}

// Translates an inbound client message to English when the lead has a
// non-English communication language set (see index.html's Client
// Language select + setCommLanguage). Falls back to the original text on
// any failure -- a missed translation should never lose or block a real
// inbound message.
async function maybeTranslateToEnglish(text: string, preferredLanguage: string | null | undefined): Promise<{ text: string; wasTranslated: boolean; original: string }> {
  if (!preferredLanguage || preferredLanguage === "en") return { text, wasTranslated: false, original: text };
  try {
    const res = await fetch(SUPABASE_URL + "/functions/v1/translate-message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ text, targetLanguage: "English" }),
    });
    const data = await res.json();
    if (res.ok && data && data.ok && data.translated) {
      return { text: data.translated as string, wasTranslated: true, original: text };
    }
  } catch (_e) { /* fall through to original below */ }
  return { text, wasTranslated: false, original: text };
}

interface TelnyxPhone { phone_number?: string; status?: string; }
interface TelnyxPayload {
  id?: string;
  direction?: string;
  from?: TelnyxPhone;
  to?: TelnyxPhone[];
  text?: string;
  errors?: Array<{ title?: string; detail?: string }>;
}

async function handleInbound(payload: TelnyxPayload) {
  const fromNumber = payload.from?.phone_number || null;
  const text = payload.text || "";
  if (!fromNumber) return { ok: true, skipped: "no_from_number" };

  if (text.indexOf(CRM_URL) !== -1) {
    // This IS one of our own system-generated alerts (they always contain
    // a CRM link) being echoed back as a "received" event on the
    // recipient staff member's own line -- never real lead content.
    // Without this check, alerting a staff member (whose number is also a
    // monitored line) can loop forever: alert -> reported as received ->
    // alert again about "receiving" our own alert.
    return { ok: true, ignoredEcho: true };
  }

  const senderDigits = fromNumber.replace(/\D/g, "");

  // Check staff/system numbers BEFORE lead numbers -- if a sender number
  // happens to also belong to a staff member (or is our shared send-from
  // line), that takes priority so a coincidental overlap with a lead's
  // phone can never misroute a staff/system message as borrower content.
  const { data: staffRows } = await sb.from("users").select("id, name, phone, quo_phone_number");
  const staffMatch = (staffRows || []).find((u: Record<string, unknown>) => {
    const phones = [u.phone as string, u.quo_phone_number as string].filter(Boolean);
    return phones.some((p) => p.replace(/\D/g, "").slice(-10) === senderDigits.slice(-10));
  });

  const { data: leads } = await sb.from("leads").select("id, phone, name, activity, assigned_to, automation_paused, ai_stage, preferred_language");
  const match = staffMatch ? undefined : (leads || []).find((l: Record<string, unknown>) => {
    const phone = (l.phone as string) || "";
    return phone.replace(/\D/g, "").slice(-10) === senderDigits.slice(-10);
  });

  if (match) {
    const { text: textForLog, wasTranslated } = await maybeTranslateToEnglish(text, match.preferred_language as string | undefined);
    const activity = (match.activity as unknown[]) || [];
    activity.push({
      date: new Date().toISOString().slice(0, 10),
      type: "text",
      text: "Received (via Telnyx): " + textForLog + (wasTranslated ? (' [original: "' + text + '"]') : ""),
      author: (match.name as string) || "Borrower",
    });
    await sb.from("leads").update({ activity }).eq("id", match.id as string);

    if (match.assigned_to) {
      await sb.from("notifications").insert({
        id: "N" + crypto.randomUUID().slice(0, 8),
        to_user_id: match.assigned_to,
        lead_id: match.id,
        kind: "text",
        text: (match.name as string) + " replied: " + textForLog.slice(0, 80),
        date: new Date().toISOString().slice(0, 10),
        read: false,
      });

      // Always alert the assigned LO for real (text + email), not just the
      // in-app notification above -- a client engaging is time-sensitive.
      // If they're mid-conversation with the AI (ai_stage set), that's the
      // hottest possible signal -- a real person actively engaging right
      // now -- so it gets URGENT framing and a one-tap call link, sent to
      // their actual personal cell (users.phone), not their business line,
      // since staff don't reliably check a separate texting app.
      const { data: lo } = await sb.from("users").select("name,phone,email,quo_phone_number").eq("id", match.assigned_to).single();
      if (lo) {
        const link = CRM_URL + "?lead=" + match.id;
        const isHotAiEngagement = !!match.ai_stage;
        const call = match.phone ? dialLink(match.phone as string) : "";
        const alertText = (isHotAiEngagement ? "🚨 URGENT HOT LEAD — " : "") +
          (match.name as string) + " replied: \"" + textForLog.slice(0, 100) + "\" — " + link +
          (call ? ("\nCall now: " + call) : "");
        if (lo.phone) {
          fetch(SUPABASE_URL + "/functions/v1/send-text", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
            body: JSON.stringify({ to: lo.phone, text: alertText, fromName: "Bridgepoint CRM" }),
          }).catch(() => {});
        }
        if (lo.email) {
          fetch(SUPABASE_URL + "/functions/v1/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
            body: JSON.stringify({ to: lo.email, subject: (match.name as string) + " just replied", text: alertText, fromName: "Bridgepoint CRM" }),
          }).catch(() => {});
        }
      }
    }

    // TCPA opt-out: honor STOP-family keywords immediately, before any AI
    // hand-off -- this overrides everything else, including a busy LO
    // alert flow. Standard CTIA keywords, checked as the whole (trimmed)
    // message, case-insensitive.
    const isOptOut = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(text.trim());
    if (isOptOut) {
      const optOutActivity = [...activity, {
        date: new Date().toISOString().slice(0, 10), type: "system",
        text: "Client replied STOP -- automation paused (TCPA opt-out)", author: "System",
      }];
      await sb.from("leads").update({ automation_paused: true, activity: optOutActivity }).eq("id", match.id as string);
      if (match.phone) {
        fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ leadId: match.id, to: match.phone, text: "You've been unsubscribed from automated texts from Bridgepoint Lending. Reply if you'd like to speak with your loan officer directly.", initiatedBy: "ai" }),
        }).catch(() => {});
      }
    } else if (match.ai_stage && !match.automation_paused) {
      // Hand off to the AI conversion-texting automation, if this lead is
      // enrolled (ai_stage set) and the LO hasn't hit Stop Automation.
      // A failed handoff here used to fail silently -- the client's text
      // would sit unanswered with zero trace of anything going wrong.
      // Now logs (visible in this function's Supabase logs) so a bad
      // batch is at least discoverable, and retries once after a beat in
      // case it was a transient blip (cold start, momentary API error).
      const engage = () => fetch(SUPABASE_URL + "/functions/v1/ai-lead-engage", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ leadId: match.id }),
      });
      let engageRes = await engage().catch((e) => { console.error("receive-text: ai-lead-engage handoff failed (attempt 1)", String(e)); return null; });
      let engageData = engageRes ? await engageRes.json().catch(() => null) : null;
      if (!engageRes || !engageRes.ok || !engageData || engageData.error) {
        console.error("receive-text: ai-lead-engage handoff bad result, retrying once", JSON.stringify(engageData));
        await new Promise((r) => setTimeout(r, 1500));
        engageRes = await engage().catch((e) => { console.error("receive-text: ai-lead-engage handoff failed (attempt 2)", String(e)); return null; });
        engageData = engageRes ? await engageRes.json().catch(() => null) : null;
        if (!engageRes || !engageRes.ok || !engageData || engageData.error) {
          console.error("receive-text: ai-lead-engage handoff failed twice for lead", match.id, JSON.stringify(engageData));
        }
      }
    }
    return { ok: true, matched: true };
  } else if (staffMatch) {
    // Not a borrower's own number -- staff member replying to a portal
    // chat notification from their own phone. SMS has no thread ID, so
    // route to whichever of this staff member's leads most recently has
    // an unanswered borrower portal message (the last portal_chat entry
    // is still "from: borrower"). Imperfect if a staff member has more
    // than one open portal conversation at once, but it's the best signal
    // available without per-lead phone numbers.
    const { data: staffLeads } = await sb.from("leads").select("id, portal_chat").eq("assigned_to", staffMatch.id as string);
    let target: Record<string, unknown> | null = null;
    let targetTs = "";
    for (const l of staffLeads || []) {
      const chat = (l.portal_chat as Array<Record<string, unknown>>) || [];
      const last = chat[chat.length - 1];
      if (last && last.from === "borrower" && (last.ts as string) > targetTs) {
        target = l;
        targetTs = last.ts as string;
      }
    }
    if (target) {
      const chat = ((target.portal_chat as unknown[]) || []).slice();
      chat.push({ from: "lo", text: text, ts: new Date().toISOString(), authorName: staffMatch.name });
      await sb.from("leads").update({ portal_chat: chat }).eq("id", target.id as string);
      return { ok: true, routedToPortalChat: target.id };
    }
    console.log("receive-text: staff sender matched but no open portal thread", staffMatch.id);
    return { ok: true, matched: false };
  } else {
    console.log("receive-text: no lead or staff matched sender", fromNumber);
    return { ok: true, matched: false };
  }
}

// message.finalized: Telnyx's real per-recipient delivery outcome for a
// message we sent. Finds the activity entry this send logged (matched by
// telnyxMessageId, set in send-text) and updates its delivery status in
// place, and texts the owner on a real failure -- the exact gap that let
// the Quo failures go unnoticed until Joe found them by testing directly.
async function handleFinalized(payload: TelnyxPayload) {
  const messageId = payload.id;
  if (!messageId) return { ok: true, skipped: "no_message_id" };
  const recipient = payload.to && payload.to[0];
  const status = recipient?.status || "unknown"; // "delivered" | "delivery_failed" | "sending_failed" | ...
  const failed = status !== "delivered";

  // activity lives inside each lead's JSON blob, not its own table, so
  // finding "the lead this message belongs to" means searching for the
  // matching telnyxMessageId across leads with a recent outbound text.
  const { data: candidates } = await sb.from("leads")
    .select("id, activity")
    .contains("activity", [{ telnyxMessageId: messageId }] as unknown as Record<string, unknown>);
  const lead = (candidates || [])[0];
  if (!lead) return { ok: true, skipped: "no_matching_lead" };

  const activity = (lead.activity as Array<Record<string, unknown>>) || [];
  const idx = activity.findIndex((a) => a.telnyxMessageId === messageId);
  if (idx === -1) return { ok: true, skipped: "no_matching_activity_entry" };

  activity[idx] = { ...activity[idx], deliveryStatus: failed ? "failed" : "delivered" };
  await sb.from("leads").update({ activity }).eq("id", lead.id as string);

  if (failed) {
    const errDetail = (payload.errors && payload.errors[0] && (payload.errors[0].detail || payload.errors[0].title)) || status;
    const preview = String(activity[idx].text || "").slice(0, 80);
    const alertText = "⚠ Text failed to deliver -- \"" + preview + "\" (" + errDetail + ")";
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: lead.id,
      kind: "text-failed", text: alertText, date: new Date().toISOString().slice(0, 10), read: false,
    });
    const { data: owner } = await sb.from("users").select("phone").eq("id", "owner").single();
    if (owner?.phone) {
      fetch(SUPABASE_URL + "/functions/v1/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: owner.phone, subject: "", text: alertText, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
  }
  return { ok: true, leadId: lead.id, status };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const eventType: string = (body.data && body.data.event_type) || "";
    const payload: TelnyxPayload = (body.data && body.data.payload) || {};

    if (eventType === "message.received") {
      const result = await handleInbound(payload);
      return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
    }
    if (eventType === "message.finalized") {
      const result = await handleFinalized(payload);
      return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ ok: true, skipped: "unhandled_event_type", eventType }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
