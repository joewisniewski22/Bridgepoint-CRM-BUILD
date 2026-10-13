// HomeXpress Mortgage (HomeXmortgage, X-Connect) -- InvestorX 1-4 unit DSCR, 30-yr fixed and 40-yr interest-only.
// Joe 10/13/26: "add Home Express ... I want it in the pricer accurately."
//
// X-Connect prices through LenderPrice behind a broker login with an emailed code every 14 days, so this can't be
// called from the server. This is a researched MODEL of HomeXpress's own engine, measured 10/13/26 by replaying
// ~900 scenarios through it from Joe's signed-in session: base price ladder (per rate, 30-day lock), every
// loan-level adjustment (credit x LTV, DSCR, loan size, prepay, purpose, property, borrower), the max-price cap, the
// 96 price floor, the state rules and the eligibility limits (from the engine's own disqualification messages and the
// InvestorX program description v09.11.26.1). A refresh in Joe's signed-in browser re-measures the base ladder and
// writes it to lender_pricing_snapshots (lender='homex'); the adjustment tables only change when HomeXpress changes
// guidelines. Price = 100 - base - sum(adjustments); a positive adjustment is a cost in points.

type S = {
  loanType: string; transactionType: string; propertyAddress: string; propertyState: string; propertyType: string;
  creditScore: number | null; purchasePrice: number | null; currentValue: number | null; loanAmount: number | null;
  entityType: string | null; citizenshipStatus: string | null; rentEstimate?: number | null;
  monthlyTaxes?: number | null; monthlyInsurance?: number | null; monthlyHoa?: number | null; prepayTerm: string | null;
  ruralStatus: string | null; rentalType?: string | null; numUnits?: number | null;
};
type Opt = { program: string; rate: number; price: number; dscr?: number | null; note?: string };

export const HX_SNAPSHOT = "HomeXpress engine, rate sheet 10/13/26 7:00 AM, measured 10/13/26";
export const HX_SNAPSHOT_DATE = "2026-10-13T20:00:00Z";
// Base points by note rate (30-day lock). Identical for the 30-yr fixed and the 40-yr IO product.
export const HX_BASE: Record<string, number> = {
  "7.125": 2.187, "7.25": 1.687, "7.375": 1.262, "7.5": 0.837, "7.625": 0.462, "7.75": 0.087, "7.875": -0.163, "7.99": -0.413,
  "8.125": -0.663, "8.25": -0.913, "8.375": -1.163, "8.5": -1.413, "8.625": -1.538, "8.75": -1.663, "8.875": -1.788, "8.99": -1.913,
  "9.125": -2.038, "9.25": -2.163, "9.375": -2.288, "9.5": -2.413, "9.625": -2.538, "9.75": -2.663, "9.875": -2.788, "9.99": -2.913,
};
// LTV columns: <=50, 55, 60, 65, 70, 75, 80.  null = not offered.
const COLS = 7;
const FICO_LTV: Record<string, Array<number | null>> = {
  "620": [2.875, 3.125, 3.625, 4, 4.75, null, null],
  "640": [1.5, 1.5, 2.125, 2.875, 3.25, null, null],
  "660": [-1.625, -1.375, -1.25, -0.75, -0.125, 1, null],
  "680": [-1.875, -1.625, -1.5, -1.125, -0.875, 0.375, null],
  "700": [-2, -1.875, -1.75, -1.625, -1.375, -0.75, 0.375],
  "720": [-2.125, -2, -1.875, -1.75, -1.5, -1.25, -0.375],
  "740": [-2.125, -2.125, -2, -1.875, -1.625, -1.375, -0.75],
  "760": [-2.25, -2.25, -2.125, -2, -1.75, -1.5, -1],
};
const DSCR_LT1: Array<number | null> = [1, 1, 1.25, 1.75, 2, 2.25, null];
const DSCR_LT075: Array<number | null> = [3, 3, 3.25, 4.125, 4.625, null, null];
const PREPAY: Record<string, number[]> = {
  none: [1, 1, 1, 1, 1.25, 1.25, 1.25], y1: [0.75, 0.75, 0.75, 0.75, 0.875, 0.875, 0.875], y2: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  y3: [0, 0, 0, 0, 0, 0, 0], y4: [-0.25, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25], y5: [-0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5],
  y5t: [0, 0, 0, 0, 0, 0, 0],
};
const PURPOSE: Record<string, number[]> = { purchase: [0, 0, 0, 0, 0, 0, 0], rt: [0, 0, 0, 0, 0.25, 0.25, 0.25], co: [0.25, 0.25, 0.25, 0.25, 0.5, 1, 1.25] };
const PROP: Record<string, Array<number | null>> = {
  sfr: [0, 0, 0, 0, 0, 0, 0], condo: [0, 0, 0, 0, 0, 0, 0], "2-4": [0, 0, 0.25, 0.25, 0.5, 0.5, 0.5],
  condotel: [1, 1, 1.25, 1.25, 1.375, 1.5, null], highrise: [0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 1],
};
const RURAL: Array<number | null> = [1, 1, 1, 1, 1, 1, null];
const STR: Array<number | null> = [0.5, 0.5, 0.75, 0.75, 1.125, 1.25, null];
const FN = [1, 1, 1, 1, 1.25, 1.25, 1.25];
const NPRA = [1, 1, 1, 1, 1, 1, 1];
const IO_ADJ = [0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.75]; // interest-only with DSCR >= 1.00 (IO with DSCR < 1.00 is not offered)

