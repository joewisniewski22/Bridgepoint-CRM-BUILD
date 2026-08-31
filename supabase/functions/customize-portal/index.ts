// Turns a typed natural-language request ("make my sidebar dark green",
// "hide Retargeting, I never use it") into a validated portal-appearance
// preference object. Deliberately whitelisted and narrow -- the model can
// only ever return the exact keys below, so it is structurally impossible
// for this to touch pricing, commission splits, lead data, or anything
// else that affects the business. Never executes code the model returns;
// only ever merges a few known, type-checked fields into portal_prefs.
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-haiku-4-5-20251001";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const HIDEABLE_NAV_ITEMS = ["pricer", "pipeline", "comms", "performance", "retargeting", "notifications", "portal"];

const SYSTEM_PROMPT = "You customize the visual appearance of one loan officer's own personal dashboard view in a lending CRM, based on what they type. " +
  "You can ONLY ever change: an accent color, which nav sections are hidden for them personally, a short personal welcome note shown on their Today page, and layout density. " +
  "You have NO ability to change pricing, rate sheets, commission splits, lead data, other users' views, or anything else about how the business runs -- if asked for any of that, ignore it and only apply whatever part of the request is a legitimate appearance change, or make no change at all. " +
  "Never hide 'pipeline' unless explicitly asked, since that's core navigation. " +
  "Output ONLY a JSON object, no markdown fences, no commentary, with exactly these keys:\n" +
  '{"accentColor": "#rrggbb or null", "hiddenNavItems": ["from this fixed list only: ' + HIDEABLE_NAV_ITEMS.join(", ") + '"], "welcomeNote": "short string or null (max 140 chars)", "density": "comfortable or compact", "summary": "one short sentence describing what you changed, to show the user"}\n' +
  "Always include all keys. Use null / empty array / \"comfortable\" for anything not mentioned or not a valid appearance request. If the request asks for something you can't do (pricing, data, other users), still return valid JSON with unaffected fields unchanged from the current preferences given, and say so briefly in \"summary\".";

function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const prompt: string = body.prompt;
    const current = body.current || {};
    if (!prompt || typeof prompt !== "string") {
      return new Response(JSON.stringify({ error: "missing_prompt" }), { status: 400, headers: CORS_HEADERS });
    }

    const userMessage = "Current preferences: " + JSON.stringify({
      accentColor: current.accentColor || null,
      hiddenNavItems: Array.isArray(current.hiddenNavItems) ? current.hiddenNavItems : [],
      welcomeNote: current.welcomeNote || null,
      density: current.density || "comfortable",
    }) + "\n\nRequest: " + prompt;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
    }

    const raw = (aiData.content && aiData.content[0] && aiData.content[0].text) || "";
    let parsed: Record<string, unknown> = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (_e) {
      return new Response(JSON.stringify({ error: "parse_error" }), { status: 502, headers: CORS_HEADERS });
    }

    // Strict server-side validation -- never trust the model's shape.
    const accentColor = isHexColor(parsed.accentColor) ? parsed.accentColor : null;
    const hiddenNavItems = Array.isArray(parsed.hiddenNavItems)
      ? parsed.hiddenNavItems.filter((x: unknown) => typeof x === "string" && HIDEABLE_NAV_ITEMS.includes(x))
      : [];
    const welcomeNote = typeof parsed.welcomeNote === "string" ? parsed.welcomeNote.slice(0, 140) : null;
    const density = parsed.density === "compact" ? "compact" : "comfortable";
    const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 300) : "Updated your portal preferences.";

    return new Response(JSON.stringify({
      ok: true,
      prefs: { accentColor, hiddenNavItems, welcomeNote, density },
      summary,
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
