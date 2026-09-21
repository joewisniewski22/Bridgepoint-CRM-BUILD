// Inbound webhook for the company number's Telnyx messaging profile
// (message.received = a client/staff text arriving; message.finalized = the
// carrier's final verdict on something we sent). Replaced the Quo webhook
// 2026-09-21. A failed delivery is logged onto the lead so it isn't silent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type Extracted =
  | { kind: "message"; from: string | null; to: string | null; text: string; direction: string }
  | { kind: "receipt"; to: string | null; status: string; detail: string }
  | { kind: "ignore" };

function extractMessage(body: Record<string, unknown>): Extracted | null {
  const data = (body.data as Record<string, unknown>) || {};
  if (typeof data.event_type !== "string" || !data.payload || typeof data.payload !== "object") return null;
  const p = data.payload as Record<string, unknown>;
  const toArr = Array.isArray(p.to) ? (p.to as Array<Record<string, unknown>>) : [];

  if (data.event_type === "message.finalized") {
    const errors = Array.isArray(p.errors) ? (p.errors as Array<Record<string, unknown>>) : [];
    return {
      kind: "receipt",
      to: (toArr[0]?.phone_number as string) || null,
      status: (toArr[0]?.status as string) || "",
      detail: (errors[0]?.detail as string) || (errors[0]?.title as string) || "",
    };
  }
  if (data.event_type !== "message.received") return { kind: "ignore" };

  const from = (p.from as Record<string, unknown> | undefined)?.phone_number as string | undefined;
  return {
    kind: "message",
    from: from || null,
    to: (toArr[0]?.phone_number as string) || null,
    text: typeof p.text === "string" ? p.text : "",
    direction: (p.direction as string) || "inbound",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const extracted = extractMessage(body);
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (!extracted) {
      // Log the raw payload shape so it can be inspected without losing the event.
      console.log("receive-text: unrecognized payload", JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true, note: "payload not recognized, logged for inspection" }), { headers: CORS_HEADERS });
    }
    if (extracted.kind === "ignore") {
      return new Response(JSON.stringify({ ok: true, ignored: "non-received telnyx event" }), { headers: CORS_HEADERS });
    }

    if (extracted.kind === "receipt") {
      // Carrier's final verdict on something we sent. Only failures matter --
      // Telnyx accepts a send instantly, so a blocked/undeliverable text would
      // otherwise vanish without a trace.
      const failed = ["delivery_failed", "sending_failed", "delivery_unconfirmed"].indexOf(extracted.status) !== -1;
      if (!failed || !extracted.to) return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
      const toDigits = extracted.to.replace(/\D/g, "").slice(-10);
      const { data: allLeads } = await sb.from("leads").select("id, phone, name, activity, assigned_to");
      const lead = (allLeads || []).find((l: Record<string, unknown>) => ((l.phone as string) || "").replace(/\D/g, "").slice(-10) === toDigits);
      if (lead) {
        const d = new Date().toISOString().slice(0, 10);
        const activity = (lead.activity as unknown[]) || [];
        activity.push({ date: d, type: "system", text: "Text to " + extracted.to + " was NOT delivered" + (extracted.detail ? (": " + extracted.detail) : ""), author: "System" });
        await sb.from("leads").update({ activity }).eq("id", lead.id as string);
        if (lead.assigned_to) {
          await sb.from("notifications").insert({
            id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: lead.assigned_to, lead_id: lead.id, kind: "text",
            text: "Your text to " + (lead.name as string) + " wasn't delivered" + (extracted.detail ? (" — " + extracted.detail) : ""),
            date: d, read: false,
          });
        }
      }
      return new Response(JSON.stringify({ ok: true, loggedFailure: !!lead }), { headers: CORS_HEADERS });
    }

    const msg = extracted;
    if (!msg.from) {
      console.log("receive-text: message without a sender", JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true, note: "no sender" }), { headers: CORS_HEADERS });
    }
    if (msg.direction === "outgoing" || msg.direction === "outbound") {
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }
    if (msg.text.indexOf(CRM_URL) !== -1) {
      // One of our own system alerts (they always contain a CRM link) coming
      // back as a "received" event -- never real lead content. Ignoring it
      // guards against an alert -> reply -> alert loop.
      console.log("receive-text: ignoring echo of our own system message");
      return new Response(JSON.stringify({ ok: true, ignoredEcho: true }), { headers: CORS_HEADERS });
    }

    const senderDigits = msg.from.replace(/\D/g, "");

    // Check staff numbers BEFORE lead numbers -- if a sender number happens to
    // also belong to a staff member, that takes priority so a coincidental
    // overlap with a lead's phone can never misroute a staff message as
    // borrower content.
    const { data: staffRows } = await sb.from("users").select("id, name, phone");
    const staffMatch = (staffRows || []).find((u: Record<string, unknown>) => {
      const p = (u.phone as string) || "";
      return !!p && p.replace(/\D/g, "").slice(-10) === senderDigits.slice(-10);
    });

    const { data: leads } = await sb.from("leads").select("id, phone, name, activity, assigned_to, automation_paused, ai_stage");
    const match = staffMatch ? undefined : (leads || []).find((l: Record<string, unknown>) => {
      const phone = (l.phone as string) || "";
      return phone.replace(/\D/g, "").slice(-10) === senderDigits.slice(-10);
    });

    if (match) {
      const activity = (match.activity as unknown[]) || [];
      activity.push({
        date: new Date().toISOString().slice(0, 10),
        type: "text",
        text: "Received (via Telnyx): " + msg.text,
        author: (match.name as string) || "Borrower",
      });
      await sb.from("leads").update({ activity }).eq("id", match.id as string);

      if (match.assigned_to) {
        await sb.from("notifications").insert({
          id: "N" + crypto.randomUUID().slice(0, 8),
          to_user_id: match.assigned_to,
          lead_id: match.id,
          kind: "text",
          text: (match.name as string) + " replied: " + msg.text.slice(0, 80),
          date: new Date().toISOString().slice(0, 10),
          read: false,
        });

        // Always alert the assigned LO for real (text + email), not just the
        // in-app notification above -- a client engaging is time-sensitive.
        // If they're mid-conversation with the AI (ai_stage set), that's the
        // hottest possible signal -- a real person actively engaging right
        // now -- so it gets URGENT framing, sent to their actual personal
        // cell (users.phone), since staff
        // reliably check other apps. Open the CRM link and use the Call
        // button there to dial (Telnyx power dialer).
        const { data: lo } = await sb.from("users").select("name,phone,email").eq("id", match.assigned_to).single();
        if (lo) {
          const link = CRM_URL + "?lead=" + match.id;
          const isHotAiEngagement = !!match.ai_stage;
          const alertText = (isHotAiEngagement ? "🚨 URGENT HOT LEAD — " : "") +
            (match.name as string) + " replied: \"" + msg.text.slice(0, 100) + "\" — " + link;
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
      const isOptOut = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(msg.text.trim());
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
    } else if (staffMatch) {
      // Joe's phone-system poll (2026-09-16): a bare "1" or "2" reply from
      // a staff member is a vote, not a portal-chat message -- capture it
      // and stop, before falling through to the portal-chat guess below.
      // One-off for this specific poll, not a general poll feature.
      const bareDigit = msg.text.trim();
      if (bareDigit === "1" || bareDigit === "2") {
        const vote = bareDigit === "1" ? "softphone_in_crm" : "ring_cell_first";
        await sb.from("team_polls").upsert({
          id: "poll-phone_system_2026_09_16-" + staffMatch.id,
          poll_key: "phone_system_2026_09_16",
          staff_id: staffMatch.id,
          vote,
          raw_text: msg.text,
        }, { onConflict: "poll_key,staff_id" });
        console.log("receive-text: captured poll vote", staffMatch.id, vote);
        return new Response(JSON.stringify({ ok: true, pollVote: vote }), { headers: CORS_HEADERS });
      }
      // Not a borrower's own number -- staff member replying to a portal
      // chat notification from their own phone. SMS has no thread
      // ID, so route to whichever of this staff member's leads most
      // recently has an unanswered borrower portal message (the last
      // portal_chat entry is still "from: borrower"). Imperfect if a staff
      // member has more than one open portal conversation at once, but it's
      // the best signal available without per-lead phone numbers.
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
        chat.push({ from: "lo", text: msg.text, ts: new Date().toISOString(), authorName: staffMatch.name });
        await sb.from("leads").update({ portal_chat: chat }).eq("id", target.id as string);
        return new Response(JSON.stringify({ ok: true, routedToPortalChat: target.id }), { headers: CORS_HEADERS });
      }
      console.log("receive-text: staff sender matched but no open portal thread", staffMatch.id);
    } else {
      console.log("receive-text: no lead or staff matched sender", msg.from);
    }

    return new Response(JSON.stringify({ ok: true, matched: !!match }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
