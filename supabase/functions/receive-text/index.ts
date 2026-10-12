// Inbound webhook for the company number's Telnyx messaging profile
// (message.received = a client/staff text arriving; message.finalized = the
// carrier's final verdict on something we sent). Replaced the Quo webhook
// 2026-09-21. A failed delivery is logged onto the lead so it isn't silent.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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

const FORWARD_PREFIX = "[Business line] ";

// Relay an inbound text that has no loan officer to the owner's personal cell
// (Joe, 2026-10-03: "send everything to my cell phone unless the number is
// associated with a lead, then send that to the assigned LO"). Loop safety:
// never relays our own relays (prefix) or anything from the company number,
// and callers never pass the owner's own texts.
async function forwardToOwner(sb: ReturnType<typeof createClient>, from: string, text: string) {
  try {
    if (!text || text.indexOf(FORWARD_PREFIX) === 0) return;
    const companyDigits = (Deno.env.get("TELNYX_FROM_NUMBER") || "").replace(/\D/g, "").slice(-10);
    if (companyDigits && from.replace(/\D/g, "").slice(-10) === companyDigits) return;
    const { data: owner } = await sb.from("users").select("phone").eq("id", "owner").single();
    if (!owner || !owner.phone) return;
    if (owner.phone.replace(/\D/g, "").slice(-10) === from.replace(/\D/g, "").slice(-10)) return;
    const res = await fetch(SUPABASE_URL + "/functions/v1/send-text", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ to: owner.phone, text: FORWARD_PREFIX + "From " + from + ": " + text.slice(0, 400), fromName: "Bridgepoint CRM" }),
    });
    console.log("receive-text: forwarded text to owner", res.status);
  } catch (e) {
    console.error("receive-text: forward to owner failed", String(e));
  }
}

// Reply-by-text (Joe 2026-10-12): an LO answers a client by replying to the alert text. Safety rails, because on
// 2026-09-21 a stray staff text landed in a client's chat: only a reply within 2 hours of a client-text alert counts;
// it goes to that alert's client; if two different clients texted within 10 minutes of each other nothing is sent
// unless the reply starts with the client's first name ("Maria: ..."); every send is confirmed back to the LO.
const REPLY_WINDOW_MS = 2 * 60 * 60 * 1000;
const AMBIGUOUS_MS = 10 * 60 * 1000;
const LANG_NAMES: Record<string, string> = { es: "Spanish", vi: "Vietnamese" };
const firstNameOf = (n: string) => String(n || "").trim().split(/\s+/)[0] || "";

async function textStaff(phone: string | null | undefined, text: string) {
  if (!phone) return;
  await fetch(SUPABASE_URL + "/functions/v1/send-text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
    body: JSON.stringify({ to: phone, text, fromName: "Bridgepoint CRM" }),
  }).catch(() => {});
}

