// Deal Analyzer prefill (Joe 2026-10-06): when an LO sends the analyzer from a
// file ("Send Deal Analyzer"), the link carries ?ref=<file id>&t=<the file's
// application token>. The analyzer calls this to fill in the REAL deal and the
// terms we quoted, so the client sees their actual numbers. The public website
// analyzer (no ref/t) stays blank for marketing.
//
// Returns deal numbers and quoted terms only -- never contact info, SSN, DOB,
// bank data or documents. Wrong/missing token = nothing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });
const n = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
const r1 = (v: number) => Math.round(v * 10) / 10;

function creditBand(f: number | null) { return f == null ? null : f >= 760 ? "760+" : f >= 720 ? "720-759" : f >= 680 ? "680-719" : f >= 640 ? "640-679" : "Under 640"; }
function expBand(d: number | null) { return d == null ? null : d >= 6 ? "6+ deals" : d >= 3 ? "3-5 deals" : d >= 1 ? "1-2 deals" : "First deal"; }
function stateOf(a: string | null) { const m = /,\s*([A-Za-z]{2})\s*\d{0,5}(?:-\d{4})?\s*$/.exec(String(a || "").replace(/,\s*(USA|US|United States)\s*$/i, "").trim()); return m ? m[1].toUpperCase() : null; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const ref = String(b.ref || "").slice(0, 40), t = String(b.t || "").slice(0, 200);
    if (!ref || !t) return json({ ok: false }, 400);
    const { data: l } = await sb.from("leads").select("id,loan_type,transaction_type,property_address,purchase_price,current_value,rehab_budget,arv,rent_estimate,monthly_taxes,monthly_insurance,monthly_hoa,loan_amount,rate,points_charged,term_months,credit_score,experience_deals,application_token,guideline_check,assigned_to").eq("id", ref).maybeSingle();
    if (!l || !l.application_token || l.application_token !== t) return json({ ok: false }, 404);

    const lt = String(l.loan_type || "");
    const type = /DSCR|Portfolio/i.test(lt) ? "rental" : /Bridge/i.test(lt) ? "bridge" : /Ground Up|Construction/i.test(lt) ? "build" : "flip";
    const refi = l.transaction_type && l.transaction_type !== "purchase";
    const price = n(refi ? (l.current_value ?? l.purchase_price) : l.purchase_price);
    const rehab = n(l.rehab_budget), arv = n(l.arv), loan = n(l.loan_amount), rate = n(l.rate), pts = n(l.points_charged);
    const terms = (l.guideline_check && (l.guideline_check as any).pricerTerms) || null;
    const fields: Record<string, number> = {}, fin: Record<string, number> = {};
    const put = (o: Record<string, number>, k: string, v: number | null) => { if (v != null && isFinite(v)) o[k] = v; };

    if (type === "rental") {
      put(fields, "price", price); put(fields, "rent", n(l.rent_estimate));
      put(fields, "taxes", n(l.monthly_taxes)); put(fields, "insurance", n(l.monthly_insurance)); put(fields, "hoa", n(l.monthly_hoa));
      if (price && loan) put(fin, "downPct", r1(Math.max(0, 100 - loan / price * 100)));
    } else if (type === "build") {
      put(fields, "land", price); put(fields, "hard", rehab); put(fields, "arv", arv);
      if (loan && (price || 0) + (rehab || 0) > 0) put(fin, "ltcPct", r1(loan / ((price || 0) + (rehab || 0)) * 100));
      if (loan && arv) put(fin, "arvCapPct", Math.ceil(loan / arv * 1000) / 10);
    } else {
      put(fields, "price", price); put(fields, "rehab", type === "bridge" ? (rehab || 0) : rehab); put(fields, "arv", arv || (type === "bridge" ? price : null));
      // Day-one advance = loan minus the rehab holdback (100% of rehab funded unless the lender said otherwise).
      const hold = Math.min(rehab || 0, loan || 0);
      if (loan && price) { put(fin, "ltcPct", r1(Math.max(0, loan - hold) / price * 100)); put(fin, "rehabPct", 100); }
      if (loan && (arv || price)) put(fin, "arvCapPct", Math.ceil(loan / (arv || price!) * 1000) / 10);
    }
    put(fin, "rate", rate); put(fin, "points", pts);

    let loName: string | null = null;
    if (l.assigned_to) { const { data: u } = await sb.from("users").select("name").eq("id", l.assigned_to).maybeSingle(); loName = u ? u.name : null; }
    return json({
      ok: true, type, fields, fin,
      state: stateOf(l.property_address), credit: creditBand(n(l.credit_score)), experience: expBand(n(l.experience_deals)),
      address: l.property_address ? String(l.property_address).replace(/,\s*USA$/, "") : null,
      quoted: { rate, points: pts, loanAmount: loan, applied: !!(terms || rate), loName },
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
