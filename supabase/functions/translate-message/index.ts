// Translates a single message for the live text-conversation language
// feature: an LO writes in English and it's sent to the client in their
// selected language (see index.html sendTextViaQuo), or an inbound reply
// from the client is translated to English for the LO (see receive-text /
// receive-email). Deliberately dumb and stateless -- one string in, one
// string out -- so both directions can call the same function.
// Called from the CRM frontend and from other edge functions with the
// Supabase publishable (anon) key, same as send-text/send-email.
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-sonnet-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const text: string = (body.text || "").trim();
    const targetLanguage: string = (body.targetLanguage || "").trim();
    if (!text || !targetLanguage) {
      return new Response(JSON.stringify({ error: "missing_text_or_targetLanguage" }), { status: 400, headers: CORS_HEADERS });
    }

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: "You are a translation engine for real SMS messages between a US hard-money lender's loan officer and a borrower. Translate the user's message into " + targetLanguage + ". Preserve meaning, tone, and any names/numbers/links exactly. If the message is already in " + targetLanguage + ", return it unchanged. Output ONLY the translated message text -- no quotes, no preamble, no explanation.",
        messages: [{ role: "user", content: text }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
    }
    const translated = (aiData.content || []).filter((c: Record<string, unknown>) => c.type === "text").map((c: Record<string, unknown>) => c.text).join("\n").trim();
    if (!translated) {
      return new Response(JSON.stringify({ error: "empty_translation" }), { status: 502, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ ok: true, translated }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
