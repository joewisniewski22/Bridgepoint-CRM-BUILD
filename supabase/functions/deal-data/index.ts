// Property data for the bplending.com Deal Analyzer ("pro" analysis): subject property facts, an automated value
// estimate, rent estimate, CLOSED SALES nearby (public-record sale prices) and local market stats -- all from RentCast.
//
// Cost control + abuse protection (this calls a paid API):
//   * the visitor must already be a captured lead from the analyzer (leadId + matching email, created in the last
//     2 days, source "Deal Analyzer") -- so every lookup is attached to a real contact;
//   * max 4 lookups per lead; results are cached by address for 14 days (a repeat costs nothing);
//   * with no RENTCAST_API_KEY set, returns {configured:false} and the site falls back to the manual analyzer.
// Closed-sale comps come from public records, which are NOT available in non-disclosure states (the response says so).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RENTCAST_KEY = Deno.env.get("RENTCAST_API_KEY") || "";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const NON_DISCLOSURE = ["AK", "ID", "KS", "LA", "MS", "MO", "MT", "NM", "ND", "TX", "UT", "WY"];
const MAX_LOOKUPS_PER_LEAD = 4;

async function rc(path: string, params: Record<string, string | number | undefined>) {
  const u = new URL("https://api.rentcast.io/v1" + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "") u.searchParams.set(k, String(v)); });
  const r = await fetch(u.toString(), { headers: { "X-Api-Key": RENTCAST_KEY, Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, data: null as unknown };
  return { ok: true, status: r.status, data: await r.json() };
}
const num = (v: unknown) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null; };
function median(a: number[]) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pct(a: number[], p: number) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; }
function miles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 3958.8, rad = (d: number) => d * Math.PI / 180, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (!RENTCAST_KEY) return json({ ok: true, configured: false });
    const b = await req.json();
    const address = String(b.address || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200);
    const leadId = String(b.leadId || ""), email = String(b.email || "").trim().toLowerCase();
    const need: string[] = Array.isArray(b.need) ? b.need.map(String) : ["value", "sold", "market"];
    if (address.length < 8) return json({ error: "invalid", detail: "Enter the full property address (street, city, state, ZIP)." }, 400);

    // gate: a real, recent analyzer lead
    const since = new Date(Date.now() - 2 * 86400000).toISOString();
    const { data: lead } = await sb.from("leads").select("id,email,source,created_at_ts").eq("id", leadId).maybeSingle();
    if (!lead || (lead.email || "").toLowerCase() !== email || !/Deal Analyzer/i.test(lead.source || "") || (lead.created_at_ts && lead.created_at_ts < since))
      return json({ error: "not_allowed", detail: "Please enter your contact information first." }, 403);
    const { count } = await sb.from("deal_data_hits").select("*", { count: "exact", head: true }).eq("lead_id", leadId);
    if ((count || 0) >= MAX_LOOKUPS_PER_LEAD) return json({ error: "limit", detail: "You've used your free property lookups. A loan officer can run more for you." }, 429);

    const key = address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + "|" + need.slice().sort().join(",");
    const { data: cached } = await sb.from("property_data_cache").select("payload,fetched_at").eq("address_key", key).maybeSingle();
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 14 * 86400000) {
      await sb.from("deal_data_hits").insert({ lead_id: leadId, address_key: key, cached: true });
      return json({ ok: true, configured: true, cached: true, ...(cached.payload as object) });
    }

    const warnings: string[] = [];
    const [propR, valR, rentR] = await Promise.all([
      rc("/properties", { address, limit: 1 }),
      need.indexOf("value") !== -1 ? rc("/avm/value", { address, compCount: 10 }) : Promise.resolve(null),
      need.indexOf("rent") !== -1 ? rc("/avm/rent/long-term", { address, compCount: 8 }) : Promise.resolve(null),
    ]);
    const subj = (Array.isArray(propR.data) && propR.data[0]) || (valR && valR.data && (valR.data as any).subjectProperty) || null;
    if (!subj) return json({ ok: true, configured: true, found: false, detail: "We couldn't find that address. Check the street, city, state and ZIP." });

    const out: Record<string, unknown> = {
      found: true,
      subject: { address: subj.formattedAddress, type: subj.propertyType, beds: subj.bedrooms, baths: subj.bathrooms, sqft: subj.squareFootage, lot: subj.lotSize, yearBuilt: subj.yearBuilt, lastSaleDate: subj.lastSaleDate, lastSalePrice: subj.lastSalePrice, zip: subj.zipCode, state: subj.state, lat: subj.latitude, lon: subj.longitude },
    };
    if (valR && valR.ok) { const v = valR.data as any; out.valueEstimate = { price: v.price, low: v.priceRangeLow, high: v.priceRangeHigh, comps: (v.comparables || []).slice(0, 6).map((c: any) => ({ address: c.formattedAddress, price: c.price, sqft: c.squareFootage, beds: c.bedrooms, baths: c.bathrooms, distance: c.distance, status: c.status, daysOnMarket: c.daysOnMarket })) }; }
    if (rentR && rentR.ok) { const r = rentR.data as any; out.rentEstimate = { rent: r.rent, low: r.rentRangeLow, high: r.rentRangeHigh, comps: (r.comparables || []).slice(0, 5).map((c: any) => ({ address: c.formattedAddress, rent: c.price, sqft: c.squareFootage, beds: c.bedrooms, distance: c.distance })) }; }

    // closed sales (public records): nearby, similar size, last 12 months
    if (need.indexOf("sold") !== -1 && num(subj.latitude) && num(subj.longitude)) {
      const sqft = num(subj.squareFootage), beds = num(subj.bedrooms);
      const params: Record<string, string | number> = { latitude: subj.latitude, longitude: subj.longitude, radius: 1, saleDateRange: 365, propertyType: subj.propertyType || "Single Family", limit: 60 };
      if (beds) params.bedrooms = Math.max(1, beds - 1) + "-" + (beds + 1);
      if (sqft) params.squareFootage = Math.round(sqft * 0.75) + "-" + Math.round(sqft * 1.3);
      const sold = await rc("/properties", params);
      const rows = (Array.isArray(sold.data) ? sold.data : []) as any[];
      const comps = rows.filter((p) => num(p.lastSalePrice) && num(p.squareFootage) && p.formattedAddress !== subj.formattedAddress && p.lastSaleDate).map((p) => ({
        address: p.formattedAddress, soldDate: String(p.lastSaleDate).slice(0, 10), price: p.lastSalePrice, sqft: p.squareFootage, beds: p.bedrooms, baths: p.bathrooms, yearBuilt: p.yearBuilt,
        ppsf: Math.round(p.lastSalePrice / p.squareFootage), distance: Math.round(miles(subj.latitude, subj.longitude, p.latitude, p.longitude) * 100) / 100,
        score: Math.abs((p.squareFootage - (sqft || p.squareFootage)) / (sqft || p.squareFootage)) + (p.latitude ? miles(subj.latitude, subj.longitude, p.latitude, p.longitude) * 0.15 : 0),
      })).sort((x, y) => x.score - y.score).slice(0, 12);
      const ppsfs = comps.map((c) => c.ppsf), prices = comps.map((c) => c.price);
      out.soldComps = comps.map(({ score, ...c }) => c);
      out.compStats = { count: comps.length, medianPrice: median(prices), medianPpsf: median(ppsfs), lowPpsf: pct(ppsfs, 0.25), highPpsf: pct(ppsfs, 0.75),
        arvMid: sqft && comps.length ? Math.round((median(ppsfs) as number) * sqft) : null, arvLow: sqft && comps.length ? Math.round((pct(ppsfs, 0.25) as number) * sqft) : null, arvHigh: sqft && comps.length ? Math.round((pct(ppsfs, 0.75) as number) * sqft) : null };
      if (comps.length < 3) warnings.push(NON_DISCLOSURE.indexOf(String(subj.state)) !== -1 ? "Sale prices are not public record in " + subj.state + ", so closed-sale comps are limited here. We're using listing-based estimates instead." : "Few closed sales matched nearby in the last 12 months, so treat the comp-based value as a rough guide.");
    }
    if (need.indexOf("market") !== -1 && subj.zipCode) {
      const m = await rc("/markets", { zipCode: subj.zipCode, dataType: "Sale", historyRange: 12 });
      if (m.ok) { const s = ((m.data as any).saleData) || {}; out.market = { zip: subj.zipCode, medianPrice: s.medianPrice, averagePrice: s.averagePrice, medianPpsf: s.medianPricePerSquareFoot, medianDaysOnMarket: s.medianDaysOnMarket, totalListings: s.totalListings, newListings: s.newListings }; }
    }
    out.warnings = warnings;
    out.source = "RentCast public-record and listing data; automated estimates, not an appraisal.";
    await sb.from("property_data_cache").upsert({ address_key: key, payload: out, fetched_at: new Date().toISOString() });
    await sb.from("deal_data_hits").insert({ lead_id: leadId, address_key: key, cached: false });
    return json({ ok: true, configured: true, cached: false, ...out });
  } catch (e) {
    console.error("deal-data", String(e));
    return json({ error: "server_error", detail: "We couldn't pull property data just now. Your manual analysis still works." }, 500);
  }
});
