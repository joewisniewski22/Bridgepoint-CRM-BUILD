// Writes ONE fresh social post and schedules it a few days out on the
// rolling content calendar. Deliberately NOT a "write 6 months of posts
// today" batch job -- Joe's explicit correction (2026-09-17): trends and
// market conditions shift over months, so content should stay current by
// being generated close to when it actually goes out, not locked in far
// in advance. Run this on a recurring pg_cron schedule (a few times a
// week) and it keeps the calendar topped up on a rolling basis.
//
// Grounded in two real, current things rather than generic filler:
// 1. This month/season's real-estate-investing context (seasonal buying
//    patterns, typical investor concerns for the time of year).
// 2. Bridgepoint's own actual current pricing (passed in below) --real
//    numbers from the live pricing engine, not made up figures. Update
//    CURRENT_RATE_CONTEXT here whenever the pricing engine's base rates
//    change so posts never quote a stale number.
//
// Language and posting hour are both picked by past performance, not
// fixed (Joe's ask, 2026-09-17: "the mix of when we post and what
// language should be determined on effectiveness"). Bridgepoint already
// runs real Spanish-language lead ads (see meta-leads-webhook /
// highlevel-leads-webhook), so Spanish-speaking investors are a real,
// existing audience here, not an afterthought. Until there's enough
// published-post history to actually compare performance, this falls
// back to alternating language (to build a balanced sample to learn
// from) and commonly-cited good engagement windows for local-business
// content -- see pickLanguage()/pickPostingHour() below for the exact
// logic and what "enough data" means.
//
// Scheduled a few days ahead (not same-day) on purpose, so someone can
// review/edit it via social-post-manager's "update" action before it
// actually publishes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Keep this in sync with index.html's DSCR_BASE_PAR_RATE / RTL_BASE_RATES
// whenever Constructive updates their sheet -- last synced 2026-09-16.
const CURRENT_RATE_CONTEXT = "DSCR rates currently start at 6.50% par (business-purpose investment property, no personal income docs required). Fix & flip / bridge (RTL) rates start around 9.99% for experienced repeat borrowers (11+ deals), scaling up for newer investors. Up to 90% of purchase price and 100% of rehab budget on fix & flip deals. Funding in as little as 7 days.";

// A minimum sample size before trusting engagement-rate comparisons over
// the safe fallback -- a handful of posts is too noisy to draw real
// conclusions from (one post catching a lucky algorithm boost shouldn't
// permanently lock in a language or hour).
const MIN_SAMPLE_PER_BUCKET = 4;

async function pickLanguage(): Promise<string> {
  const { data } = await sb.from("social_posts").select("language, impressions, engagement").eq("status", "published");
  const rows = data || [];
  const en = rows.filter((r) => r.language !== "es");
  const es = rows.filter((r) => r.language === "es");

  if (en.length >= MIN_SAMPLE_PER_BUCKET && es.length >= MIN_SAMPLE_PER_BUCKET) {
    const rate = (set: typeof rows) => {
      const withData = set.filter((r) => (r.impressions || 0) > 0);
      if (!withData.length) return 0;
      return withData.reduce((sum, r) => sum + (r.engagement || 0) / (r.impressions || 1), 0) / withData.length;
    };
    const enRate = rate(en);
    const esRate = rate(es);
    // Real engagement-rate difference found -- weight toward the winner
    // (70/30) rather than switching all-in, so the underperforming
    // language still gets sampled occasionally in case conditions change.
    if (Math.abs(enRate - esRate) > 0.005) {
      const winner = esRate > enRate ? "es" : "en";
      return Math.random() < 0.7 ? winner : (winner === "es" ? "en" : "es");
    }
  }
  // Not enough data yet (or a real tie) -- alternate to build a balanced
  // sample, weighted slightly toward English to start since it's the
  // default/larger audience today.
  return en.length <= es.length * 1.3 ? "en" : "es";
}

async function pickPostingHour(): Promise<number> {
  const { data } = await sb.from("social_posts").select("post_hour, impressions, engagement").eq("status", "published").not("post_hour", "is", null);
  const rows = data || [];
  const byHour = new Map<number, { imp: number; eng: number; n: number }>();
  for (const r of rows) {
    const h = r.post_hour as number;
    const cur = byHour.get(h) || { imp: 0, eng: 0, n: 0 };
    cur.imp += r.impressions || 0;
    cur.eng += r.engagement || 0;
    cur.n += 1;
    byHour.set(h, cur);
  }
  const qualified = [...byHour.entries()].filter(([, v]) => v.n >= MIN_SAMPLE_PER_BUCKET && v.imp > 0);
  if (qualified.length >= 2) {
    qualified.sort((a, b) => (b[1].eng / b[1].imp) - (a[1].eng / a[1].imp));
    return qualified[0][0];
  }
  // Commonly-cited solid engagement windows for local-business/finance
  // content until real data says otherwise: late morning or early evening
  // on weekdays. Alternate between the two to keep sampling both.
  const fallbackHours = [11, 18];
  return fallbackHours[Math.floor(Date.now() / (1000 * 60 * 60 * 24)) % fallbackHours.length];
}