async function routeStaffReplyToClient(sb: ReturnType<typeof createClient>, staff: { id: string; name: string; phone: string }, rawText: string): Promise<boolean> {
  const text = (rawText || "").trim();
  if (!text || text.length > 600) return false;
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop|help)$/i.test(text)) return false;
  const since = new Date(Date.now() - REPLY_WINDOW_MS).toISOString();
  const { data: ctx } = await sb.from("staff_reply_context").select("lead_id,lead_name,created_at")
    .eq("staff_id", staff.id).gte("created_at", since).order("created_at", { ascending: false }).limit(20);
  if (!ctx || !ctx.length) return false;

  const distinct: Array<{ lead_id: string; lead_name: string; created_at: string }> = [];
  for (const r of ctx as Array<{ lead_id: string; lead_name: string; created_at: string }>) {
    if (!distinct.some((d) => d.lead_id === r.lead_id)) distinct.push(r);
  }
  let target = null as null | { lead_id: string; lead_name: string; created_at: string };
  let body = text;
  const pm = text.match(/^([^\s:,\-]{2,20})\s*[:,\-]\s*([\s\S]+)$/);
  if (pm) {
    const hit = distinct.find((d) => firstNameOf(d.lead_name).toLowerCase() === pm[1].toLowerCase());
    if (hit) { target = hit; body = pm[2].trim(); }
  }
  if (!target) {
    if (distinct.length > 1 && new Date(distinct[0].created_at).getTime() - new Date(distinct[1].created_at).getTime() < AMBIGUOUS_MS) {
      const names = distinct.slice(0, 3).map((d) => firstNameOf(d.lead_name)).join(", ");
      await textStaff(staff.phone, "Two clients texted you close together (" + names + "). Nothing was sent. Start your reply with the client's first name, like \"" +
        firstNameOf(distinct[0].lead_name) + ": your message\", or reply from the CRM.");
      return true;
    }
    target = distinct[0];
  }
  if (!body) return false;

  const { data: lead } = await sb.from("leads").select("id,name,phone,assigned_to,sms_opt_out,preferred_language").eq("id", target.lead_id).maybeSingle();
  if (!lead || !lead.phone) { await textStaff(staff.phone, "Couldn't send: no phone number on file for " + target.lead_name + "."); return true; }
  if (lead.sms_opt_out) { await textStaff(staff.phone, "Not sent: " + lead.name + " opted out of texts."); return true; }
  if (lead.assigned_to !== staff.id && staff.id !== "owner") { await textStaff(staff.phone, "Not sent: " + lead.name + " is now assigned to someone else."); return true; }

  let outText = body;
  let note = "";
  const langName = lead.preferred_language && lead.preferred_language !== "en" ? LANG_NAMES[lead.preferred_language as string] : null;
  if (langName) {
    const tr = await fetch(SUPABASE_URL + "/functions/v1/translate-message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
      body: JSON.stringify({ text: body, targetLanguage: langName }),
    }).then((r) => r.json()).catch(() => null);
    if (tr && tr.ok && tr.translated) { outText = tr.translated; note = " (translated to " + langName + ")"; }
    else note = " (sent in English, translation was unavailable)";
  }

  const send = await fetch(SUPABASE_URL + "/functions/v1/send-text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
    body: JSON.stringify({ leadId: lead.id, to: lead.phone, text: outText, fromName: staff.name }),
  }).then((r) => r.json()).catch(() => null);
  if (!send || !send.ok) { await textStaff(staff.phone, "Couldn't send your reply to " + lead.name + ". Open the CRM and send it there."); return true; }

  // same bookkeeping as a text sent from the CRM; a human taking over also stands the AI down
  const today = new Date().toISOString().slice(0, 10);
  const { data: fresh } = await sb.from("leads").select("call_attempts,activity,ai_stage,automation_paused").eq("id", lead.id).single();
  const attempts = ((fresh && fresh.call_attempts) as unknown[]) || [];
  attempts.push({ date: today, at: new Date().toISOString(), outcome: "texted", notes: body, by: staff.id });
  const upd: Record<string, unknown> = { call_attempts: attempts, last_contact_at: today };
  if (fresh && fresh.ai_stage && !fresh.automation_paused) {
    const act = ((fresh.activity as unknown[]) || []).concat([{ date: today, type: "system", text: "AI automation paused - " + staff.name + " replied by text", author: "System" }]);
    upd.automation_paused = true;
    upd.activity = act;
  }
  await sb.from("leads").update(upd).eq("id", lead.id);
  await textStaff(staff.phone, "Sent to " + lead.name + note + ": \"" + body.slice(0, 70) + (body.length > 70 ? "..." : "") + "\"");
  return true;
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
        at: new Date().toISOString(), // exact time for the Messages thread
        type: "text",
        text: "Received (via Telnyx): " + msg.text,
        author: (match.name as string) || "Borrower",
      });
      await sb.from("leads").update({ activity }).eq("id", match.id as string);

      if (!match.assigned_to) {
        // A lead's own text goes to its assigned loan officer; one with no
        // loan officer would otherwise reach nobody, so it goes to the owner.
        await forwardToOwner(sb, msg.from, (match.name as string) + " (unassigned lead " + match.id + "): " + msg.text);
      }
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
            (match.name as string) + " replied: \"" + msg.text.slice(0, 100) + "\" - reply to this text to answer them, or open: " + link;
          // remember which client this alert was about, so the LO's text reply can go to them (see routeStaffReplyToClient)
          if (lo.phone) await sb.from("staff_reply_context").insert({ staff_id: match.assigned_to, lead_id: match.id, lead_name: match.name });
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
      if (/^(start|unstop)$/i.test(msg.text.trim())) {
        await sb.from("leads").update({ sms_opt_out: false }).eq("id", match.id as string);
      }
      if (isOptOut) {
        const optOutActivity = [...activity, {
          date: new Date().toISOString().slice(0, 10), type: "system",
          text: "Client replied STOP -- automation paused (TCPA opt-out)", author: "System",
        }];
        // sms_opt_out is what the follow-up engine checks before ANY automated text, forever.
        await sb.from("leads").update({ automation_paused: true, sms_opt_out: true, activity: optOutActivity }).eq("id", match.id as string);
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
      // Joe's ask (2026-09-26): a staff reply might be answering a "choose
      // between these options" text -- see requestLenderDecision() in
      // index.html. Unlike email (routed to the exact lead via the +tag
      // reply-to), a text reply carries no lead context at all, so this
      // only auto-applies when EXACTLY ONE of this staff member's leads has
      // a pending_decision -- ambiguous (0 or 2+) falls through to the
      // normal staff-reply logging below rather than guessing which file.
      const { data: pendingLeads } = await sb.from("leads")
        .select("id, name, pending_decision")
        .eq("assigned_to", staffMatch.id)
        .not("pending_decision", "is", null);
      let decisionApplied: { leadId: string; leadName: string; label: string } | null = null;
      if (pendingLeads && pendingLeads.length === 1) {
        const plLead = pendingLeads[0] as { id: string; name: string; pending_decision: { question: string; options: Array<{ match: string[]; label: string; patch: Record<string, unknown> }> } };
        const pending = plLead.pending_decision;
        const normalized = msg.text.trim().toLowerCase();
        const matchedOption = pending && Array.isArray(pending.options)
          ? pending.options.find((o) => Array.isArray(o.match) && o.match.some((m) => normalized.includes(String(m).toLowerCase())))
          : null;
        if (matchedOption) {
          const { data: leadForActivity } = await sb.from("leads").select("activity").eq("id", plLead.id).single();
          const activity = (leadForActivity && leadForActivity.activity) || [];
          activity.push({
            date: new Date().toISOString().slice(0, 10), type: "system",
            text: (staffMatch.name as string) + " chose \"" + matchedOption.label + "\" via text reply to \"" + pending.question + "\" — terms applied automatically.",
            author: "System",
          });
          await sb.from("leads").update({ ...matchedOption.patch, pending_decision: null, activity }).eq("id", plLead.id);
          decisionApplied = { leadId: plLead.id, leadName: plLead.name, label: matchedOption.label };
        }
      }

      if (decisionApplied) {
        await sb.from("notifications").insert({
          id: "notif-" + crypto.randomUUID(), to_user_id: "owner", lead_id: decisionApplied.leadId, kind: "text",
          text: decisionApplied.leadName + ": chose \"" + decisionApplied.label + "\" — applied automatically",
          date: new Date().toISOString().slice(0, 10), read: false,
        });
        const { data: owner } = await sb.from("users").select("phone").eq("id", "owner").single();
        if (owner?.phone) {
          fetch(SUPABASE_URL + "/functions/v1/send-text", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
            body: JSON.stringify({ to: owner.phone, text: "✅ " + decisionApplied.leadName + " — " + (staffMatch.name as string) + " chose \"" + decisionApplied.label + "\" by text, applied automatically", fromName: "Bridgepoint CRM" }),
          }).catch(() => {});
        }
      } else {
        // Reply-by-text first (2026-10-12): if this is an answer to a client-text alert sent within the last 2 hours, it goes to that client.
        if (await routeStaffReplyToClient(sb, staffMatch as { id: string; name: string; phone: string }, msg.text)) {
          return new Response(JSON.stringify({ ok: true, routedToClient: true }), { headers: CORS_HEADERS });
        }
        // A text from a staff member's own phone. Otherwise it is NOT posted into any
        // borrower's portal chat anymore: staff texts now arrive on the same
        // company number as team announcements, so any reply ("sounds good",
        // "got it") could be mistaken for a message to a client -- a simulated
        // staff reply landed in a client's chat during testing on
        // 2026-09-21. Staff answer portal chats inside the CRM instead. Every
        // staff text is kept (one row each) so replies to a message Joe sends
        // the team -- e.g. phone-test feedback -- can be read back.
        const replyKey = "staff-reply-" + crypto.randomUUID().slice(0, 8);
        await sb.from("team_polls").insert({ id: replyKey, poll_key: replyKey, staff_id: staffMatch.id, vote: "reply", raw_text: msg.text });
        console.log("receive-text: logged staff reply", staffMatch.id);
        // "Send everything to my cell" -- other staff members' texts too (the
        // owner's own texts are skipped inside forwardToOwner).
        await forwardToOwner(sb, msg.from, (staffMatch.name as string) + ": " + msg.text);
      }
    } else {
      console.log("receive-text: no lead or staff matched sender", msg.from);
      // Not a lead and not staff (verification codes, banks, wrong numbers...).
      await forwardToOwner(sb, msg.from, msg.text);
    }

    return new Response(JSON.stringify({ ok: true, matched: !!match }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
