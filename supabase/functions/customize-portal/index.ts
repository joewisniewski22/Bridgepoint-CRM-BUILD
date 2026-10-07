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

const HIDEABLE_NAV_ITEMS = ["pricer", "pipeline", "comms", "performance", "retargeting", "referrals", "repeat", "notifications", "portal", "messages", "teamchat", "email", "calendar", "leads"];
// Processor workspace settings (Joe 2026-10-07: Erika should be able to customize her own system).
const BOARD_FILTERS = ["all", "me", "week", "borrower", "third", "quiet"];
const BOARD_CHECKS = ["Docs", "Title", "Insurance", "Appraisal", "Lender", "Conditions"];
const MOBILE_TABS = ["files", "messages", "team", "new", "today", "contacts"];
// Which alerts text the person vs. in-app only ("how things flow to her" -- Joe 2026-10-07).
const ALERT_KINDS: Record<string, string> = {
  "appraisal": "appraisal orders", "title": "title orders", "uw-condition": "new underwriting conditions", "uw-condition-response": "borrower answered a condition",
  "portal-message": "borrower portal messages", "ai-flag": "AI document flags", "third-party": "title/insurance replies", "application": "applications submitted",
  "sent-back": "file sent back", "reassigned": "file reassigned to them", "note": "notes/mentions", "file-dead": "file marked dead", "hot-lead": "new leads", "text": "client text messages",
};

const SYSTEM_PROMPT = "You customize the visual appearance of one loan officer's own personal dashboard view in a lending CRM, based on what they type. " +
  "You can ONLY ever change these personal view settings: an accent color, which nav sections are hidden for them personally, a short personal welcome note shown on their Today page, layout density, " +
  "which alerts TEXT them vs. stay in-app only (textKinds = the alert kinds that SHOULD text them; every other kind stays in-app only; use null if they did not mention alerts. Kinds: " + Object.entries(ALERT_KINDS).map(([k, v]) => k + "=" + v).join("; ") + "), " +
  "and (for the processor's Processing Board) the default filter, which checklist columns are hidden, how the board is sorted, how many quiet days flag a file, and which tab the phone app opens on. " +
  "If they ask for something bigger than these settings (a new feature, a new button, changing how something works, a new report), do NOT pretend to do it -- put a clear one-sentence description of the request in \"changeRequest\" so it can be sent to the owner (Joe) for approval. " +
  "Pricing, rates, fees and points are controlled ONLY by the owner (Joe): never put a pricing change in changeRequest, and in summary say plainly that pricing can only be changed by Joe (do not say it was sent to him). " +
  "You have NO ability to change pricing, rate sheets, commission splits, lead data, other users' views, or anything else about how the business runs -- if asked for any of that, ignore it and only apply whatever part of the request is a legitimate appearance change, or make no change at all. " +
  "Never hide 'pipeline' unless explicitly asked, since that's core navigation. " +
  "Output ONLY a JSON object, no markdown fences, no commentary, with exactly these keys:\n" +
  '{"accentColor": "#rrggbb or null", "hiddenNavItems": ["from this fixed list only: ' + HIDEABLE_NAV_ITEMS.join(", ") + '"], "welcomeNote": "short string or null (max 140 chars)", "density": "comfortable or compact", "boardDefaultFilter": "one of: ' + BOARD_FILTERS.join(", ") + ' (all=every file, me=files waiting on me, week=closing within 7 days, borrower=waiting on borrower, third=waiting on title/insurance/appraiser, quiet=gone quiet)", "boardHiddenChecks": ["from: ' + BOARD_CHECKS.join(", ") + '"], "boardSort": "urgency or closeDate", "quietDays": "integer 2-14", "textKinds": ["alert kinds that SHOULD text them"] or null, "mobileDefaultTab": "one of: ' + MOBILE_TABS.join(", ") + ' or null", "changeRequest": "string or null", "summary": "one short sentence describing what you changed (and that a bigger request was sent to Joe, if any)"}\n' +
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
      boardDefaultFilter: current.boardDefaultFilter || "all",
      boardHiddenChecks: Array.isArray(current.boardHiddenChecks) ? current.boardHiddenChecks : [],
      boardSort: current.boardSort || "urgency",
      quietDays: current.quietDays || 5,
      mobileDefaultTab: current.mobileDefaultTab || null,
      mutedTextKinds: Array.isArray(current.mutedTextKinds) ? current.mutedTextKinds : [],
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
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
    }

    // Claude's response can include a "thinking" block before the actual
    // "text" block -- never assume content[0] is the text.
    const textBlock = (aiData.content || []).find((c: Record<string, unknown>) => c.type === "text");
    const raw = (textBlock && textBlock.text) || "";
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

    const boardDefaultFilter = BOARD_FILTERS.includes(parsed.boardDefaultFilter as string) ? parsed.boardDefaultFilter : "all";
    const boardHiddenChecks = Array.isArray(parsed.boardHiddenChecks) ? parsed.boardHiddenChecks.filter((x: unknown) => typeof x === "string" && BOARD_CHECKS.includes(x)) : [];
    const boardSort = parsed.boardSort === "closeDate" ? "closeDate" : "urgency";
    const qd = Math.round(Number(parsed.quietDays));
    const quietDays = qd >= 2 && qd <= 14 ? qd : 5;
    const mobileDefaultTab = MOBILE_TABS.includes(parsed.mobileDefaultTab as string) ? parsed.mobileDefaultTab : null;
    // textKinds = what SHOULD text them; everything else is muted. null = leave as it was.
    const prevMuted = Array.isArray(current.mutedTextKinds) ? current.mutedTextKinds.filter((x: unknown) => typeof x === "string" && x in ALERT_KINDS) : [];
    const mutedTextKinds = Array.isArray(parsed.textKinds)
      ? Object.keys(ALERT_KINDS).filter((k) => !(parsed.textKinds as unknown[]).includes(k))
      : prevMuted;
    const changeRequest = typeof parsed.changeRequest === "string" && parsed.changeRequest.trim() ? parsed.changeRequest.trim().slice(0, 400) : null;

    return new Response(JSON.stringify({
      ok: true,
      prefs: { accentColor, hiddenNavItems, welcomeNote, density, boardDefaultFilter, boardHiddenChecks, boardSort, quietDays, mobileDefaultTab, mutedTextKinds },
      changeRequest,
      summary,
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
