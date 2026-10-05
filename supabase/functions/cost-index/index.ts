// Real construction-materials price trend for the Deal Analyzer's rehab estimate.
// Source: U.S. Bureau of Labor Statistics, Producer Price Index "Inputs to residential construction" (series
// WPUIP2310001), free public API. We cache it for 7 days and return the latest value, the value 12 months earlier,
// and the ratio versus a fixed baseline month, which the analyzer uses to scale its base cost table.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Content-Type": "application/json" };
const SERIES = "WPUIP2310001";
const BASELINE = { year: "2025", period: "M01" }; // the base cost table is stated in January-2025 dollars

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { data: cached } = await sb.from("cost_index_cache").select("payload,fetched_at").eq("series", SERIES).maybeSingle();
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 7 * 86400000) return new Response(JSON.stringify({ ok: true, cached: true, ...(cached.payload as object) }), { headers: CORS });
    const r = await fetch("https://api.bls.gov/publicAPI/v1/timeseries/data/" + SERIES);
    const j = await r.json();
    const rows: Array<{ year: string; period: string; value: string }> = (j?.Results?.series?.[0]?.data) || [];
    if (!rows.length) throw new Error("no BLS data");
    const val = (y: string, p: string) => { const x = rows.find((d) => d.year === y && d.period === p); return x ? Number(x.value) : null; };
    const latest = rows[0], latestVal = Number(latest.value);
    const yAgo = val(String(Number(latest.year) - 1), latest.period);
    const base = val(BASELINE.year, BASELINE.period) || latestVal;
    const payload = { series: SERIES, label: "Inputs to residential construction (BLS PPI)", asOf: latest.year + "-" + latest.period.replace("M", ""), latest: latestVal, yearAgo: yAgo, yoy: yAgo ? latestVal / yAgo - 1 : null, baseline: base, baselineLabel: "January 2025", ratio: latestVal / base };
    await sb.from("cost_index_cache").upsert({ series: SERIES, payload, fetched_at: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: true, cached: false, ...payload }), { headers: CORS });
  } catch (e) {
    const { data: stale } = await sb.from("cost_index_cache").select("payload").eq("series", SERIES).maybeSingle();
    if (stale) return new Response(JSON.stringify({ ok: true, stale: true, ...(stale.payload as object) }), { headers: CORS });
    return new Response(JSON.stringify({ ok: false, error: "unavailable" }), { status: 200, headers: CORS });
  }
});
