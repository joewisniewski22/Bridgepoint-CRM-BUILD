// Inbound webhook for texts received via Quo (formerly OpenPhone). Point
// Quo's webhook (message.received event) at this function's URL.
//
// Quo's own docs disagree with themselves on the exact payload shape across
// two doc versions found during setup, so this parses defensively and
// accepts either the newer nested shape or the older flatter one rather
// than assuming one is correct. If Quo's real payload turns out to be a
// third shape, check the "raw" activity note this logs and adjust.
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

function extractMessage(body: Record<string, unknown>) {
  const data = (body.data as Record<string, unknown>) || {};
  // Newer shape: data.resource.text / data.context.senderIdentifier / recipientIdentifiers
  const resource = data.resource as Record<string, unknown> | undefined;
  const context = data.context as Record<string, unknown> | undefined;
  if (resource && typeof resource.text === "string") {
    return {
      from: (context && (context.senderIdentifier as string)) || null,
      to: (context && Array.isArray(context.recipientIdentifiers) ? (context.recipientIdentifiers as string[])[0] : null),
      text: resource.text as string,
      direction: (resource.direction as string) || "incoming",
    };
  }
  // Older shape: data.object.from / to / body
  const obj = data.object as Record<string, unknown> | undefined;
  if (obj && typeof obj.body === "string") {
    return {
      from: (obj.from as string) || null,
      to: Array.isArray(obj.to) ? (obj.to as string[])[0] : (obj.to as string) || null,
      text: obj.body as string,
      direction: (obj.direction as string) || "incoming",
    };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const msg = extractMessage(body);
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (!msg || !msg.from) {
      // Log the raw payload shape so it can be inspected/fixed without losing the event.
      console.log("receive-text: unrecognized payload", JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true, note: "payload not recognized, logged for inspection" }), { headers: CORS_HEADERS });
    }
    if (msg.direction === "outgoing" || msg.direction === "outbound") {
      // Ignore delivery receipts for our own outbound sends.
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }
    if (msg.text.indexOf(CRM_URL) !== -1) {
      // This IS one of our own system-generated alerts (they always contain
      // a CRM link) being echoed back by Quo as a "received" event on the
      // recipient staff member's own line -- never real lead content. A
      // real client would essentially never text us this exact link back.
      // Without this check, alerting a staff member (whose number is also a
      // monitored Quo line) can loop forever: alert -> Quo reports it as
      // received -> we alert again about "receiving" our own alert.
      console.log("receive-text: ignoring echo of our own system message");
      return new Response(JSON.stringify({ ok: true, ignoredEcho: true }), { headers: CORS_HEADERS });
    }

    const senderDigits = msg.from.replace(/\D/g, "");

    // Check staff/system numbers BEFORE lead numbers -- if a sender number
    // happens to also belong to a staff member (or is our shared send-from
    // line), that takes priority so a coincidental overlap with a lead's
    // phone can never misroute a staff/system message as borrower content.
    const { data: staffRows } = await sb.from("users").select("id, name, phone, quo_phone_number");
    const staffMatch = (staffRows || []).find((u: Record<string, unknown>) => {
      const phones = [u.phone as string, u.quo_phone_number as string].filter(Boolean);
      return phones.some((p) => p.replace(/\D/g, "").slice(-10) === senderDigits.slice(-10));
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
        text: "Received (via Quo): " + msg.text,
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
        const { data: lo } = await sb.from("users").select("name,phone,email,quo_phone_number").eq("id", match.assigned_to).single();
        if (lo) {
          const link = CRM_URL + "?lead=" + match.id;
          const alertText = (match.name as string) + " replied: \"" + msg.text.slice(0, 100) + "\" — " + link;
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
            body: JSON.stringify({ leadId: match.id, to: match.phone, text: "You've been unsubscribed from automated texts from Bridgepoint Lending. Reply if you'd like to speak with your loan officer directly." }),
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
      // Not a borrower's own number -- staff member replying to a portal
      // chat notification from their own phone/Quo line. SMS has no thread
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