function buildPrompt(language: string, now: Date): string {
  const monthName = now.toLocaleString(language === "es" ? "es-ES" : "en-US", { month: "long" });
  if (language === "es") {
    return `Estás escribiendo UNA publicación de Facebook/Instagram para Bridgepoint Lending, un prestamista de bienes raíces con propósito comercial para inversionistas (fix & flip, bridge, construcción desde cero, préstamos DSCR de alquiler, préstamos de portafolio -- NO hipotecas de vivienda propia/consumidor).

Hoy es ${now.toLocaleDateString("es-ES")} (${monthName}). Escribe una publicación que se sienta genuinamente oportuna para este momento del año -- referencia dinámicas estacionales reales que interesan a los inversionistas de bienes raíces ahora mismo, no una línea genérica que podría publicarse en cualquier mes.

Basala en esta información de precios real y actual -- úsala de forma natural, no la enumeres: ${CURRENT_RATE_CONTEXT}

Escribe en un tono seguro, directo y natural en español (no una traducción literal de inglés corporativo). Sin exceso de hashtags (0-2 máximo). Sin emojis a menos que uno encaje naturalmente. 80-150 palabras. Termina con una llamada a la acción clara y de baja fricción (ej. "Escríbenos" / "link en la bio" / "llámanos o envíanos un mensaje").

Escribe SOLO el texto de la publicación, nada más -- sin preámbulo, sin comillas alrededor, sin "Aquí tienes un borrador:".`;
  }
  return `You are writing ONE Facebook/Instagram post for Bridgepoint Lending, a business-purpose hard-money/DSCR lender for real estate investors (fix & flip, bridge, ground-up construction, DSCR rental, portfolio loans -- NOT owner-occupied/consumer mortgages).

Today is ${now.toDateString()} (${monthName}). Write a post that feels genuinely timely for this specific point in the year -- reference real seasonal dynamics real-estate investors care about right now (e.g. spring acquisition season, year-end tax-driven refinancing, winter renovation timing, back-to-school rental turnover, whatever is actually relevant to ${monthName}), not a generic evergreen line that could run any month.

Ground it in this real, current pricing info -- use it naturally, don't just list it: ${CURRENT_RATE_CONTEXT}

Write in a confident, direct, non-corporate voice. No hashtag spam (0-2 max if any). No emojis unless one lands naturally. 80-150 words. End with a clear, low-friction call to action (e.g. "DM us" / "link in bio" / "call/text us").

Output ONLY the post caption text, nothing else -- no preamble, no quotation marks around it, no "Here's a draft:".`;
}

Deno.serve(async () => {
  const now = new Date();
  const [language, postHour] = await Promise.all([pickLanguage(), pickPostingHour()]);
  const prompt = buildPrompt(language, now);

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const claudeData = await claudeRes.json();
  if (!claudeRes.ok) {
    console.error("generate-social-content: Claude call failed", JSON.stringify(claudeData));
    return new Response(JSON.stringify({ error: "generation_failed", detail: claudeData }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
  const caption = (claudeData.content?.[0]?.text || "").trim();
  if (!caption) {
    return new Response(JSON.stringify({ error: "empty_generation" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  // Schedule 4 days out at the chosen hour -- gives real review time
  // before it fires, and keeps the rolling calendar topped up without
  // ever piling up a big batch of far-future, potentially-stale content.
  const scheduledAt = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
  scheduledAt.setHours(postHour, 0, 0, 0);

  const createRes = await fetch(SUPABASE_URL + "/functions/v1/social-post-manager", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
    body: JSON.stringify({
      action: "create",
      caption,
      language,
      postHour,
      // Facebook only for now -- Instagram's Content Publishing API flatly
      // requires an image or video (see publish-scheduled-social), and
      // this function doesn't generate visuals yet. Add "instagram" once
      // a media step exists, or attach media manually via "update" before
      // it publishes and add "instagram" to platforms then.
      platforms: ["facebook"],
      scheduledAt: scheduledAt.toISOString(),
      createdBy: "ai",
    }),
  });
  const createData = await createRes.json();

  return new Response(JSON.stringify({ ok: true, caption, language, postHour, scheduledAt: scheduledAt.toISOString(), result: createData }), { headers: { "Content-Type": "application/json" } });
});
