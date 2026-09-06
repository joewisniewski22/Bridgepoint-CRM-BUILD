// Shared coaching-note generator, called for all three sources:
// - "call": a real Quo call summary/transcript just came in (quo-call-webhook)
// - "lost_deal": a loan officer just marked a lead lost (moveStage -> lost)
// - "next_time": on-demand, before their next conversation with this client
//
// Internal only. Never contacts the borrower, never texts the staff member
// (in-app notification only) -- Joe was explicit he doesn't want this to
// mean more outbound texts. Loan officers only, never Erika (processor).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-5";
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const NEPQ_PRIMER =
  "Coach through the lens of consultative, question-led selling (the NEPQ approach: connection questions, then situation questions, then problem-awareness questions that get the client to state their own urgency/consequences, then a natural next step) rather than pitch-and-close. " +
  "Never generic ('be more confident', 'build rapport') -- ground every point in what actually happened or is actually known about this specific person.";

function buildHistoryText(lead: Record<string, unknown>): string {
  const activity = (lead.activity as Array<Record<string, unknown>>) || [];
  const calls = (lead.call_attempts as Array<Record<string, unknown>>) || [];
  const lines: string[] = [];
  lines.push("Borrower: " + lead.name + " | Loan type: " + (lead.loan_type || "unknown") + " | Loan amount: " + (lead.loan_amount || "unknown") + " | Stage: " + lead.stage + " | Status: " + lead.status);
  if (calls.length) {
    lines.push("\nCall history:");
    for (const c of calls) lines.push("- " + c.date + ": " + c.outcome + (c.notes ? (" — " + c.notes) : ""));
  }
  const convo = activity.filter((a) => a.type === "text" || a.type === "call" || a.type === "email");
  if (convo.length) {
    lines.push("\nActivity (calls/texts/emails):");
    for (const a of convo.slice(-25)) lines.push("- " + a.date + " [" + a.type + "]: " + a.text);
  }
  return lines.join("\n");
}

async function callClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("anthropic_error: " + JSON.stringify(data));
  const block = (data.content || []).find((c: Record<string, unknown>) => c.type === "text");
  return (block && block.text) || "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const leadId: string = body.leadId;
    const source: string = body.source; // 'call' | 'lost_deal' | 'next_time'
    const callContext: string | null = body.callContext || null; // Quo summary/next-steps text, for source='call'
    let staffId: string | null = body.staffId || null;
    if (!leadId || !source) return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS_HEADERS });

    const { data: lead } = await sb.from("leads").select("*").eq("id", leadId).single();
    if (!lead) return new Response(JSON.stringify({ error: "lead_not_found" }), { status: 404, headers: CORS_HEADERS });
    if (!staffId) staffId = lead.assigned_to as string;
    if (!staffId) return new Response(JSON.stringify({ error: "no_assignee" }), { status: 400, headers: CORS_HEADERS });

    const { data: staff } = await sb.from("users").select("id,name,role").eq("id", staffId).single();
    if (!staff || staff.role !== "loan_officer") {
      // Coaching is for salespeople -- never generate/store one for a
      // processor or the owner-as-owner, even if a call somehow matched.
      return new Response(JSON.stringify({ ok: true, skipped: "not_a_loan_officer" }), { headers: CORS_HEADERS });
    }

    const history = buildHistoryText(lead);
    let prompt: string;
    if (source === "call") {
      prompt = "You're coaching " + staff.name + ", a loan officer at Bridgepoint Lending (business-purpose real estate loans -- DSCR, fix & flip, bridge, etc.), on a call they just had. " + NEPQ_PRIMER +
        "\n\nCall summary/notes from this call:\n" + (callContext || "(no summary available)") +
        "\n\nFull context on this lead:\n" + history +
        "\n\nWrite ONE short coaching note (3-5 sentences max): what they did well, one specific thing to improve, and what to bring up next time they talk to this client. Plain text only, no headers/markdown, write it AS ADVICE TO THEM (\"you...\"), not a summary of the call.";
    } else if (source === "lost_deal") {
      prompt = "You're coaching " + staff.name + ", a loan officer at Bridgepoint Lending, on a deal that was JUST marked lost. " + NEPQ_PRIMER +
        "\n\nFull context on this lead:\n" + history +
        "\n\nWrite ONE short, honest note (3-5 sentences max) on why this deal was likely lost based on what's actually in the history above, and what they should do differently next time a similar situation comes up. If the history doesn't give enough to say why, say that plainly instead of guessing. Plain text only, write it AS ADVICE TO THEM (\"you...\").";
    } else if (source === "next_time") {
      prompt = "You're coaching " + staff.name + ", a loan officer at Bridgepoint Lending, before their NEXT conversation with this specific client. " + NEPQ_PRIMER +
        "\n\nFull context on this lead:\n" + history +
        "\n\nWrite ONE short, specific note (3-5 sentences max) on what to bring up and how to approach the next conversation with THIS client -- reference what's already been discussed, what's still unknown, and one good next question to ask. Plain text only, write it AS ADVICE TO THEM (\"you...\").";
    } else {
      return new Response(JSON.stringify({ error: "invalid_source" }), { status: 400, headers: CORS_HEADERS });
    }

    const note = (await callClaude(prompt)).trim();
    if (!note) return new Response(JSON.stringify({ error: "empty_note" }), { status: 502, headers: CORS_HEADERS });

    const id = "coach-" + crypto.randomUUID();
    await sb.from("coaching_notes").insert({ id, lead_id: leadId, staff_id: staffId, source, note });

    // In-app only -- deliberately no text/email, per Joe's explicit "I
    // don't want to increase texts."
    await sb.from("notifications").insert({
      id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: staffId, lead_id: leadId,
      kind: "coaching", text: "New coaching tip on " + lead.name + ": " + note.slice(0, 100),
      date: new Date().toISOString().slice(0, 10), read: false,
    });

    return new Response(JSON.stringify({ ok: true, id, note }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