const NO_STATES = ["NY", "SD", "VT"]; // not on HomeXpress's available-states list
const RESTRICTED_STATES = ["AK", "IL", "KS", "MI", "NJ", "NM", "OH", "PA", "RI"]; // no yield spread on no-prepay / 1-yr prepay
const NO_PREPAY_STATES = ["AK", "NM", "KS"];
const PRICE_FLOOR = 96;

function colOf(ltv: number): number { const x = ltv - 1e-9; return x <= 50 ? 0 : x <= 55 ? 1 : x <= 60 ? 2 : x <= 65 ? 3 : x <= 70 ? 4 : x <= 75 ? 5 : 6; }
function ficoBand(f: number): string { return f >= 760 ? "760" : f >= 740 ? "740" : f >= 720 ? "720" : f >= 700 ? "700" : f >= 680 ? "680" : f >= 660 ? "660" : f >= 640 ? "640" : "620"; }
function loanSizeAdj(loan: number, col: number): number { return loan < 150000 ? (col <= 1 ? 1 : 1.25) : loan < 200000 ? 0.25 : loan < 300000 ? 0 : loan <= 700000 ? -0.25 : 0; }
function monthlyPI(loan: number, rate: number, io: boolean): number { const r = rate / 100 / 12; return io ? loan * r : loan * r / (1 - Math.pow(1 + r, -360)); }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

