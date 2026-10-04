// Referral-partner sign-up from bplending.com/partners/ (agents, wholesalers, contractors, CPAs, attorneys,
// other lenders/brokers). Creates a lead-style contact assigned to Joe with source "Website - Referral Partner",
// alerts Joe, and sends NO automated message to the partner (no AI touches, nurture off) -- partners get a human.
// Public on purpose: honeypot, strict caps, per-phone/email de-duplication.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const KINDS = ["Real estate agent", "Wholesaler", "Contractor / builder", "CPA / attorney", "Loan officer / broker", "Other"];

const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max) : "");
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const b = await req.json();
    if (clean(b.website)) return json({ ok: true }); // honeypot
    const name = clean(b.name, 80), company = clean(b.company, 100), email = clean(b.email, 120).toLowerCase();
    const phoneDigits = clean(b.phone, 30).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    const kind = KINDS.indexOf(clean(b.kind, 40)) !== -1 ? clean(b.kind, 40) : "Other";
    const notes = clean(b.notes, 600);
    if (name.length < 2) return json({ error: "invalid", detail: "Please enter your name." }, 400);
    if (phoneDigits.length !== 10) return json({ error: "invalid", detail: "Please enter a 10-digit phone number." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "invalid", detail: "Please enter a valid email." }, 400);
    if (b.consent !== true) return json({ error: "invalid", detail: "Please check the box so we can contact you." }, 400);
    const phone = "(" + phoneDigits.slice(0, 3) + ") " + phoneDigits.slice(3, 6) + "-" + phoneDigits.slice(6);
    const today = new Date().toISOString().slice(0, 10), stamp = new Date().toISOString();

    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const { data: recent } = await sb.from("leads").select("id,phone,email").gte("created_at", since);
    const dupe = (recent || []).find((l: Record<string, unknown>) => ((l.phone as string) || "").replace(/\D/g, "").slice(-10) === phoneDigits || (!!l.email && (l.email as string).toLowerCase() === email));
    if (dupe) return json({ ok: true, repeat: true });

    const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const { error } = await sb.from("leads").insert({
      id, name: name + (company ? " (" + company + ")" : ""), email, phone,
      source: "Website - Referral Partner", stage: "new", status: "active", assigned_to: "owner",
      created_at: today, created_at_ts: stamp, nurture_off: true, preferred_language: "en",
      activity: [
        { date: today, type: "note", text: "Referral partner sign-up from bplending.com/partners — " + kind + (company ? " at " + company : "") + (notes ? ". They said: " + notes : ""), author: "System" },
        { date: today, type: "system", text: "Consent recorded " + stamp + ": partner agreed to be contacted by phone, text and email about working with Bridgepoint. No automated messages are sent to partners.", author: "System" },
      ],
    });
    if (error) { console.error("partner-intake insert", error.message); return json({ error: "server_error", detail: "We couldn't save that — please try again." }, 500); }

    const text = "New referral partner: " + name + " (" + kind + ") " + phone + " — " + CRM_URL + "?lead=" + id;
    await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: "owner", lead_id: id, kind: "hot-lead", text, date: today, read: false });
    const { data: owner } = await sb.from("users").select("phone,email").eq("id", "owner").single();
    const post = (fn: string, payload: Record<string, unknown>) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify(payload),
    }).catch(() => null);
    if (owner?.phone) await post("send-text", { to: owner.phone, text, fromName: "Bridgepoint CRM" });
    if (owner?.email) await post("send-email", { to: owner.email, subject: "New referral partner: " + name, text, fromName: "Bridgepoint CRM" });
    return json({ ok: true });
  } catch (e) {
    console.error("partner-intake", String(e));
    return json({ error: "server_error", detail: "Something went wrong — please try again." }, 500);
  }
});
