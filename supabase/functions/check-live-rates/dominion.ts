// Dominion Financial -- live DSCR pricing (Joe 2026-10-14: "might as well add them to the pricer now"). Dominion's broker portal runs on LoanPASS
// (app.loanpass.io/c/dominion) and prices several DSCR investor programs in one place. We sign in with Joe's broker login (DOMINION_USERNAME /
// DOMINION_PASSWORD secrets, entered by Joe -- never typed by the assistant), call the same API the portal uses (execute-summary to see which
// programs fit, execute-product for each program's rate/price grid), and return the best options at a 30-day lock. Read-only: nothing is created
// or saved on Dominion's side. Program names stay internal (owner / Fiore / Erika only); borrowers, partners and other LOs never see them.
//
// Verified in the browser 10/14/26: every call below worked with a signed-in session. The one thing not yet verified server-side is the sign-in
// request itself (body {clientAccessId, emailAddress, password} -> {sessionToken}); if it needs adjusting the pricer reports "unavailable".

const BASE = "https://app.loanpass.io/api/";
const CLIENT = "dominion";
const PROFILE_ID = "674"; // Joe's pricing profile on the portal
type S = any;

let tokenMemo: { token: string; exp: number } | null = null;
async function dominionToken(fresh = false): Promise<string> {
  if (!fresh && tokenMemo && tokenMemo.exp > Date.now() + 60000) return tokenMemo.token;
  const email = Deno.env.get("DOMINION_USERNAME"), pass = Deno.env.get("DOMINION_PASSWORD");
  if (!email || !pass) throw new Error("not_configured");
  const r = await fetch(BASE + "login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientAccessId: CLIENT, emailAddress: email.trim(), password: pass }) }).catch(() => null);
  const d: any = r ? await r.json().catch(() => ({})) : {};
  if (d && d.sessionToken) { tokenMemo = { token: d.sessionToken, exp: Date.now() + 20 * 60000 }; return d.sessionToken; }
  throw new Error("login_failed" + (r ? " (" + r.status + ")" : ""));
}
async function lp(path: string, body: unknown, retry = true): Promise<any> {
  const tok = await dominionToken();
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok }, body: JSON.stringify(body) });
  if ((r.status === 401 || r.status === 403) && retry) { tokenMemo = null; await dominionToken(true); return lp(path, body, false); }
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  if (!r.ok || !j) throw new Error("dominion_http_" + r.status + ":" + t.slice(0, 120));
  return j;
}

const E = (t: string, v: string) => ({ type: "enum", enumTypeId: t, variantId: v });
const N = (v: number) => ({ type: "number", value: v });
const STR = (v: string) => ({ type: "string", value: v });
const YN = (b: boolean) => E("yes-no", b ? "yes" : "no");