let snapCache: { at: number; base: Record<string, number>; captured: string | null } | null = null;
async function hxSnapshot() {
  if (snapCache && Date.now() - snapCache.at < 600000) return snapCache;
  let row: any = null;
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && key) {
    const r = await fetch(url + "/rest/v1/lender_pricing_snapshots?lender=eq.homex&select=data,sheet_as_of,captured_at", { headers: { apikey: key, Authorization: "Bearer " + key } }).catch(() => null);
    if (r && r.ok) { const rows = await r.json().catch(() => []); row = rows && rows[0]; }
  }
  snapCache = { at: Date.now(), base: (row && row.data && row.data.B) || HX_BASE, captured: row ? row.captured_at : HX_SNAPSHOT_DATE };
  return snapCache;
}
function businessDaysOld(captured: string | null): number | null {
  if (!captured) return null;
  const et = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const a = et(new Date(captured)), b = et(new Date());
  a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
  let n = 0;
  for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

type In = { fico: number; ltv: number; dscr: number; loan: number; ppp: string; purpose: string; pt: string; cit: string; rural: boolean; str: boolean; io: boolean; units12: boolean; st: string };
// Returns total adjustment in points (positive = cost), or a reason string when the combination isn't offered.
export function hxAdjust(i: In): number | string {
  const col = colOf(i.ltv);
  // Foreign nationals take no credit-by-LTV adjustment in the engine (only the FN adjustment below); everyone else does.
  const f = i.cit === "fn" ? 0 : FICO_LTV[ficoBand(i.fico)][col];
  if (f == null) return "no HomeXpress price at " + Math.round(i.ltv) + "% LTV with this credit score";
  let a = f;
  if (i.dscr >= 1.25) a += -0.25; else if (i.dscr >= 1) a += 0;
  else if (i.dscr >= 0.75) { const d = DSCR_LT1[col]; if (d == null) return "DSCR under 1.00 maxes out at 75% LTV"; a += d; }
  else { const d = DSCR_LT075[col]; if (d == null) return "DSCR under 0.75 maxes out at 70% LTV"; a += d; }
  a += loanSizeAdj(i.loan, col);
  a += PREPAY[i.ppp][col];
  a += PURPOSE[i.purpose][col];
  const p = PROP[i.pt][col]; if (p == null) return "no price for this property type at " + Math.round(i.ltv) + "% LTV"; a += p;
  if (i.rural) { const r = RURAL[col]; if (r == null) return "rural maxes out at 75% LTV"; a += r; }
  if (i.str) { const r = STR[col]; if (r == null) return "short-term rentals max out at 75% LTV"; a += r; }
  if (i.cit === "fn") a += FN[col]; else if (i.cit === "npra") a += NPRA[col];
  if (i.io) { if (i.dscr < 1) return "interest-only needs DSCR of 1.00 or better"; a += IO_ADJ[col]; }
  return a;
}
// Highest LTV HomeXpress will do on this deal (from the engine's own disqualification messages, measured 10/13/26).
export function hxMaxLtv(i: { fico: number; dscr: number; loan: number; purpose: string; pt: string; cit: string; rural: boolean; str: boolean; st: string }): number {
  const refi = i.purpose !== "purchase";
  let m = i.purpose === "co" ? (i.fico < 680 ? 70 : i.fico < 720 ? 75 : 80) : (i.fico < 680 ? 70 : i.fico < 700 ? 75 : 80);
  if (i.loan > 2000000) m = Math.min(m, i.fico < 680 && !refi ? 65 : 70);
  else if (i.loan > 1500000) m = Math.min(m, refi ? 70 : i.fico < 680 ? 65 : 75);
  if (i.dscr < 0.75) {
    // "No DSCR" (under 0.75) has its own credit-based LTV limits (measured 10/13/26; same for purchase and rate/term, cash-out is tighter at 660).
    const nd = i.fico < 640 ? 0 : i.fico < 660 ? 55 : i.fico < 680 ? (i.purpose === "co" ? 55 : 60) : i.fico < 700 ? (i.purpose === "co" ? 60 : 60) : i.fico < 720 ? 65 : 70;
    m = Math.min(m, nd);
  } else if (i.dscr < 1) m = Math.min(m, 75);
  if (i.rural) m = Math.min(m, refi ? 70 : 75);
  if (i.str) m = Math.min(m, 75);
  if (i.cit === "fn") m = Math.min(m, refi ? 70 : 75);
  else if (i.cit === "npra") m = Math.min(m, refi ? 75 : 80);
  if (i.pt === "condotel") m = Math.min(m, i.purpose === "co" ? 65 : 75);
  if (i.pt === "highrise" && i.st === "FL") m = Math.min(m, 75);
  return m;
}

export async function checkHomeXpress(s: S, stateFromAddress: (a: string | null) => string | null): Promise<any> {
  const L = "HomeXpress";
  const no = (reason: string) => ({ lender: L, eligible: false, source: "model", reason });
  if (s.loanType !== "DSCR") return no("HomeXpress is only set up for DSCR rentals in this pricer.");
  const rawType = s.propertyType;
  const pt = rawType === "SFR" ? "sfr" : rawType === "Condo" ? "condo" : (rawType === "2-4 Unit" || rawType === "Duplex") ? "2-4" : null;
  if (!pt) return no("HomeXpress's InvestorX DSCR program takes 1-4 unit single-family, condo and 2-4 unit properties (no mixed-use, 5+ units or commercial).");
  const cit = s.citizenshipStatus === "Foreign National" ? "fn" : s.citizenshipStatus === "Non-Permanent Resident" ? "npra" : s.citizenshipStatus === "ITIN" ? "itin" : "us";
  if (cit === "itin") return no("HomeXpress's ITIN lending is on a different (non-DSCR) program, so it isn't priced here.");
  const fico = s.creditScore || 0;
  if (!fico) return no("Needs a credit score (HomeXpress foreign nationals with no U.S. score aren't priced here).");
  if (fico < 620) return no("HomeXpress needs at least a 620 credit score.");
  const purpose = s.transactionType === "cashout" ? "co" : s.transactionType === "ratetermrefi" ? "rt" : "purchase";
  const refi = purpose !== "purchase";
  const value = refi ? (s.currentValue || s.purchasePrice) : Math.min(s.purchasePrice || Infinity, s.currentValue || Infinity);
  if (!value || !isFinite(value)) return no(refi ? "Needs the current value." : "Needs the purchase price.");
  if (!s.rentEstimate) return no("Needs the monthly rent to size a HomeXpress DSCR loan.");
  const st = (s.propertyState || stateFromAddress(s.propertyAddress) || "").toUpperCase();
  if (st && NO_STATES.includes(st)) return no("HomeXpress doesn't lend in " + st + ".");
  const zip = (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(s.propertyAddress || "") || [])[1] || "";
  if (st === "PA" && /^191/.test(zip)) return no("HomeXpress doesn't lend in the City of Philadelphia.");
  if (st === "MD" && /\bBaltimore\b/i.test(s.propertyAddress || "") && !/county/i.test(s.propertyAddress || "")) return no("HomeXpress doesn't lend in Baltimore City.");
  const units = pt === "2-4" ? Math.min(4, Math.max(2, Number(s.numUnits) || 2)) : 1;
  const units12 = units <= 2;
  const isStr = s.rentalType === "str";
  const rural = s.ruralStatus === "rural";
  const asked = s.prepayTerm || "5yr";
  const escrow = (s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0);
  const rentForDscr = (s.rentEstimate || 0) * (isStr ? 0.8 : 1); // STR income is reduced 20% to cover operating costs (guideline)
  const snap = await hxSnapshot();
  const rates = Object.keys(snap.base).map(Number).sort((a, b) => a - b);

  // prepay HomeXpress will actually allow here (engine messages, 10/13/26)
  const pppFor = (loan: number): { key: string; note?: string } => {
    let k = asked === "5yr" ? "y5" : asked === "3yr" ? "y3" : asked === "2yr" ? "y2" : asked === "1yr" ? "y1" : "none";
    let note: string | undefined;
    const force = (why: string) => { if (k !== "none") note = "HomeXpress doesn't allow a prepay penalty here (" + why + ") -- priced with no prepay."; k = "none"; };
    if (NO_PREPAY_STATES.includes(st)) force(st);
    else if (st === "OH" && units12 && loan < 116356) force("OH 1-2 units under $116,356");
    else if (st === "PA" && units12 && loan < 329412) force("PA 1-2 units under $329,412");
    else if (st === "RI" && purpose === "purchase") force("RI purchase");
    else if ((st === "DC" || st === "MD") && (k === "y5")) { k = "y3"; note = "HomeXpress caps the prepay at 3 years in " + st + " -- priced that way."; }
    else if (st === "MS" && k === "y5") { k = "y5t"; note = "HomeXpress doesn't allow a flat prepay in MS -- priced as a tiered 5-year."; }
    return { key: k, note };
  };
  const capOf = (k: string): number => { // max price the broker can be paid up to (engine "Max Comp. Maximum Price")
    if (k === "none") return RESTRICTED_STATES.includes(st) ? 100 : 100.125;
    if (k === "y1") return RESTRICTED_STATES.includes(st) ? 100 : 101.125;
    return 102.75;
  };

  if (s.loanAmount && s.loanAmount / value * 100 > 80 + 1e-9) return no("HomeXpress maxes out at 80% LTV (the loan is " + Math.round(s.loanAmount / value * 1000) / 10 + "% of value).");
  if (cit === "fn" && s.entityType === "Individual") return no("HomeXpress foreign nationals must close in an entity with a domestic agent.");
  const isEntity = s.entityType !== "Individual";
  const tiers = s.loanAmount ? [s.loanAmount / value * 100] : [80, 75, 70, 65, 60, 55, 50];
  let firstReason = "";
  for (const ltv of tiers) {
    const loan = s.loanAmount || Math.floor(value * ltv / 100 / 500) * 500;
    if (loan < 100000) { firstReason = firstReason || "HomeXpress's minimum loan is $100,000."; continue; }
    if (loan > 2500000) { firstReason = firstReason || "HomeXpress's maximum loan is $2,500,000."; continue; }
    const pp = pppFor(loan);
    const build = (io: boolean): Opt[] | string => {
      const rows: Array<{ rate: number; price: number; dscr: number; raw: number; adj: number }> = [];
      let why = "";
      for (const r of rates) {
        const dscr = rentForDscr / (monthlyPI(loan, r, io) + escrow);
        const bucketDscr = dscr;
        if (dscr < 0.75 && loan < 200000) { why = why || "DSCR under 0.75 needs a $200,000 minimum loan"; continue; }
        if (dscr < 1 && fico < 640 && cit !== "fn") { why = why || "DSCR under 1.00 needs a 640 credit score"; continue; }
        if (rural && dscr < 0.75) { why = why || "rural properties need a DSCR of 0.75 or better"; continue; }
        if (dscr < 0.75 && loan > 2000000) { why = why || "DSCR under 0.75 maxes out at $2,000,000"; continue; }
        const maxLtv = hxMaxLtv({ fico, dscr: bucketDscr, loan, purpose, pt, cit, rural, str: isStr, st });
        if (ltv > maxLtv + 1e-9) { why = why || "HomeXpress maxes this deal out at " + maxLtv + "% LTV (credit, DSCR, loan size or property)"; continue; }
        const adj = hxAdjust({ fico, ltv, dscr: bucketDscr, loan, ppp: pp.key, purpose, pt, cit, rural, str: isStr, io, units12, st });
        if (typeof adj === "string") { why = why || adj; continue; }
        const price = round3(100 - snap.base[String(r)] - adj);
        if (price < PRICE_FLOOR - 1e-9 || price > capOf(pp.key) + 1e-9) continue;
        rows.push({ rate: r, price, dscr: Math.round(dscr * 100) / 100, raw: dscr, adj });
      }
      if (!rows.length) return why || "no rate prices inside HomeXpress's price limits";
      const parIdx = rows.findIndex((x) => x.price >= 100);
      const start = Math.max(0, (parIdx < 0 ? rows.length - 1 : parIdx) - 3);
      return rows.slice(start).map((x) => ({ program: io ? "40-yr fixed IO (10-yr interest-only) · " + Math.round(ltv) + "% LTV" : "30-yr fixed · " + Math.round(ltv) + "% LTV", rate: x.rate, price: x.price, dscr: x.dscr, ...((s as any).debugAdj ? { dbg: { raw: x.raw, adj: x.adj } } : {}) }));
    };
    const fx = build(false);
    if (typeof fx === "string") { firstReason = firstReason || fx; continue; }
    const ioR = build(true);
    const options: Opt[] = fx.concat(typeof ioR === "string" ? [] : ioR);
    const ageDays = businessDaysOld(snap.captured);
    const cap = capOf(pp.key);
    const assumptions = [
      "HomeXpress model: measured from HomeXpress's own pricing engine on 10/13/26 (rate sheet 10/13/26 7:00 AM), 30-day lock, 30-yr fixed and 40-yr interest-only. Clean credit history assumed.",
      "Fees: HomeXpress Non-QM business underwriting $1,695, administration $149" + (isEntity ? ", entity review $595" : "") + (st === "TX" ? ", TX doc review $150" : "") + ". Broker compensation: up to 5.000% from the borrower (business purpose) and price above 100 up to " + cap.toFixed(3) + " (yield spread" + (cap <= 100 ? ": not allowed in " + st + " at this prepay" : "") + ").",
    ];
    if (pp.note) assumptions.unshift(pp.note);
    if (isStr) assumptions.push("Short-term rental: rent counted at 80% of gross (HomeXpress's 20% reduction), +STR adjustment, max 75% LTV.");
    if (cit === "fn") assumptions.push("Foreign national: must close in an entity with a domestic agent; max 75% purchase / 70% refinance; DSCR only.");
    const res: any = {
      lender: L, eligible: true, source: "model", options, loanAmountUsed: loan, maxLoanAmount: loan, assumptions,
      fees: { lenderFee: 1695 + 149 + (isEntity ? 595 : 0) + (st === "TX" ? 150 : 0) },
      compCaps: { maxBrokerPoints: 5, maxYsp: Math.max(0, round3(cap - 100)), yspRatePerPoint: 0.3 },
    };
    if (isStr) res.strPriced = true;
    if (ageDays == null || ageDays > 3) {
      res.rateTolerance = 0.125;
      res.staleWarning = "These HomeXpress rates are from " + (snap.captured ? new Date(snap.captured).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "an older rate sheet") + " and may have changed. Confirm before quoting.";
      res.staleFix = "HomeXpress reprices on its rate sheet; the refresh needs Joe signed in to X-Connect (it asks for an emailed code every 14 days).";
      assumptions.unshift(res.staleWarning);
    }
    return res;
  }
  return no(firstReason || "No HomeXpress DSCR tier fits (credit, leverage, DSCR, loan size or property).");
}
