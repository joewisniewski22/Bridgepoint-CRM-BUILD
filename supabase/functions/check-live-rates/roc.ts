// Roc Capital -- live DSCR (single property rental) pricing (Joe 2026-10-16: "lets go live with Roc's pricer"). Roc is a white-label table funder: the loan
// closes in Bridgepoint's name and is assigned to Roc. Their portal (bplending.privatelenderportal.com) prices through a JSON API; we sign in with Joe's
// saved login (ROC_USERNAME / ROC_PASSWORD secrets, entered by Joe -- never typed by the assistant), call the same pricer the portal's Loan Pricer screen
// calls (pricer/ratesDictionaryScenarios), and return its rate ladder. Read-only: pricing creates nothing on Roc's side (verified 10/16/26).
//
// What Roc's pricer returns: one scenario per points of buy-down (0, 0.5, 1, 1.5, 2.5), each with a rate = swap rate + spread for the loan's LTV band.
// So the options are: 0 points = the highest rate (price 100), more points = lower rate (price 100 - points). Roc also lets a broker charge a higher
// "max rate" with a yield spread above that; HOW that pays out hasn't been confirmed with Roc, so only the par-and-below ladder is shown.
// Rules from Roc's own DSCR product manual and brochure (read 10/16/26, see INTERNAL_KB): 660+ FICO, $75k-$2M, entity borrowers, no rural, no VT/SD/ND,
// 1.05 minimum DSCR (rent / PITIA), leverage by FICO, 1-4 units, no short-term rentals priced here, Lee/Charlotte/Sarasota/Collier FL not accepted.
const BASE = "https://bplending.privatelenderportal.com";
const PORTAL_ID = "4978";
type S = any;

let tokenMemo: { token: string; exp: number } | null = null;
let userIdMemo: number | null = null;
async function rocToken(fresh = false): Promise<string> {
  if (!fresh && tokenMemo && tokenMemo.exp > Date.now() + 60000) return tokenMemo.token;
  const user = Deno.env.get("ROC_USERNAME"), pass = Deno.env.get("ROC_PASSWORD");
  if (!user || !pass) throw new Error("not_configured");
  const r = await fetch(BASE + "/api/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json", "x-portal-id": PORTAL_ID }, body: JSON.stringify({ grant_type: "password", username: user.trim(), password: pass }) }).catch(() => null);
  const d: any = r ? await r.json().catch(() => ({})) : {};
  if (d && d.access_token) { tokenMemo = { token: d.access_token, exp: Date.now() + Math.max(60, Math.min(Number(d.expires_in) || 600, 1800)) * 800 }; return d.access_token; }
  throw new Error("login_failed" + (r ? " (" + r.status + ")" : ""));
}
async function rocApi(path: string, body?: unknown, retry = true): Promise<any> {
  const tok = await rocToken();
  const r = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
  if ((r.status === 401 || r.status === 403) && retry) { tokenMemo = null; await rocToken(true); return rocApi(path, body, false); }
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  if (!r.ok || j === null) throw new Error("roc_http_" + r.status + ":" + t.slice(0, 160));
  return j;
}
async function rocUserId(): Promise<number> {
  if (userIdMemo) return userIdMemo;
  const j = await rocApi("/api/v1/user/getUserInfo");
  const id = j && j.data && j.data.userId;
  if (!id) throw new Error("no_user_id");
  userIdMemo = Number(id);
  return userIdMemo;
}

// County (Roc's pricer wants "Hillsborough County") from the US Census geocoder; some counties are excluded and Roc's own geo rules want it.
const countyMemo = new Map<string, string>();
async function countyOf(address: string): Promise<string> {
  const key = address.toLowerCase();
  if (countyMemo.has(key)) return countyMemo.get(key)!;
  let name = "";
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=" + encodeURIComponent(address) + "&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json", { signal: ctl.signal });
    clearTimeout(timer);
    const d: any = await res.json();
    const m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
    name = (m && m.geographies && m.geographies.Counties && m.geographies.Counties[0] && m.geographies.Counties[0].NAME) || "";
  } catch (_) { /* county is best-effort */ }
  countyMemo.set(key, name);
  return name;
}