function parseAddress(addr: string) {
  const a = String(addr || "").replace(/,?\s*USA$/i, "");
  const parts = a.split(",").map((x) => x.trim()).filter(Boolean);
  const zip = (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(a) || [])[1] || "";
  return { street: parts[0] || a, city: parts.length >= 3 ? parts[parts.length - 2] : (parts[1] || ""), zip };
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export async function checkDominion(s: S, stateFromAddress: (a: string | null) => string | null): Promise<any> {
  const L = "Dominion";
  const no = (reason: string, extra: Record<string, unknown> = {}) => ({ lender: L, eligible: false, source: "live", reason, ...extra });
  if (s.loanType !== "DSCR") return no("Dominion is only set up for DSCR rentals in this pricer.");
  if (s.rentalType === "str") return no("Short-term-rental pricing on Dominion isn't set up in this pricer yet.");
  if (!Deno.env.get("DOMINION_USERNAME") || !Deno.env.get("DOMINION_PASSWORD")) return no("Dominion isn't connected yet (sign-in secrets not added).", { unavailable: true });
  const ptMap: Record<string, string> = { "SFR": "single-family", "Condo": "condominium", "2-4 Unit": "two-to-four-family", "Duplex": "two-to-four-family", "Mixed-Use": "mixed-use", "Multifamily 5+": "multi-family" };
  const pt = ptMap[String(s.propertyType)];
  if (!pt) return no("Dominion's DSCR programs here cover single-family, condo, 2-4 unit, mixed-use and 5+ unit properties.");
  const citMap: Record<string, string> = { "US Citizen": "us-citizen", "Permanent Resident": "permanent-resident-alien", "Non-Permanent Resident": "non-permanent-resident-alien", "Foreign National": "foreign-national", "ITIN": "itin" };
  const cit = citMap[String(s.citizenshipStatus || "US Citizen")] || "us-citizen";
  const fico = Number(s.creditScore) || 0;
  if (!fico && cit !== "foreign-national") return no("Needs a credit score.");
  if (!s.rentEstimate) return no("Needs the monthly rent to size a DSCR loan.");
  const refi = s.transactionType === "cashout" || s.transactionType === "ratetermrefi";
  const value = refi ? Number(s.currentValue || s.purchasePrice) : Math.min(Number(s.purchasePrice) || Infinity, Number(s.currentValue) || Infinity);
  if (!value || !isFinite(value)) return no(refi ? "Needs the current value." : "Needs the purchase price.");
  const addr = String(s.propertyAddress || "");
  const st = (s.propertyState || stateFromAddress(addr) || "").toUpperCase();
  if (!st) return no("Needs the property state.");
  const pa = parseAddress(addr);
  let loan = Number(s.loanAmount) || 0; const assumedLoan = !loan; if (!loan) loan = Math.round(value * 0.75);
  const units = Math.max(1, Number(s.numUnits) || (pt === "single-family" || pt === "condominium" ? 1 : pt === "multi-family" ? 5 : 2));
  const pp: Record<string, string> = { "5yr": "5-year", "4yr": "4-year", "3yr": "3-year", "2yr": "2-year", "1yr": "1-year", "none": "no-prepay" };
  const prepay = pp[String(s.prepayTerm || "5yr")] || "5-year";
  const structure = prepay === "1-year" ? "fixed-1" : prepay === "2-year" ? "fixed-2" : "step-down";
  const entMap: Record<string, string> = { "LLC": "llc", "Corporation": "corporation", "Trust": "trust" };
  const fields: any[] = [
    ["field@loan-status", E("loan-status", "initial-loan-quote")], ["field@citizenship-type", E("citizenship-type", cit)],
    ["field@decision-credit-score", N(fico || 700)], ["field@months-of-reserves", N(12)], ["field@nested-entity", YN(false)],
    ["field@state", STR(st)], ["field@zip-code", STR(pa.zip)], ["field@city", STR(pa.city)], ["field@street-address", STR(pa.street)],
    ["field@property-type", E("property-type", pt)], ["field@number-of-units", N(units)], ["field@number-of-leased-units", N(units)],
    ["field@vacant", YN(false)], ["field@is-the-property-legal-nonconforming", YN(false)], ["field@short-term-rental", YN(false)], ["field@m2-m-lease", YN(false)],
    ["field@property-acreage-number", N(0.2)], ["field@declining-markets", YN(String(s.decliningMarket) === "yes")],
    ["field@monthly-market-rent", N(Number(s.rentEstimate))], ["field@monthly-taxes", N(Number(s.monthlyTaxes) || 0)], ["field@monthly-insurance", N(Number(s.monthlyInsurance) || 0)],
    ["field@monthly-hoa", N(Number(s.monthlyHoa) || 0)],
    ["field@loan-purpose", E("loan-purpose", refi ? "refinance" : "purchase")], ["field@appraised-value", N(value)], ["field@purchase-price", N(refi ? (Number(s.purchasePrice) || value) : value)],
    ["field@base-loan-amount", N(loan)], ["field@prepayment-penalty-term", E("prepayment-penalty-term", prepay)], ["field@prepayment-penalty-structure", E("prepayment-penalty-structure", structure)],
    ["field@interest-only", E("interest-only-period", "no")], ["field@first-time-investor", YN(Number(s.experienceDeals) === 0)], ["field@property-square-footage", N(1500)],
    ["field@credit-event", YN(String(s.creditEvent) === "yes")], ["field@mortgage-late-payments", YN(false)],
  ].map(([fieldId, value]) => ({ fieldId, value }));
  if (entMap[String(s.entityType)]) fields.push({ fieldId: "field@entity-type", value: E("entity-type", entMap[String(s.entityType)]) });
  if (refi) {
    fields.push({ fieldId: "field@refinance-type", value: E("refinance-type", s.transactionType === "cashout" ? "cash-out" : "no-cash-out") });
    const bal = Number(s.currentLoanBalance) || 0;
    fields.push({ fieldId: "field@payoff-amount", value: N(bal) }, { fieldId: "field@estimated-cash-out-amount", value: N(s.transactionType === "cashout" ? Math.max(0, loan - bal) : 0) });
  }
  const now = new Date().toISOString();
  const wantIds = ["calc@adjusted-price", "calc@final-interest-rate", "calc@final-dscr", "calc@adjusted-rate-lock-period", "calc@pi-payment", "calc@loan-to-value"];
  let summary: any;
  try {
    summary = await lp("execute-summary", { currentTime: now, pricingProfileId: PROFILE_ID, creditApplicationFields: fields, ausFields: [],
      outputFieldsFilter: { type: "only", fieldIds: ["calc@final-dscr", "calc@loan-to-value"] }, publishedVersionRequest: { type: "current" }, pipelineRecordId: null, engine: null, bypassWorstCase: false });
  } catch (e) {
    const m = String((e as Error).message || e);
    return no("Dominion's pricing is unavailable right now (" + m.slice(0, 80) + ").", { unavailable: true });
  }
  const avail = (summary.products || []).filter((p: any) => p.status === "available");
  if (!avail.length) return no("No Dominion DSCR program fits this scenario (credit, leverage, DSCR, loan size or property).");

  const g = (sc: any, id: string) => { const f = (sc.calculatedFields || []).find((x: any) => x.fieldId === id); return f && f.value ? (f.value.value ?? f.value.count) : null; };
  const perProduct = await Promise.all(avail.map(async (p: any) => {
    try {
      const j = await lp("execute-product", { currentTime: now, pricingProfileId: PROFILE_ID, productId: p.productId, creditApplicationFields: fields, ausFields: [],
        outputFieldsFilter: { type: "only", fieldIds: wantIds }, publishedVersionRequest: { type: "current" }, pipelineRecordId: null, engine: null, bypassWorstCase: false });
      const rows = (j.priceScenarios || []).filter((sc: any) => String(g(sc, "calc@adjusted-rate-lock-period")) === "30")
        .map((sc: any) => ({ rate: Number(g(sc, "calc@final-interest-rate")), price: Number(g(sc, "calc@adjusted-price")), dscr: Number(g(sc, "calc@final-dscr")), ltv: Number(g(sc, "calc@loan-to-value")) }))
        .filter((r: any) => isFinite(r.rate) && isFinite(r.price)).sort((a: any, b: any) => a.rate - b.rate);
      return { name: String(p.productName).replace(/\s*30 Y(ea)?r\.? Fixed/i, "").replace(/^Product\s+/i, "Program "), rows, eff: j.rateSheetEffectiveTimestamp };
    } catch (_) { return { name: String(p.productName), rows: [], eff: null }; }
  }));
  const ranked = perProduct.filter((p: any) => p.rows.length).map((p: any) => { const par = p.rows.findIndex((r: any) => r.price >= 100); return { ...p, parIdx: par, parRate: par >= 0 ? p.rows[par].rate : 99 }; })
    .sort((a: any, b: any) => a.parRate - b.parRate).slice(0, 4);
  if (!ranked.length) return no("Dominion's programs fit but returned no prices for this scenario.");
  const options: any[] = [];
  let maxYsp = 0;
  for (const p of ranked) {
    const start = Math.max(0, (p.parIdx < 0 ? p.rows.length - 1 : p.parIdx) - 3);
    for (const r of p.rows.slice(start, start + 6)) {
      if (r.price > 100) maxYsp = Math.max(maxYsp, r.price - 100);
      options.push({ program: "30-yr fixed · " + Math.round(loan / value * 100) + "% LTV · " + prepay.replace("-year", "-yr") + " prepay · " + p.name, rate: r.rate, price: round3(r.price), dscr: isFinite(r.dscr) ? Math.round(r.dscr * 100) / 100 : null, note: p.name });
    }
  }
  const eff = ranked.map((p: any) => p.eff).filter(Boolean)[0];
  const assumptions = [
    "Dominion live pricing (their broker portal, rate sheet " + (eff ? new Date(eff).toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "current") + "), 30-day lock, 30-yr fixed, " + prepay.replace("-year", "-yr") + " prepay. Shown: the " + ranked.length + " programs with the lowest par rate.",
    "Assumed: 12 months of reserves, clean credit history, not vacant, ~1,500 sq ft, no nonconforming use. Prices above 100 are broker rebate (yield spread); below 100 are points to buy the rate down.",
    "Dominion's cap on broker points/fee isn't confirmed here: check the 'Broker Points or Fee' limit on their loan-pricing screen before quoting extra points.",
  ];
  if (assumedLoan) assumptions.unshift("No loan amount entered, so 75% of value was priced.");
  return { lender: L, eligible: true, source: "live", options, loanAmountUsed: loan, maxLoanAmount: loan, assumptions, compCaps: { maxYsp: round3(maxYsp), yspRatePerPoint: 0.25 } };
}
