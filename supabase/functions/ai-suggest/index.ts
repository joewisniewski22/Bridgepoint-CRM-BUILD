// Generates short, specific text (win-back messages, birthday messages,
// plain-English guideline explanations, social post ideas) using Claude.
// Called from the CRM frontend with the Supabase publishable (anon) key.
// Never auto-sends or auto-posts anything -- always returns a draft for a
// human to review and send themselves.
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-haiku-4-5-20251001";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = "You are a copywriting assistant for Bridgepoint Lending, a hard-money and DSCR real estate lender. " +
  "Write in a warm, direct, non-corporate voice -- like a loan officer who actually knows the client, not a marketing bot. " +
  "No emojis unless asked for. No hashtags unless asked for. Keep it concise. Output only the requested text, nothing else -- no preamble, no quotation marks around it, no \"Here's a draft:\".";

function buildPrompt(kind: string, context: Record<string, unknown>): string | null {
  if (kind === "winback") {
    return "Write a short (2-4 sentence) text or email opener to re-engage a lead who has gone quiet. " +
      "Borrower: " + (context.name || "the borrower") + ". Loan type: " + (context.loanType || "unknown") + ". " +
      "Property: " + (context.propertyAddress || "not specified") + ". " +
      "Days since last contact: " + (context.daysSinceContact ?? "unknown") + ". " +
      "Why they went quiet / last known reason: " + (context.reason || "not specified") + ". " +
      "Current market context: " + (context.marketContext || "none provided") + ". " +
      "Loan officer's name to sign as: " + (context.loName || "the loan officer") + ". " +
      "Make it specific to their situation, not generic. Give a natural reason to reach back out now.";
  }
  if (kind === "birthday") {
    return "Write a short, warm birthday message (2-3 sentences) from a loan officer to a client. " +
      "Client name: " + (context.name || "the client") + ". Loan type: " + (context.loanType || "unknown") + ". " +
      "Property: " + (context.propertyAddress || "not specified") + ". " +
      "Loan officer's name to sign as: " + (context.loName || "the loan officer") + ". " +
      "If it makes sense, lightly reference their property/investment relationship, but don't force it. Keep it genuine, not salesy.";
  }
  if (kind === "guideline-explain") {
    var checks = Array.isArray(context.checks) ? context.checks as Array<Record<string, unknown>> : [];
    var failedList = checks.filter(function(c){ return !c.pass; })
      .map(function(c){ return "- " + c.label + ": " + c.detail; }).join("\n");
    return "A loan file failed an internal underwriting pre-check. Write a short, plain-English message (3-5 sentences) " +
      "a loan processor can send to the loan officer explaining exactly what's blocking approval and what needs to change " +
      "for it to qualify. Be specific and actionable, not vague. Don't restate raw numbers awkwardly -- translate them into what the borrower actually needs to do.\n\n" +
      "Loan type: " + (context.loanType || "unknown") + "\n" +
      "Failed checks:\n" + (failedList || "none specified");
  }
  if (kind === "social-post") {
    return "Write " + (context.count || 3) + " short social media post ideas (2-3 sentences each, numbered) for a hard-money/DSCR lender " +
      "to post about current rates and programs. " +
      "Loan type focus: " + (context.loanType || "general") + ". " +
      "Rate context: " + (context.rateContext || "no specific rate change to highlight") + ". " +
      "Target audience: real estate investors. Make each idea distinct in angle (e.g. one urgency-driven, one educational, one social-proof style). No hashtags, no emojis.";
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
    const kind: string = body.kind;
    const context: Record<string, unknown> = body.context || {};

    const prompt = buildPrompt(kind, context);
    if (!prompt) {
      return new Response(JSON.stringify({ error: "unknown_kind" }), { status: 400, headers: CORS_HEADERS });
    }

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
    }

    const text = (aiData.content && aiData.content[0] && aiData.content[0].text) || "";
    return new Response(JSON.stringify({ ok: true, suggestion: text.trim() }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
