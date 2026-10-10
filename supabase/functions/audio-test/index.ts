// Two-way audio test (Joe 2026-10-10, after Ida couldn't hear him): rings a staff cell from the
// company number through the same Telnyx connection the dialer uses. It speaks (proves we -> them),
// records 10 seconds after a beep (proves them -> us), plays the recording back, and saves a
// transcript so we can read exactly what came through. Events come to this function directly
// (webhook_url on the dial), so nothing touches voice-webhook or any lead file.
// Start: POST { secret, userId }. Results: table audio_test_log.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
const TELNYX_CONNECTION_ID = Deno.env.get("TELNYX_CONNECTION_ID")!;
const TELNYX_FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const VOICE = "Azure.en-US-AvaMultilingualNeural";
const SELF = SUPABASE_URL + "/functions/v1/audio-test";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const enc = (o: unknown) => btoa(JSON.stringify(o));
const dec = (s: unknown) => { try { return JSON.parse(atob(String(s || ""))); } catch (_) { return null; } };

async function act(id: string, action: string, body: Record<string, unknown>) {
  const r = await fetch("https://api.telnyx.com/v2/calls/" + id + "/actions/" + action, {
    method: "POST", headers: { Authorization: "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  return r;
}
async function log(test: string, step: string, detail: unknown) {
  await sb.from("audio_test_log").insert({ test_id: test, step, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000) });
}

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ ok: true }); }

  // Telnyx webhook events for our test call.
  if (body && body.data && body.data.event_type) {
    const ev = body.data.event_type, p = body.data.payload || {};
    const st = dec(p.client_state);
    if (!st || st.t !== "audiotest") return json({ ok: true });
    const id = p.call_control_id;
    if (ev === "call.answered") {
      await log(st.id, "answered", "Phone picked up");
      await act(id, "speak", { payload: "Hi, this is the Bridgepoint audio test. If you can hear me, our audio to your phone is working. After the beep, please say a sentence, like your name and today's date. You have ten seconds.", voice: VOICE, language: "en-US", client_state: enc({ ...st, s: "record" }) });
    } else if (ev === "call.speak.ended" && st.s === "record") {
      await act(id, "record_start", { format: "mp3", channels: "single", play_beep: true, max_length: 10, timeout_secs: 4, transcription: true, client_state: enc({ ...st, s: "recording" }) });
    } else if (ev === "call.recording.saved") {
      const url = p.recording_urls && p.recording_urls.mp3;
      await log(st.id, "recorded", { seconds: p.recording_ended_at && p.recording_started_at ? (Date.parse(p.recording_ended_at) - Date.parse(p.recording_started_at)) / 1000 : null, url: url ? "saved" : "none" });
      if (url) await act(id, "speak", { payload: "Thanks. Here is what our system heard from you.", voice: VOICE, language: "en-US", client_state: enc({ ...st, s: "playback", url }) });
      else await act(id, "speak", { payload: "I didn't get a recording. The test is over. Goodbye.", voice: VOICE, language: "en-US", client_state: enc({ ...st, s: "bye" }) });
    } else if (ev === "call.speak.ended" && st.s === "playback") {
      await act(id, "playback_start", { audio_url: st.url, client_state: enc({ ...st, s: "after" }) });
    } else if (ev === "call.playback.ended" && st.s === "after") {
      await act(id, "speak", { payload: "That's the end of the test. If you heard your own voice just now, audio works both ways. Goodbye.", voice: VOICE, language: "en-US", client_state: enc({ ...st, s: "bye" }) });
    } else if (ev === "call.speak.ended" && st.s === "bye") {
      await act(id, "hangup", {});
    } else if (ev === "call.recording.transcription.saved" || ev === "call.transcription") {
      const t = (p.transcription_text) || (p.transcription_data && p.transcription_data.transcript) || "";
      await log(st.id, "transcript", t || "(empty transcript)");
    } else if (ev === "call.hangup") {
      await log(st.id, "hangup", { cause: p.hangup_cause, quality: p.call_quality_stats || null });
    }
    return json({ ok: true });
  }

  // Start a test.
  const { data: auth } = await sb.from("ad_followup_auth").select("secret").eq("id", 1).single();
  if (!auth || body.secret !== auth.secret) return json({ error: "not_authorized" }, 403);
  const { data: u } = await sb.from("users").select("id,name,phone").eq("id", String(body.userId || "owner")).maybeSingle();
  if (!u || !u.phone) return json({ error: "no_phone" }, 400);
  const digits = String(u.phone).replace(/\D/g, "");
  const to = digits.length === 10 ? "+1" + digits : "+" + digits;
  const testId = "AT" + Date.now();
  const r = await fetch("https://api.telnyx.com/v2/calls", {
    method: "POST", headers: { Authorization: "Bearer " + TELNYX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ connection_id: TELNYX_CONNECTION_ID, to, from: TELNYX_FROM_NUMBER, timeout_secs: 30, webhook_url: SELF, webhook_url_method: "POST", client_state: enc({ t: "audiotest", id: testId }) }),
  }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  await log(testId, "dialed", { to: u.name, ok: !!(r && r.data && r.data.call_control_id), err: r && r.errors ? r.errors : undefined });
  return json({ ok: !!(r && r.data), testId, result: r && r.errors ? r.errors : "ringing" });
});
