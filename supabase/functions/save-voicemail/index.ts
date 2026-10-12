// Voicemail recorder backend (Joe 2026-10-12). Each loan officer gets a personal link (/vm/?u=<id>&t=<token>),
// reads a short script on their phone, and the recording is saved as their drop-in voicemail.
// The CRM's call screen plays it into a live call with one click ("Drop voicemail").
// Token = sha256(userId + ":vm:" + service key), so a link only works for the person it was made for.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const COMPANY_PHONE_SPOKEN = "eight five zero, two seven nine, eight five eight eight";

async function tokenFor(uid: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uid + ":vm:" + SERVICE_KEY));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
async function whoFor(uid: string, t: string) {
  if (!uid || !t || t !== (await tokenFor(uid))) return null;
  const { data } = await sb.from("users").select("id,name,role").eq("id", uid).maybeSingle();
  return data && data.role !== "processor" ? data : null;
}
const kindOf = (k: unknown) => (k === "greeting" ? "greeting" : "drop");
const fileFor = (id: string, kind: string) => "voicemails/" + id + (kind === "greeting" ? "-greeting" : "") + ".wav";
function greetingFor(fullName: string): string {
  return "Hi, you've reached " + fullName + " with Bridgepoint Lending. I'm not able to take your call right now. Please leave your name, your number, and a short message after the tone, and I'll call you back as soon as I can. Thank you.";
}
function scriptFor(fullName: string): string {
  return "Hi, this is " + fullName + " with Bridgepoint Lending. I'm following up on the loan inquiry you sent us, and I'd love to hear about the property you're working on. " +
    "You can call or text me back any time at " + COMPANY_PHONE_SPOKEN + ". " +
    "Again, that's " + fullName + " with Bridgepoint Lending, " + COMPANY_PHONE_SPOKEN + ". Talk to you soon.";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      const who = await whoFor(url.searchParams.get("u") || "", url.searchParams.get("t") || "");
      if (!who) return json({ error: "This link isn't valid. Ask Joe for a new one." }, 403);
      const kind = kindOf(url.searchParams.get("kind"));
      const { data: files } = await sb.storage.from("public-assets").list("voicemails", { search: fileFor(who.id, kind).replace("voicemails/", "") });
      const exact = (files || []).some((f: { name: string }) => f.name === fileFor(who.id, kind).replace("voicemails/", ""));
      return json({ ok: true, name: who.name, kind, script: kind === "greeting" ? greetingFor(who.name) : scriptFor(who.name), hasRecording: exact });
    }
    if (req.method === "POST") {
      const body = await req.json();
      const who = await whoFor(String(body.u || ""), String(body.t || ""));
      if (!who) return json({ error: "This link isn't valid. Ask Joe for a new one." }, 403);
      const b64 = String(body.wav || "");
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (raw.length < 4000 || raw.length > 3_000_000) return json({ error: "That recording is too short or too long (aim for 20-40 seconds)." }, 400);
      const head = new TextDecoder().decode(raw.slice(0, 4)), wave = new TextDecoder().decode(raw.slice(8, 12));
      if (head !== "RIFF" || wave !== "WAVE") return json({ error: "Unexpected audio format." }, 400);
      const { error } = await sb.storage.from("public-assets").upload(fileFor(who.id, kindOf(body.kind)), raw, { contentType: "audio/wav", upsert: true, cacheControl: "0" });
      if (error) return json({ error: "Couldn't save the recording: " + error.message }, 500);
      return json({ ok: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    return json({ error: "server_error", detail: String(e) }, 500);
  }
});