function parseZip(addr: string): string { return (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(String(addr || "")) || [])[1] || ""; }
const round4 = (x: number) => Math.round(x * 10000) / 10000;
// Roc's leverage matrix (DSCR manual): FICO band -> max LTV for purchase / rate-term / cash-out. Foreign nationals 65/65/60.
function maxLtvFor(fico: number, purpose: string, fn: boolean): number {
  const i = purpose === "cashout" ? 2 : 0;
  if (fn) return [65, 65, 60][i];
  if (fico >= 700) return [80, 80, 75][i];
  if (fico >= 680) return [75, 75, 70][i];
  return [65, 65, 60][i];
}
function monthlyPI(loan: number, ratePct: number, years = 30): number {
  const r = ratePct / 100 / 12, n = years * 12;
  return loan * r / (1 - Math.pow(1 + r, -n));
}
// Roc prepay strings by our prepay term; the portal's own list for the state decides what is actually allowed.
const PREPAY: Record<string, string> = { "5yr": "5-4-3-2-1", "4yr": "4-3-2-1", "3yr": "3-2-1", "1yr": "1-0-0", "none": "0" };
const PREPAY_LABEL: Record<string, string> = { "5-4-3-2-1": "5-4-3-2-1", "4-3-2-1": "4-3-2-1", "3-2-1": "3-2-1", "1-0-0": "1-year 1%", "0": "no prepay" };
const BLOCKED_FL_COUNTIES = ["lee county", "charlotte county", "sarasota county", "collier county"];

const cache = new Map<string, { at: number; result: any }>();

