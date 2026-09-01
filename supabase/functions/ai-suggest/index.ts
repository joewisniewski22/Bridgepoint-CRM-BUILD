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

const JSON_SYSTEM_PROMPT = "You are a precise data-mapping assistant. Output ONLY valid JSON matching exactly what's requested -- no markdown code fences, no commentary, no preamble.";

function buildPrompt(kind: string, context: Record<string, unknown>): string | null {
  const lang = (context.language as string) || "English";
  const langNote = lang !== "English" ? " Write the entire message in " + lang + ", natural and fluent, not a literal word-for-word translation." : "";
  if (kind === "winback") {
    return "Write a short (2-4 sentence) text or email opener to re-engage a lead who has gone quiet." + langNote + " " +
      "Borrower: " + (context.name || "the borrower") + ". Loan type: " + (context.loanType || "unknown") + ". " +
      "Property: " + (context.propertyAddress || "not specified") + ". " +
      "Days since last contact: " + (context.daysSinceContact ?? "unknown") + ". " +
      "Why they went quiet / last known reason: " + (context.reason || "not specified") + ". " +
      "Current market context: " + (context.marketContext || "none provided") + ". " +
      "Loan officer's name to sign as: " + (context.loName || "the loan officer") + ". " +
      "Make it specific to their situation, not generic. Give a natural reason to reach back out now.";
  }
  if (kind === "birthday") {
    return "Write a short, warm birthday message (2-3 sentences) from a loan officer to a client." + langNote + " " +
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
  if (kind === "map-csv-columns") {
    const headers = Array.isArray(context.headers) ? context.headers as string[] : [];
    const sampleRows = Array.isArray(context.sampleRows) ? context.sampleRows as string[][] : [];
    const headerList = headers.map(function(h, i) { return i + ": " + h; }).join("\n");
    const sampleBlock = sampleRows.map(function(r, ri) {
      return "Row " + (ri + 1) + ": " + r.map(function(v, i) { return headers[i] + "=" + JSON.stringify(v); }).join(", ");
    }).join("\n");
    return "You are mapping columns from an imported contact list (likely exported from a CRM like GoHighLevel) to a fixed set of target fields.\n\n" +
      "Columns (index: header name):\n" + headerList + "\n\n" +
      "Sample data rows:\n" + sampleBlock + "\n\n" +
      "Target fields to map: firstName, lastName, fullName (a single combined name column, use ONLY if there's no separate first/last), email, phone, address.\n\n" +
      "Respond with ONLY a JSON object (no markdown fences, no explanation) with these exact keys: firstName, lastName, fullName, email, phone, address. " +
      "Each value must be the column INDEX (integer) that best matches that field, or null if no column matches. " +
      "Use the sample data values, not just header names, to judge fit (e.g. a column with values like \"john@example.com\" is email even if its header is oddly named).";
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
    const isJsonKind = kind === "map-csv-columns";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: isJsonKind ? 300 : 400,
        system: isJsonKind ? JSON_SYSTEM_PROMPT : SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
    }

    // Claude's response can include a "thinking" block before the actual
    // "text" block -- never assume content[0] is the text.
    const textBlock = (aiData.content || []).find((c: Record<string, unknown>) => c.type === "text");
    const text = (textBlock && textBlock.text) || "";
    return new Response(JSON.stringify({ ok: true, suggestion: text.trim() }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
