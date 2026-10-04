// @ts-nocheck
// Public ballpark estimator for bplending.com (/estimate/).
//
// Joe (2026-10-04): a public version of our pricer, but safe. This function runs the REAL
// multi-lender pricer (check-live-rates) and then deliberately returns only a conservative
// RANGE -- never a lender name, price, fee or the margin structure -- so competitors can't
// lift our pricing and shoppers can't treat it as a quote. Exact numbers come from a loan
// officer after the visitor leaves their contact info (ad-lead-intake, which carries the
// scenario along so the first call starts with real numbers).
//
// Abuse protection: honeypot, strict whitelist/clamping of every input, and a per-IP hourly
// limit (table public_estimate_hits). Public on purpose (verify_jwt false).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const HOURLY_LIMIT = 25;

const STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NH","NJ","NM","NY","NC","OH","OK","PA","RI","SC","TN","TX","VA","WA","WV","WI","WY"];
const PROPERTY_TYPES = ["SFR", "Duplex", "2-4 Unit", "Multifamily 5+", "Mixed-Use", "Condo"];
const CREDIT = { "760+": 780, "720-759": 740, "680-719": 700, "640-679": 660, "Under 640": 620 };
const LOAN_TYPES = { dscr: "DSCR", fixflip: "Fix & Flip", bridge: "Bridge", ground: "Ground Up Construction" };

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.]/g, "")); return isFinite(n) && n > 0 && n < 1e10 ? n : null; };
const up = (x, step) => Math.ceil(x / step) * step;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const b = await req.json();
    if (b.website) return json({ ok: true, eligible: false, hidden: true }); // honeypot

    // --- per-IP hourly limit ---
    const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const since = new Date(Date.now() - 3600000).toISOString();
    const { count } = await sb.from("public_estimate_hits").select("*", { count: "exact", head: true }).eq("ip", ip).gte("at", since);
    if ((count || 0) >= HOURLY_LIMIT) return json({ error: "rate_limited", detail: "Too many estimates from this connection — please call us and we'll run it with you." }, 429);
    await sb.from("public_estimate_hits").insert({ ip });

    const loanType = LOAN_TYPES[String(b.program)] || null;
    const state = String(b.state || "").toUpperCase();
    if (!loanType) return json({ error: "invalid", detail: "Pick a loan type." }, 400);
    if (STATES.indexOf(state) === -1) return json({ error: "invalid", detail: "Pick the state the property is in." }, 400);
    const propertyType = PROPERTY_TYPES.indexOf(String(b.propertyType)) !== -1 ? String(b.propertyType) : "SFR";
    const credit = CREDIT[String(b.credit)];
    if (!credit) return json({ error: "invalid", detail: "Pick your estimated credit score range." }, 400);
    const value = num(b.value);
    if (!value || value < 25000) return json({ error: "invalid", detail: "Enter the purchase price or value (at least $25,000)." }, 400);
    const goal = String(b.goal) === "refi" ? "ratetermrefi" : String(b.goal) === "cashout" ? "cashout" : "purchase";
    const isDscr = loanType === "DSCR";
    const rent = num(b.rent), rehab = num(b.rehab), arv = num(b.arv);
    if (isDscr && !rent) return json({ error: "invalid", detail: "Enter the monthly rent." }, 400);
    if (!isDscr && (!rehab && loanType === "Fix & Flip")) return json({ error: "invalid", detail: "Enter the rehab budget (use a small number if light)." }, 400);
    if (!isDscr && loanType === "Fix & Flip" && !arv) return json({ error: "invalid", detail: "Enter the after-repair value." }, 400);
    const exp = { "First deal": 0, "1-2 deals": 1, "3-5 deals": 3, "6+ deals": 6 }[String(b.experience)];

    // Rough taxes/insurance when the visitor hasn't given them (DSCR only) -- stated as an assumption.
    const scenario = {
      loanType, transactionType: goal,
      propertyAddress: "100 Main St, Anytown, " + state + " 00000", propertyState: state, propertyType,
      creditScore: credit, purchasePrice: goal === "purchase" ? value : value, currentValue: goal === "purchase" ? null : value,
      loanAmount: null, rehabBudget: isDscr ? null : (rehab || 0), arv: isDscr ? null : (arv || value),
      entityType: "LLC", citizenshipStatus: "US Citizen", experienceDeals: exp == null ? (isDscr ? 2 : 0) : exp,
      rentEstimate: isDscr ? rent : null, monthlyTaxes: isDscr ? Math.round(value * 0.011 / 12) : null,
      monthlyInsurance: isDscr ? Math.round(value * 0.005 / 12) : null, monthlyHoa: isDscr ? 0 : null,
      pointsCharged: 0, termMonths: isDscr ? 360 : 12, prepayTerm: "5yr",
      guarantorFirstName: null, guarantorLastName: null, ruralStatus: null, liquidity: null, countryOfDomicile: null, currentLoanBalance: null,
    };
    const res = await fetch(SUPABASE_URL + "/functions/v1/check-live-rates", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify({ lead: scenario }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) return json({ error: "unavailable", detail: "We couldn't run that just now — leave your number and a loan officer will." }, 502);

    const eligible = (data.results || []).filter((r) => r && r.eligible && r.options && r.options.length);
    if (!eligible.length) return json({ ok: true, eligible: false, loanType });

    let low = null;
    if (isDscr) {
      // Lowest rate that still prices at par or better across all lenders (no points cost), else lowest overall.
      const par = [], all = [];
      eligible.forEach((r) => r.options.forEach((o) => { all.push(o.rate); if (o.price >= 100 - 0.0005) par.push(o.rate); }));
      low = Math.min.apply(null, par.length ? par : all);
    } else {
      const rates = [];
      eligible.forEach((r) => r.options.forEach((o) => rates.push(o.rate)));
      low = Math.min.apply(null, rates);
    }
    const rateLow = up(low, 0.125);
    const rateHigh = rateLow + (isDscr ? 0.5 : 0.75);
    let maxLoan = Math.max.apply(null, eligible.map((r) => r.maxLoanAmount || r.loanAmountUsed || 0));
    maxLoan = Math.floor((maxLoan * 0.97) / 5000) * 5000;
    return json({ ok: true, eligible: true, loanType, rateLow, rateHigh, maxLoan: maxLoan > 0 ? maxLoan : null, termMonths: scenario.termMonths });
  } catch (err) {
    console.error("public-estimate", String(err));
    return json({ error: "server_error", detail: "Something went wrong — please try again, or call us." }, 500);
  }
});