export async function checkRoc(s: S, stateFromAddress: (a: string | null) => string | null): Promise<any> {
  const L = "Roc Capital";
  const no = (reason: string, extra: Record<string, unknown> = {}) => ({ lender: L, eligible: false, source: "live", reason, ...extra });
  if (s.loanType !== "DSCR") return no("Roc is only connected for DSCR rentals in this pricer so far.");
  if (!Deno.env.get("ROC_USERNAME") || !Deno.env.get("ROC_PASSWORD")) return no("Roc isn't connected yet (sign-in secrets not added).", { unavailable: true });
  if (s.rentalType === "str") return no("Short-term-rental pricing on Roc isn't set up in this pricer yet.");

  const addr = String(s.propertyAddress || "");
  const st = (s.propertyState || stateFromAddress(addr) || "").toUpperCase();
  if (!st) return no("Needs the property state.");
  if (["VT", "SD", "ND"].indexOf(st) !== -1) return no("Roc doesn't lend in " + st + ".");
  if (s.ruralStatus === "rural") return no("Roc doesn't allow rural properties on rental loans.");
  if (s.entityType === "Individual") return no("Roc lends only to LLCs and corporations.");
  const cit = String(s.citizenshipStatus || "US Citizen");
  if (cit === "ITIN" || cit === "Non-Permanent Resident") return no("Roc's rules for " + (cit === "ITIN" ? "ITIN borrowers" : "visa holders (non-permanent residents)") + " aren't verified here, so it isn't priced.");
  const fn = cit === "Foreign National";
  const fico = Number(s.creditScore) || 0;
  if (!fico && !fn) return no("Needs a credit score.");
  if (fico && fico < 660) return no("Roc needs a 660 minimum credit score.");
  if (!s.rentEstimate) return no("Needs the monthly rent to size a DSCR loan.");

  const ptMap: Record<string, string> = { "SFR": "Single Family", "Condo": "Condominium", "Duplex": "Duplex", "Townhome": "Townhome", "PUD": "Planned Unit Development" };
  let pt = ptMap[String(s.propertyType)];
  let units = 1;
  if (String(s.propertyType) === "2-4 Unit") { const n = Math.min(4, Math.max(2, Number(s.numUnits) || 2)); pt = n === 2 ? "Duplex" : n === 3 ? "Triplex" : "Quadruplex"; units = n; }
  else if (pt === "Duplex") units = 2;
  if (!pt) return no("Roc's rental loans cover single-family, condo, townhome, PUD and 2-4 unit properties only.");

  const purpose = s.transactionType === "cashout" ? "cashout" : s.transactionType === "ratetermrefi" ? "refi" : "purchase";
  const rocPurpose = purpose === "cashout" ? "Cash Out Refi" : purpose === "refi" ? "Rate Term Refi" : "Purchase";
  const value = purpose === "purchase" ? Math.min(Number(s.purchasePrice) || Infinity, Number(s.currentValue) || Infinity) : Number(s.currentValue || s.purchasePrice);
  if (!value || !isFinite(value)) return no(purpose === "purchase" ? "Needs the purchase price." : "Needs the current value.");
  const maxLtv = maxLtvFor(fico, purpose, fn);
  let loan = Number(s.loanAmount) || 0; const assumedLoan = !loan;
  if (!loan) loan = Math.floor(value * maxLtv / 100 / 500) * 500;
  let ltv = loan / value * 100;
  if (ltv > maxLtv + 0.001) return no("Over Roc's max of " + maxLtv + "% LTV for this credit and loan purpose (about " + fmtUSD(Math.floor(value * maxLtv / 100)) + ").", { maxLoanAmount: Math.floor(value * maxLtv / 100) });
  if (loan < 75000) return no("Roc's minimum rental loan is $75,000.");
  if (loan > 2000000) return no("Roc's maximum rental loan is $2,000,000.");
  if (loan < 100000 && ltv > 75.001) return no("Under $100,000, Roc caps leverage at 75% LTV.");
  const prepayWant = PREPAY[String(s.prepayTerm || "5yr")];
  if (!prepayWant) return no("Roc doesn't offer a " + String(s.prepayTerm) + " prepay (its options are 5-4-3-2-1, 4-3-2-1, 3-2-1, 1-year or none).");

  const county = await countyOf(addr);
  if (st === "FL" && BLOCKED_FL_COUNTIES.indexOf(county.toLowerCase()) !== -1) return no("Roc isn't accepting submissions in " + county + ", FL right now.");

  const monthlyTax = Number(s.monthlyTaxes) || 0, monthlyIns = Number(s.monthlyInsurance) || 0, monthlyHoa = Number(s.monthlyHoa) || 0;
  const cacheKey = JSON.stringify([st, county, parseZip(addr), pt, units, rocPurpose, value, Math.round(ltv * 100), fico, fn, prepayWant, s.rentEstimate, monthlyTax, monthlyIns, monthlyHoa]);
  const hit = cache.get(cacheKey);
  let rows: Array<{ points: number; rate: number }>; let band = ""; let swap = 0;
  if (hit && Date.now() - hit.at < 5 * 60000) ({ rows, band, swap } = hit.result);
  else {
    let userId: number;
    try { userId = await rocUserId(); } catch (e) { return no("Roc's pricing is unavailable right now (" + String((e as Error).message || e).slice(0, 80) + ").", { unavailable: true }); }
    const form = {
      paymentChoice: "sharePoints", chargeBorrower: "yieldSpreadPremiumRates", loanTerm: 30, propertyType: pt, asIsValue: value, monthlyRent: Number(s.rentEstimate),
      loanPurpose: rocPurpose, purchasePrice: Number(s.purchasePrice) || value, purchaseDate: null, capitalImprovements: "", creditScore: String(fico || 700),
      borrowerExp: expBand(s.experienceDeals), foreignNationalFlag: fn ? "Foreign National" : "US Citizen", rateType: "30 Yr FRM", oneTimeYieldSpreadPremium: 0,
      prePaymentPenalty: prepayWant, loanSubtype: "Single Property Rental", numberOfUnits: units, commercialUnits: "", residentialUnits: "", commercialArea: "", residentialArea: "",
      commercialIncome: "", residentialIncome: "", bankruptcyDate: null, foreclosureDate: null, state: st, propertyCounties: [county || ""], commercialUnitsCurrentOnRent: "",
      userId, currentBuydown: 0, buydownFee: 0, loanToValue: Math.round(ltv * 100) / 100, amortization: "fullyAmortizing", zipCode: parseZip(addr), hasSection8: false,
      isRuralFromOriginator: false, anyDebt: "", grossAnnualTaxes: Math.round(monthlyTax * 12), grossAnnualInsurance: Math.round(monthlyIns * 12), annualHoaDues: String(Math.round(monthlyHoa * 12)),
      generalAdministrative: 0, payroll: 0, marketing: 0, replacementReserves: "", totalAnnualUtilities: "", totalAnnualRepairsMaintenance: "", totalAnnualPropertyManagementFees: "",
      isBroker: null, buydownPoints: 0, underwritingProcessingFees: [],
    };
    try {
      // State rules for prepay: ask Roc what it allows here before pricing (Ohio, for example, only allows 1-year or none).
      const allowed: any[] = await rocApi("/api/v1/pricer/getPrepayOptions", form);
      if (Array.isArray(allowed) && allowed.length && !allowed.some((o: any) => o && o.value === prepayWant)) {
        return no("Roc doesn't allow a " + (PREPAY_LABEL[prepayWant] || prepayWant) + " prepay in " + st + " (it allows: " + allowed.map((o: any) => o.label).join("; ") + ").");
      }
      const res = await rocApi("/api/v1/pricer/ratesDictionaryScenarios", { sfrFormData: form, buydownRequestData: { loanSubtype: "Single Property Rental", asIsValue: value, propertyType: pt, propertyTypes: null, noOfUnits: units } });
      const scen = res && res.scenarios;
      if (!scen || !scen["0"]) return no("Roc returned no pricing for this scenario.");
      const first = scen["0"].ltvRates && scen["0"].ltvRates["30 Yr FRM"] && scen["0"].ltvRates["30 Yr FRM"].fullyAmortizing && scen["0"].ltvRates["30 Yr FRM"].fullyAmortizing.baseRates;
      if (!first) return no("Roc returned no 30-year fixed pricing for this scenario.");
      band = pickBand(Object.keys(first), ltv);
      if (!band) return no("Roc has no pricing band for " + Math.round(ltv * 10) / 10 + "% LTV.");
      rows = []; swap = 0;
      let err = "";
      for (const k of Object.keys(scen)) {
        const e = scen[k] && scen[k].ltvRates && scen[k].ltvRates["30 Yr FRM"] && scen[k].ltvRates["30 Yr FRM"].fullyAmortizing && scen[k].ltvRates["30 Yr FRM"].fullyAmortizing.baseRates && scen[k].ltvRates["30 Yr FRM"].fullyAmortizing.baseRates[band];
        if (!e) continue;
        if (e.errorMessage && e.errorMessage.length) { err = err || String(e.errorMessage[0]); continue; }
        if (e.spreadRate == null || e.swapRate == null) continue;
        swap = Number(e.swapRate);
        rows.push({ points: Number(k), rate: round4(Number(e.swapRate) + Number(e.spreadRate)) });
      }
      if (!rows.length) return no(err ? "Roc: " + err + "." : "Roc has no price for this scenario.");
      rows.sort((a, b) => a.points - b.points);
      cache.set(cacheKey, { at: Date.now(), result: { rows, band, swap } });
    } catch (e) {
      return no("Roc's pricing is unavailable right now (" + String((e as Error).message || e).slice(0, 90) + ").", { unavailable: true });
    }
  }

  const pitiaExtra = monthlyTax + monthlyIns + monthlyHoa;
  const options = rows.map((r) => {
    const dscr = (Number(s.rentEstimate)) / (monthlyPI(loan, r.rate) + pitiaExtra);
    return { program: "30-yr fixed · " + Math.round(ltv) + "% LTV · " + (PREPAY_LABEL[prepayWant] || prepayWant) + " prepay · Roc", rate: r.rate, price: round4(100 - r.points), dscr: Math.round(dscr * 100) / 100, note: r.points ? (r.points + " pt buy-down") : "par" };
  }).filter((o) => o.dscr >= 1.05);
  if (!options.length) {
    const best = rows[0] ? (Number(s.rentEstimate)) / (monthlyPI(loan, rows[rows.length - 1].rate, 30) + pitiaExtra) : 0;
    return no("DSCR is under Roc's 1.05 minimum at every available rate (about " + (Math.round(best * 100) / 100) + " at the lowest-payment rate). Rent needs to cover the payment, taxes and insurance 1.05x.", { maxLoanAmount: Math.floor(value * maxLtv / 100) });
  }
  const assumptions = [
    "Roc live pricing (their broker portal), 30-year fixed fully amortizing, " + (PREPAY_LABEL[prepayWant] || prepayWant) + " prepay, " + Math.round(ltv * 10) / 10 + "% LTV (band " + band + "), swap rate " + swap + "%. Price shown is 100 minus the points paid to buy the rate down; 100 is Roc's par rate.",
    "Roc also allows pricing above par with a yield spread, but how that pays Bridgepoint is NOT confirmed yet, so it isn't shown. Roc's own underwriting fee is $995; our processing/admin fees are separate.",
    "Assumed: " + (fn ? "foreign national" : "US citizen or green-card holder") + ", LLC/corporation borrower, long-term rental with a lease in place" + (s.propertyType === "Condo" ? ", warrantable condo" : "") + ", clean credit history, 12-month lease. Roc's other rules apply at underwriting (reserves, appraisal, ARR within 10%).",
  ];
  if (assumedLoan) assumptions.unshift("No loan amount entered, so " + Math.round(ltv * 10) / 10 + "% of value was priced.");
  return { lender: L, eligible: true, source: "live", options, loanAmountUsed: loan, maxLoanAmount: Math.floor(value * maxLtv / 100), fees: { lenderFee: 995 }, assumptions };
}

function expBand(n: unknown): string {
  const x = Number(n) || 0;
  return x >= 50 ? "50+" : x >= 10 ? "10-49" : x >= 5 ? "5-9" : x >= 3 ? "3-4" : x >= 1 ? "1-2" : "0";
}
// "76-80" -> contains 78.4? Bands overlap at their edges ("50-55", "55-60"); pick the lowest band whose upper bound covers the LTV.
function pickBand(keys: string[], ltv: number): string {
  const parsed = keys.map((k) => { const m = /^(\d+)-(\d+)$/.exec(k); return m ? { k, lo: +m[1], hi: +m[2] } : null; }).filter(Boolean) as Array<{ k: string; lo: number; hi: number }>;
  parsed.sort((a, b) => a.hi - b.hi);
  const x = Math.ceil(ltv - 1e-9);
  const hit = parsed.filter((p) => x >= p.lo && x <= p.hi)[0] || parsed.filter((p) => ltv <= p.hi)[0];
  return hit ? hit.k : "";
}
function fmtUSD(n: number): string { return "$" + Math.round(n).toLocaleString("en-US"); }
