// Telnyx Call Control webhook for the power dialer, inbound routing, the
// caller-facing IVR for unrecognized callers, and voicemail. Bridge-call
// pattern throughout, no WebRTC softphone needed.
//
// INBOUND, caller matches an existing lead (silent, instant -- Joe's ask,
// 2026-09-16, kept exactly as before): answer, transfer straight to the
// assigned staff member's personal cell. NEW this revision: if that
// transfer times out unanswered, the caller now falls to a personalized
// voicemail for that staff member instead of the call just dying, and the
// recording gets logged to the lead's own activity/call_attempts.
//
// INBOUND, caller does NOT match any lead -- Joe's explicit IVR design
// (2026-09-16), transcribed verbatim from his own description:
//   "For English press 1, for Spanish press 2 (automatically sent to
//   Fanis). If they press 1 it then asks 'new loans press 1' -- if they
//   press 1 it's sent out to all loan officers first to answer talks to
//   the client. Then 'for a company directory press 2' -- lists all loan
//   officers, forwarded to their personal lines. 'For processing press 3'
//   -- calls Erika."
// Recognized clients never hear this menu (Joe's explicit choice) -- it
// exists purely so a new/unknown caller can reach the right person.
// Any leg of this tree that goes unanswered falls to voicemail, and
// whoever should have picked up gets notified (text + email) with the
// recording link, transcript when Telnyx returns one, plus an in-app
// notification.
//
// OUTBOUND (staff clicks Call / quick-dial): ring the staff member's own
// cell first; once THEY pick up, transfer that leg to the destination so
// they land in a normal two-party call. Unchanged from before.
//
// Every command that can fail to connect uses Telnyx's timeout_secs so
// control returns to us instead of the call just dying -- see
// startVoicemail() for what happens next. IMPORTANT: DTMF-menu and
// transfer-timeout behavior is built strictly to Telnyx's documented Call
// Control API, but has NOT been exercised against a real inbound call as
// of this deploy -- place a real test call through each branch (English
// new-loans, directory, processing, Spanish, and an unanswered leg to
// confirm voicemail) and watch this function's logs before relying on it
// for real client calls. Every event's raw payload is logged for exactly
// that reason.
//
// client_state is base64 JSON, carried across commands so the next
// webhook event knows what stage the call is in. call_session_id stays
// constant across a transfer (Telnyx docs: it correlates all legs of one
// call flow), so it's what call outcomes get logged against.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const JSON_HEADERS = { "Content-Type": "application/json" };
const TRANSFER_TIMEOUT_SECS = 25;
const RING_ALL_TIMEOUT_SECS = 25;
const SPANISH_LO_ID = "lo-fanis"; // Joe's explicit choice for the Spanish IVR branch
const PROCESSING_STAFF_ID = "proc-erika";

type Stage =
  | "ringing_staff" | "connecting_lead"                       // outbound dialer (sequential mode)
  | "direct_dial_leg"                                         // outbound quick-dial (direct/parallel mode)
  | "answering_inbound" | "connecting_staff"                  // inbound, matched lead
  | "ivr_lang_menu" | "ivr_main_menu" | "ivr_directory_menu"   // inbound, unmatched caller
  | "ivr_single_connect" | "ivr_ring_all_leg"
  | "voicemail_recording";

interface CallState {
  v: 1;
  stage: Stage;
  leadId?: string | null;
  userId?: string | null;           // outbound dialer: the staff member who clicked Call
  staffId?: string | null;          // inbound: the specific staff member being routed to
  leadPhone?: string;
  leadName?: string | null;
  staffName?: string | null;
  staffPhone?: string;
  callerNumber?: string;
  directoryIds?: string[];          // ivr_directory_menu: ordered LO ids matching digits 1..N
  ringGroupId?: string;             // ivr_ring_all_leg: which ring group this leg belongs to
  originalCallControlId?: string;   // ivr_ring_all_leg / voicemail: the caller's own leg
  vmTarget?: { kind: "staff" | "all_los" | "owner"; staffId?: string | null; label: string };
  pairId?: string;                  // direct_dial_leg: which pair this leg belongs to
  role?: "destination" | "staff";   // direct_dial_leg: which side of the pair this leg is
}

function last10(phone: string | null | undefined): string {
  return (phone || "").replace(/\D/g, "").slice(-10);
}
function toE164(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 10 ? "+1" + digits : "+" + digits;
}
function decodeState(payload: Record<string, unknown>): CallState | null {
  try {
    return JSON.parse(atob((payload.client_state as string) || ""));
  } catch {
    return null;
  }
}
function encodeState(obj: CallState): string {
  return btoa(JSON.stringify(obj));
}

async function telnyxAction(callControlId: string, action: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`, {
    method: "POST",
    headers: { "Authorization": "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) console.error(`voice-webhook: ${action} failed`, callControlId, JSON.stringify(data));
  return { ok: res.ok, data };
}

async function telnyxCreateCall(body: Record<string, unknown>) {
  const res = await fetch("https://api.telnyx.com/v2/calls", {
    method: "POST",
    headers: { "Authorization": "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) console.error("voice-webhook: call create failed", JSON.stringify(data));
  return { ok: res.ok, data };
}

function speak(callControlId: string, text: string, lang: "en" | "es") {
  return telnyxAction(callControlId, "speak", {
    payload: text,
    voice: "female",
    language: lang === "es" ? "es-MX" : "en-US",
  });
}

function gather(callControlId: string, text: string, validDigits: string, state: CallState, lang: "en" | "es" = "en") {
  return telnyxAction(callControlId, "gather_using_speak", {
    payload: text,
    voice: "female",
    language: lang === "es" ? "es-MX" : "en-US",
    valid_digits: validDigits,
    minimum_digits: 1,
    maximum_digits: 1,
    timeout_millis: 15000,
    client_state: encodeState(state),
  });
}

// Terminal step for any unanswered branch of the tree -- plays a greeting
// on the CALLER's own leg (still ours to control since every dial-out
// used timeout_secs rather than letting Telnyx just kill the call) and
// starts recording. call.recording.saved (below) does the notifying.
async function startVoicemail(callControlId: string, greeting: string, lang: "en" | "es", vmTarget: CallState["vmTarget"], leadId: string | null | undefined, callerNumber: string | undefined) {
  await speak(callControlId, greeting, lang);
  const state: CallState = {
    v: 1, stage: "voicemail_recording", leadId: leadId || null, callerNumber, vmTarget,
  };
  await telnyxAction(callControlId, "record_start", {
    format: "mp3", channels: "single", play_beep: true, timeout_secs: 120,
    transcription: true,
    client_state: encodeState(state),
  });
}

async function notifyVoicemail(opts: { vmTarget: CallState["vmTarget"]; leadId?: string | null; callerNumber?: string; recordingUrl: string | null; transcript?: string | null }) {
  const { vmTarget, leadId, callerNumber } = opts;
  if (!vmTarget) return;

  let staffIds: string[] = [];
  if (vmTarget.kind === "staff" && vmTarget.staffId) staffIds = [vmTarget.staffId];
  else if (vmTarget.kind === "owner") staffIds = ["owner"];
  else if (vmTarget.kind === "all_los") {
    const { data: los } = await sb.from("users").select("id").eq("role", "loan_officer");
    staffIds = (los || []).map((u) => u.id as string).concat(["owner"]);
  }

  const summary = "New voicemail (" + vmTarget.label + ") from " + (callerNumber || "unknown number") +
    (opts.transcript ? (": \"" + opts.transcript.slice(0, 160) + "\"") : "") +
    (opts.recordingUrl ? (" — " + opts.recordingUrl) : "");

  for (const staffId of staffIds) {
    const { data: staff } = await sb.from("users").select("phone,email").eq("id", staffId).single();
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8),
      to_user_id: staffId, lead_id: leadId || null, kind: "voicemail",
      text: summary, date: new Date().toISOString().slice(0, 10), read: false,
    });
    if (staff?.phone) {
      fetch(SUPABASE_URL + "/functions/v1/send-text", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: staff.phone, text: "📞 " + summary, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
    if (staff?.email) {
      fetch(SUPABASE_URL + "/functions/v1/send-email", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
        body: JSON.stringify({ to: staff.email, subject: "New voicemail — " + vmTarget.label, text: summary, fromName: "Bridgepoint CRM" }),
      }).catch(() => {});
    }
  }

  if (leadId) {
    const { data: lead } = await sb.from("leads").select("call_attempts, activity").eq("id", leadId).single();
    if (lead) {
      const attempts = (Array.isArray(lead.call_attempts) ? lead.call_attempts : []) as Array<Record<string, unknown>>;
      const activity = (Array.isArray(lead.activity) ? lead.activity : []) as Array<Record<string, unknown>>;
      const d = new Date().toISOString().slice(0, 10);
      attempts.push({ date: d, outcome: "voicemail", notes: opts.transcript || "Left a voicemail" });
      activity.push({ date: d, type: "call", text: "Inbound call went to voicemail" + (opts.transcript ? (": \"" + opts.transcript + "\"") : "") + (opts.recordingUrl ? (" (" + opts.recordingUrl + ")") : ""), author: "System" });
      await sb.from("leads").update({ call_attempts: attempts, activity, last_contact_at: d }).eq("id", leadId);
    }
  }
}

async function logCallOutcome(opts: { leadId: string; staffId?: string | null; sessionId: string; outcome: string; note: string }) {
  const { data: lead } = await sb.from("leads").select("call_attempts, activity").eq("id", opts.leadId).single();
  if (!lead) return;
  const attempts = (Array.isArray(lead.call_attempts) ? lead.call_attempts : []) as Array<Record<string, unknown>>;
  const activity = (Array.isArray(lead.activity) ? lead.activity : []) as Array<Record<string, unknown>>;
  const d = new Date().toISOString().slice(0, 10);

  let staffName = "System";
  if (opts.staffId) {
    const { data: staff } = await sb.from("users").select("name").eq("id", opts.staffId).single();
    if (staff?.name) staffName = staff.name as string;
  }

  const entry = { date: d, outcome: opts.outcome, notes: opts.note, telnyxSessionId: opts.sessionId };
  const existingIdx = attempts.findIndex((a) => a.telnyxSessionId === opts.sessionId);
  if (existingIdx !== -1) attempts[existingIdx] = entry;
  else attempts.push(entry);

  activity.push({ date: d, type: "call", text: opts.note, author: staffName });
  await sb.from("leads").update({ call_attempts: attempts, activity, last_contact_at: d }).eq("id", opts.leadId);
}

// Rings every loan officer's personal cell at once; whichever answers
// first gets bridged to the caller, the rest get hung up. voice_ring_groups
// is the only way to coordinate that across separate, stateless webhook
// invocations for each leg.
async function startRingAllLoanOfficers(originalCallControlId: string) {
  const { data: los } = await sb.from("users").select("id, name, phone").eq("role", "loan_officer");
  const withPhones = (los || []).filter((u) => u.phone);
  if (!withPhones.length) {
    await startVoicemail(originalCallControlId,
      "All of our loan officers are currently unavailable. Please leave your name, number, and a brief description of your project after the tone, and we'll call you back as soon as possible.",
      "en", { kind: "all_los", label: "New loan inquiry" }, null, undefined);
    return;
  }

  const ringGroupId = "RG" + crypto.randomUUID().slice(0, 12);
  const legIds: string[] = [];
  for (const lo of withPhones) {
    const legState: CallState = {
      v: 1, stage: "ivr_ring_all_leg", ringGroupId, originalCallControlId,
      staffId: lo.id as string, staffName: lo.name as string,
    };
    const res = await telnyxCreateCall({
      connection_id: Deno.env.get("TELNYX_CONNECTION_ID"),
      to: toE164(lo.phone as string),
      from: TELNYX_FROM_NUMBER,
      timeout_secs: RING_ALL_TIMEOUT_SECS,
      client_state: encodeState(legState),
    });
    const legId = res?.data?.data?.call_control_id;
    if (legId) legIds.push(legId);
  }

  if (!legIds.length) {
    await startVoicemail(originalCallControlId,
      "All of our loan officers are currently unavailable. Please leave your name, number, and a brief description of your project after the tone, and we'll call you back as soon as possible.",
      "en", { kind: "all_los", label: "New loan inquiry" }, null, undefined);
    return;
  }

  await sb.from("voice_ring_groups").insert({
    id: ringGroupId, original_call_control_id: originalCallControlId,
    leg_call_control_ids: legIds, legs_total: legIds.length, legs_ended: 0,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const event = (body?.data as Record<string, unknown>) || {};
  const eventType = event.event_type as string;
  const payload = (event.payload as Record<string, unknown>) || {};
  console.log("voice-webhook:", eventType, JSON.stringify(payload));

  try {
    if (eventType === "call.initiated") {
      if (payload.direction === "incoming") {
        const callerDigits = last10(payload.from as string);
        const { data: leads } = await sb.from("leads").select("id, name, phone, assigned_to");
        const match = (leads || []).find((l) => last10(l.phone as string) === callerDigits);
        const callControlId = payload.call_control_id as string;

        if (match) {
          // Recognized client -- silent, instant routing, exactly as before.
          let staffId = (match.assigned_to as string) || "owner";
          const { data: staff } = await sb.from("users").select("id, name, phone").eq("id", staffId).single();
          let routeStaff = staff;
          if (!routeStaff?.phone) {
            const { data: owner } = await sb.from("users").select("id, name, phone").eq("id", "owner").single();
            routeStaff = owner;
            staffId = "owner";
          }
          if (!routeStaff?.phone) {
            console.error("voice-webhook: no staff phone on file to route inbound call to");
            return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
          }
          const state: CallState = {
            v: 1, stage: "answering_inbound", leadId: match.id as string, staffId,
            staffName: routeStaff.name as string, staffPhone: toE164(routeStaff.phone as string),
            callerNumber: payload.from as string,
          };
          await telnyxAction(callControlId, "answer", { client_state: encodeState(state) });
        } else {
          // Unrecognized caller -- Joe's IVR tree. Answer, then the language gate.
          await sb.from("notifications").insert({
            id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: null, kind: "call",
            text: "Inbound call from " + (payload.from as string) + " — no matching lead, sent into the IVR",
            date: new Date().toISOString().slice(0, 10), read: false,
          });
          const state: CallState = { v: 1, stage: "ivr_lang_menu", callerNumber: payload.from as string };
          await telnyxAction(callControlId, "answer", { client_state: encodeState(state) });
        }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.answered") {
      const state = decodeState(payload);
      const callControlId = payload.call_control_id as string;
      if (!state) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

      if (state.stage === "ringing_staff") {
        const nextState: CallState = { ...state, stage: "connecting_lead" };
        await telnyxAction(callControlId, "transfer", {
          to: state.leadPhone, from: TELNYX_FROM_NUMBER, client_state: encodeState(nextState),
        });
      } else if (state.stage === "answering_inbound") {
        const nextState: CallState = { ...state, stage: "connecting_staff" };
        await telnyxAction(callControlId, "transfer", {
          to: state.staffPhone, from: TELNYX_FROM_NUMBER, timeout_secs: TRANSFER_TIMEOUT_SECS, client_state: encodeState(nextState),
        });
      } else if (state.stage === "ivr_single_connect") {
        // Already mid-transfer -- nothing to do, the eventual hangup/timeout handles the outcome.
      } else if (state.stage === "ivr_ring_all_leg" && state.ringGroupId) {
        // First leg to answer wins the race -- atomic claim via the DB row.
        const { data: claimed } = await sb.from("voice_ring_groups")
          .update({ winner_call_control_id: callControlId })
          .eq("id", state.ringGroupId).is("winner_call_control_id", null).select().single();
        if (claimed) {
          await telnyxAction(state.originalCallControlId!, "bridge", { call_control_id: callControlId });
          const others = ((claimed.leg_call_control_ids as string[]) || []).filter((id) => id !== callControlId);
          for (const otherId of others) {
            await telnyxAction(otherId, "hangup", {});
          }
        } else {
          // Someone else already won -- hang up, this leg loses the race.
          await telnyxAction(callControlId, "hangup", {});
        }
      } else if (state.stage === "voicemail_recording") {
        // n/a -- record_start doesn't produce a call.answered event on this leg.
      } else if (state.stage === "direct_dial_leg" && state.pairId) {
        // Mark this side answered; bridge only once BOTH sides have picked up
        // (bridging a leg that hasn't answered yet has no media to connect).
        const field = state.role === "staff" ? "staff_answered" : "destination_answered";
        const { data: pairRow } = await sb.from("voice_direct_dial_pairs").update({ [field]: true }).eq("id", state.pairId).select().single();
        if (pairRow && pairRow.staff_answered && pairRow.destination_answered && !pairRow.bridged) {
          const claim = await sb.from("voice_direct_dial_pairs").update({ bridged: true }).eq("id", state.pairId).eq("bridged", false).select().single();
          if (claim.data) {
            await telnyxAction(pairRow.staff_call_control_id as string, "bridge", { call_control_id: pairRow.destination_call_control_id as string });
          }
        } else if (pairRow && !pairRow.bridged) {
          // Other side hasn't answered yet -- let them know we're connecting rather than leaving dead air.
          await speak(callControlId, "Please hold while we connect your call.", "en");
        }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.gather.ended") {
      const state = decodeState(payload);
      const callControlId = payload.call_control_id as string;
      const digits = (payload.digits as string) || "";
      if (!state) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

      if (state.stage === "ivr_lang_menu") {
        if (digits === "2") {
          const { data: fanis } = await sb.from("users").select("id, name, phone").eq("id", SPANISH_LO_ID).single();
          if (fanis?.phone) {
            await speak(callControlId, "Un momento, por favor, le comunicamos con un oficial de préstamos.", "es");
            const nextState: CallState = {
              v: 1, stage: "ivr_single_connect", staffId: fanis.id as string, staffName: fanis.name as string,
              staffPhone: toE164(fanis.phone as string), callerNumber: state.callerNumber,
              vmTarget: { kind: "staff", staffId: fanis.id as string, label: fanis.name as string },
            };
            await telnyxAction(callControlId, "transfer", {
              to: nextState.staffPhone, from: TELNYX_FROM_NUMBER, timeout_secs: TRANSFER_TIMEOUT_SECS, client_state: encodeState(nextState),
            });
          } else {
            await startVoicemail(callControlId, "En este momento no podemos atender su llamada. Por favor deje su nombre, número de teléfono y un mensaje breve después del tono.", "es", { kind: "staff", staffId: SPANISH_LO_ID, label: "Spanish caller" }, null, state.callerNumber);
          }
        } else if (digits === "1") {
          const nextState: CallState = { v: 1, stage: "ivr_main_menu", callerNumber: state.callerNumber };
          await gather(callControlId,
            "For new loan inquiries, press 1. For our company directory, press 2. For processing, press 3.",
            "123", nextState);
        } else {
          await startVoicemail(callControlId, "Please leave your name, number, and a brief message after the tone.", "en", { kind: "owner", label: "Unrecognized IVR input" }, null, state.callerNumber);
        }
      } else if (state.stage === "ivr_main_menu") {
        if (digits === "1") {
          await speak(callControlId, "Please hold while we connect you to one of our loan officers.", "en");
          await startRingAllLoanOfficers(callControlId);
        } else if (digits === "2") {
          const { data: los } = await sb.from("users").select("id, name").eq("role", "loan_officer").order("name");
          const list = los || [];
          if (!list.length) {
            await startVoicemail(callControlId, "Please leave your name, number, and a brief message after the tone.", "en", { kind: "owner", label: "Company directory (empty)" }, null, state.callerNumber);
          } else {
            const prompt = list.map((lo, i) => "Press " + (i + 1) + " for " + (lo.name as string) + ".").join(" ");
            const nextState: CallState = {
              v: 1, stage: "ivr_directory_menu", callerNumber: state.callerNumber,
              directoryIds: list.map((lo) => lo.id as string),
            };
            await gather(callControlId, "Company directory. " + prompt, list.map((_, i) => String(i + 1)).join(""), nextState);
          }
        } else if (digits === "3") {
          const { data: erika } = await sb.from("users").select("id, name, phone").eq("id", PROCESSING_STAFF_ID).single();
          if (erika?.phone) {
            const nextState: CallState = {
              v: 1, stage: "ivr_single_connect", staffId: erika.id as string, staffName: erika.name as string,
              staffPhone: toE164(erika.phone as string), callerNumber: state.callerNumber,
              vmTarget: { kind: "staff", staffId: erika.id as string, label: "Processing" },
            };
            await speak(callControlId, "Please hold while we connect you to processing.", "en");
            await telnyxAction(callControlId, "transfer", {
              to: nextState.staffPhone, from: TELNYX_FROM_NUMBER, timeout_secs: TRANSFER_TIMEOUT_SECS, client_state: encodeState(nextState),
            });
          } else {
            await startVoicemail(callControlId, "You've reached the processing department at Bridgepoint Lending. Please leave your name, loan number if you have it, and a brief message after the tone.", "en", { kind: "staff", staffId: PROCESSING_STAFF_ID, label: "Processing" }, null, state.callerNumber);
          }
        } else {
          await startVoicemail(callControlId, "Please leave your name, number, and a brief message after the tone.", "en", { kind: "owner", label: "Unrecognized IVR input" }, null, state.callerNumber);
        }
      } else if (state.stage === "ivr_directory_menu") {
        const idx = parseInt(digits, 10) - 1;
        const targetId = (state.directoryIds || [])[idx];
        if (targetId) {
          const { data: lo } = await sb.from("users").select("id, name, phone").eq("id", targetId).single();
          if (lo?.phone) {
            const nextState: CallState = {
              v: 1, stage: "ivr_single_connect", staffId: lo.id as string, staffName: lo.name as string,
              staffPhone: toE164(lo.phone as string), callerNumber: state.callerNumber,
              vmTarget: { kind: "staff", staffId: lo.id as string, label: lo.name as string },
            };
            await telnyxAction(callControlId, "transfer", {
              to: nextState.staffPhone, from: TELNYX_FROM_NUMBER, timeout_secs: TRANSFER_TIMEOUT_SECS, client_state: encodeState(nextState),
            });
            return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
          }
        }
        await startVoicemail(callControlId, "Please leave your name, number, and a brief message after the tone.", "en", { kind: "owner", label: "Company directory (invalid selection)" }, null, state.callerNumber);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.recording.saved") {
      const state = decodeState(payload);
      const recordingUrl = (payload.recording_urls as Record<string, string> | undefined)?.mp3 || null;
      if (state && state.stage === "voicemail_recording") {
        await notifyVoicemail({ vmTarget: state.vmTarget, leadId: state.leadId, callerNumber: state.callerNumber, recordingUrl });
      } else {
        console.log("voice-webhook: recording.saved with no voicemail state, logging only", recordingUrl);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.transcription") {
      // Best-effort follow-up if Telnyx returns a transcript after the
      // recording notification already went out -- posted as its own
      // note rather than trying to merge into the earlier notification.
      const state = decodeState(payload);
      const transcript = (payload.transcription_data as Record<string, unknown> | undefined)?.transcript as string | undefined;
      if (state && transcript && state.leadId) {
        const { data: lead } = await sb.from("leads").select("activity").eq("id", state.leadId).single();
        if (lead) {
          const activity = (Array.isArray(lead.activity) ? lead.activity : []) as Array<Record<string, unknown>>;
          activity.push({ date: new Date().toISOString().slice(0, 10), type: "call", text: "Voicemail transcript: \"" + transcript + "\"", author: "System" });
          await sb.from("leads").update({ activity }).eq("id", state.leadId);
        }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (eventType === "call.hangup") {
      const state = decodeState(payload);
      const callControlId = payload.call_control_id as string;
      if (!state) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

      const cause = ((payload.hangup_cause as string) || "").toLowerCase();
      const neverConnected = ["no_answer", "timeout", "call_rejected", "originator_cancel", "unspecified", "user_busy"].includes(cause);
      const sessionId = (payload.call_session_id as string) || callControlId;

      if (state.stage === "ringing_staff") {
        if (state.leadId) {
          await logCallOutcome({
            leadId: state.leadId, staffId: state.userId, sessionId, outcome: "no-answer",
            note: "Dialer call to " + (state.staffName || "staff") + " went unanswered before reaching " + (state.leadName || "the lead"),
          });
        }
      } else if (state.stage === "connecting_lead") {
        if (state.leadId) {
          await logCallOutcome({
            leadId: state.leadId, staffId: state.userId, sessionId,
            outcome: neverConnected ? "no-answer" : "connected",
            note: neverConnected
              ? "Outbound call — " + (state.leadName || "lead") + " did not pick up"
              : "Outbound call connected with " + (state.leadName || "lead"),
          });
        }
      } else if (state.stage === "answering_inbound") {
        if (state.leadId) {
          await logCallOutcome({
            leadId: state.leadId, staffId: state.staffId, sessionId, outcome: "no-answer",
            note: "Inbound call from " + (state.callerNumber || "caller") + " dropped before connecting to staff",
          });
        }
      } else if (state.stage === "connecting_staff") {
        if (neverConnected) {
          // The assigned staff member didn't pick up -- fall to a
          // personalized voicemail instead of just dropping the call.
          await startVoicemail(callControlId,
            "You've reached " + (state.staffName || "your loan officer") + " at Bridgepoint Lending. Please leave your name, number, and a brief message after the tone.",
            "en", { kind: "staff", staffId: state.staffId || null, label: state.staffName || "Loan officer" }, state.leadId, state.callerNumber);
        } else if (state.leadId) {
          await logCallOutcome({
            leadId: state.leadId, staffId: state.staffId, sessionId, outcome: "connected",
            note: "Inbound call connected with staff",
          });
        }
      } else if (state.stage === "ivr_single_connect") {
        if (neverConnected) {
          await startVoicemail(callControlId,
            "You've reached " + (state.staffName || "Bridgepoint Lending") + ". Please leave your name, number, and a brief message after the tone.",
            "en", state.vmTarget, null, state.callerNumber);
        }
        // If it DID connect, there's no lead to log the outcome against (unmatched caller) -- nothing further to do.
      } else if (state.stage === "ivr_ring_all_leg" && state.ringGroupId) {
        // One leg of the ring group ended (answered-and-lost, timed out, or busy).
        // If this was the LAST leg to end and nobody ever won, send the caller to voicemail.
        // Read-increment-write, not atomic -- fine here since legs_ended only
        // needs to reach legs_total once, and a rare double-fire just re-checks
        // a condition that's already true (startVoicemail on an already-recording
        // leg just fails harmlessly, logged by telnyxAction).
        const { data: row } = await sb.from("voice_ring_groups").select("*").eq("id", state.ringGroupId).single();
        let group = row;
        if (row) {
          const newEnded = (row.legs_ended as number) + 1;
          const { data: updated } = await sb.from("voice_ring_groups").update({ legs_ended: newEnded }).eq("id", state.ringGroupId).select().single();
          group = updated || row;
        }
        if (group && !group.winner_call_control_id && (group.legs_ended as number) >= (group.legs_total as number)) {
          await startVoicemail(group.original_call_control_id as string,
            "All of our loan officers are currently unavailable. Please leave your name, number, and a brief description of your project after the tone, and we'll call you back as soon as possible.",
            "en", { kind: "all_los", label: "New loan inquiry" }, null, undefined);
        }
      } else if (state.stage === "direct_dial_leg" && state.pairId) {
        const { data: pairRow } = await sb.from("voice_direct_dial_pairs").select("*").eq("id", state.pairId).single();
        if (pairRow) {
          // Whichever leg is still up when the other ends should be hung up too --
          // no point leaving one side ringing alone or connected to a dead line.
          const otherLegId = state.role === "staff" ? pairRow.destination_call_control_id : pairRow.staff_call_control_id;
          if (otherLegId && otherLegId !== callControlId) {
            await telnyxAction(otherLegId as string, "hangup", {});
          }
          if (state.leadId) {
            // Computed from the pair's own answered flags, not this leg's
            // hangup_cause -- both legs fire this handler independently
            // (one hangs up naturally, the other via the hangup call just
            // above), and pairId is used as the dedup key in
            // logCallOutcome, so this must produce the SAME outcome/note
            // regardless of which leg's event runs first.
            const outcome = pairRow.bridged ? "connected" : "no-answer";
            const note = pairRow.bridged
              ? "Direct-dial call connected with " + (state.leadName || "lead")
              : !pairRow.staff_answered
                ? "Direct-dial call to " + (state.leadName || "lead") + " — staff didn't pick up in time"
                : "Direct-dial call to " + (state.leadName || "lead") + " — they did not pick up";
            await logCallOutcome({ leadId: state.leadId, sessionId: state.pairId, outcome, note });
          }
        }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err) {
    console.error("voice-webhook: error", String(err));
    return new Response(JSON.stringify({ ok: true, error: String(err) }), { headers: JSON_HEADERS });
  }
});
