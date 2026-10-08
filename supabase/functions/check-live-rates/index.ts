// Live multi-lender pricing check. Takes one canonical loan scenario (the
// shape produced by index.html's buildCanonicalScenario(lead)) and checks it
// against every lender registered below, in parallel, returning a normalized
// result per lender.
//
// "Add a lender" means: write one entry in LENDERS with a mapFields() and a
// parseResponse(), and register it in the array -- nothing else in this
// function, the frontend, or the calling code needs to change.
//
// Built 2026-09-30 per Joe's ask to check lenders live against their own
// public pricers rather than maintain a static rate table per lender (the
// Constructive Capital rate sheet is the one exception -- that one really is
// reimplemented statically in index.html, since Constructive is our own
// in-house paper and Joe hands us the sheet directly every time it changes).
import { RCN_GEO_DATE, RCN_KILLED, RCN_REDUCE, RCN_TARGET, RCN_TARGET_NAMES } from "./rcn_geo.ts";
import { checkVelocity, velocityGet, velocityPost } from "./velocity.ts";
import { checkLend } from "./lend.ts";
import { RCN_LTR_AREAS, RCN_LTR_ZIP, RCN_LTR_GEO_DATE } from "./rcn_ltr_geo.ts";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type Scenario = {
  loanType: string;              // "DSCR" | "Portfolio/Blanket" | "Fix & Flip" | "Bridge" | "Ground Up Construction"
  transactionType: string;       // "purchase" | "cashout" | "ratetermrefi"
  propertyAddress: string;
  propertyState: string;         // 2-letter, pre-computed by the frontend (stateFromAddress)
  propertyType: string;          // one of PROPERTY_TYPES in index.html
  creditScore: number | null;
  purchasePrice: number | null;
  currentValue: number | null;
  loanAmount: number | null;
  rehabBudget: number | null;
  arv: number | null;
  entityType: string | null;     // "LLC" | "Individual" | "Corporation"
  citizenshipStatus: string | null;
  experienceDeals: number | null;
  rentEstimate: number | null;
  monthlyTaxes: number | null;
  monthlyInsurance: number | null;
  monthlyHoa: number | null;
  pointsCharged: number | null;
  termMonths: number | null;
  prepayTerm: string | null;     // "5yr" | "3yr" | "2yr" | "1yr" | "none"
  guarantorFirstName: string | null;
  guarantorLastName: string | null;
  ruralStatus: string | null;
  liquidity: number | null;           // seasoned US bank funds -- only matters for Foreign National RTL
  countryOfDomicile: string | null;    // only matters for Foreign National RTL
  currentLoanBalance: number | null;   // existing lien payoff -- only matters on a refinance
  appraisalTransfer?: string | null;   // "yes" = borrower already has an appraisal to transfer (RCN/LEND refuse)
  rehabScope?: string | null;          // "cosmetic" | "structural" (gut, additions, conversions, fire/water)
};

type LenderResult = {
  lender: string;
  eligible: boolean;
  reason?: string;
  assumptions?: string[];
  // Set only when the lender's own pricer actually returns fee data (RCN
  // does; NextRes's public Quick Quote API doesn't expose any fee/closing-
  // cost fields at all -- checked directly against a real response).
  // undefined here means the term-sheet generator falls back to
  // Bridgepoint's own estimate table and labels it "Estimated", never
  // silently presenting a guess as the lender's real number.
  fees?: { lenderFee?: number; closingCosts?: number; points?: number };
  // loanAmount on an option = that option was priced at a different amount
  // than loanAmountUsed (Kiavi offers a rate per leverage tier, so a lower
  // loan buys a lower rate). Absent = priced at loanAmountUsed.
  // creditToBorrower: a price above 100 is a lender credit to the borrower
  // (A&D Borrower Paid), not yield spread to us. revenuePts: our fixed comp
  // on that option (A&D Lender Paid 2.75%), replacing points + YSP.
  options?: Array<{ program: string; rate: number; price: number; dscr?: number | null; loanAmount?: number; note?: string; creditToBorrower?: boolean; revenuePts?: number }>;
  // Lender's own cap on what the broker can earn, so the UI can steer extra
  // compensation into yield spread when points alone hit the cap.
  compCaps?: { maxBrokerPoints?: number; maxYsp?: number; yspRatePerPoint?: number };
  // "live" = the lender's own pricer answered; "model" = Bridgepoint's
  // researched copy of the lender's pricing (see Bridgepoint Pricing Research).
  source?: "live" | "model";
  // Set when the rate is only known to within +/- this much (Kiavi rental).
  rateTolerance?: number;
  staleWarning?: string;          // rates behind the lender's latest sheet -- shown as a banner
  staleFix?: string;              // how to fix it -- shown only to Joe/Fiore/Erika
  // Loan amount every option above was priced at. When the caller doesn't
  // supply a loan amount, this is the highest amount the lender will do on
  // this scenario (maxLoanAmount === loanAmountUsed); when they do supply
  // one, maxLoanAmount is still reported where it can be found.
  loanAmountUsed?: number;
  maxLoanAmount?: number;
  // Fix & flip / GUC: how much of the loan is the rehab/construction holdback
  // (drawn later). Day-one advance = loan amount - this. When a lender doesn't
  // report it, the UI assumes the full rehab budget is held back.
  rehabHoldback?: number;
  // True when the lender's pricer couldn't be reached at all (as opposed to
  // answering "not eligible"), so the UI shows it as unavailable.
  unavailable?: boolean;
};

function fmtMoney(n: number | null | undefined): string {
  return Math.round(n || 0).toLocaleString("en-US");
}

// ---------------------------------------------------------------------
// Constructive Capital -- our in-house wholesale paper. Not a live API
// check like the others; this is the same C3 Surge rate sheet logic
// already running in index.html (evaluateDscrPricing and friends),
// ported here so it shows up in the same comparison list. Whenever Joe
// hands over a new Constructive rate sheet, both copies need updating
// together -- there's no way around that without the two codebases
// sharing a module, which a single-file CRM + Deno edge function can't
// do cleanly.
// ---------------------------------------------------------------------
function stateFromAddress(address: string | null): string | null {
  if (!address) return null;
  // Google Places addresses end with ", USA" -- strip it so the state is the
  // last real component, or every state-based rule silently never applies.
  const trimmed = address.trim().replace(/,\s*(USA|US|United States)\s*$/i, "");
  const m = /,\s*([A-Za-z]{2})\s*\d{0,5}\s*$/.exec(trimmed);
  if (m) return m[1].toUpperCase();
  return null;
}
function pricingPropertyType(pt: string | null): string | null {
  return pt === "Duplex" ? "2-4 Unit" : pt;
}
const DSCR_BASE_PAR_RATE = 6.625;
const DSCR_MIN_NOTE_RATE = 6.875;
// Per DSCR Underwriting Guidelines v1-08 (7-1-26) "Additional State DSCR
// Restrictions": in these states min DSCR is 1.00 (680+ FICO) / 1.10 (<680) --
// a qualifying rule, NOT a rate add-on (the old +0.375 was wrong; not on the 9-29-26 sheet).
const DSCR_MIN_DSCR_STATES = ["AL","GA","KS","ME","MO","MS","NE","SD","WI","WY"];
// Max price by prepay (C3 Surge Rate Sheet 9-29-2026).
const DSCR_MAX_PRICE_BY_PPP: Record<string, number> = { "5yr": 102.125, "3yr": 101.0, "2yr": 100.375, "1yr": 100.375, "none": 100.0 };
// Minimum DSCR for a single-asset loan, per Constructive's V7 engine (DSCR_Loan
// Sizer H84, Expanded program): in the 10 "geography" states 1.10x under 680 FICO
// / 1.00x at 680+; otherwise 1.00x above 75% LTV, 0.75x at/below (sub-1.00 also
// needs 720+ FICO and $150k+ per the 7-1-26 matrix). Rural = 1.20x (matrix).
// (The rate sheet's "FICO <720 = 1.20x" line is the CROSS-COLLATERAL column.)
function constructiveMinDscr(fico: number, ltv: number, loan: number, state: string | null, rural: boolean): number {
  if (rural) return 1.2;
  if (state && DSCR_MIN_DSCR_STATES.includes(state)) return fico < 680 ? 1.1 : 1.0;
  if (ltv > 75) return 1.0;
  return fico >= 720 && loan >= 150000 ? 0.75 : 1.0;
}
// V7 "Expanded Geography" rate add: +0.375 only when the state is on the list AND FICO < 680.
const DSCR_GEO_ADJ_SUB680 = 0.375;
const DSCR_INELIGIBLE_STATES = ["ND","NV","SD"];
const DSCR_LTV_BANDS = [55, 60, 65, 70, 75, 80];
function dscrLtvCol(ltv: number): number {
  for (let i = 0; i < DSCR_LTV_BANDS.length; i++) { if (ltv <= DSCR_LTV_BANDS[i]) return i; }
  return -1;
}
const DSCR_FICO_ADJ: Array<{ min: number; adj: Array<number | null> }> = [
  { min:780, adj:[0,0,0,0,0.125,0.500] },
  { min:760, adj:[0,0,0.125,0.250,0.375,0.625] },
  { min:740, adj:[0,0.125,0.250,0.375,0.500,0.750] },
  { min:720, adj:[0,0.250,0.375,0.500,0.625,0.875] },
  { min:700, adj:[0,0.375,0.500,0.625,0.875,1.000] },
  { min:680, adj:[0.250,0.375,0.500,0.625,1.000,1.750] },
  { min:660, adj:[0.625,0.750,0.875,1.000,null,null] },
];
const DSCR_BAND_ADJ: Array<{ min: number; max: number; adj: Array<number | null>; requiresGate?: boolean }> = [
  { min:0.75, max:0.95, adj:[1.000,1.125,1.250,null,null,null], requiresGate:true },
  { min:0.95, max:1.00, adj:[0.750,0.750,0.750,null,null,null], requiresGate:true },
  { min:1.00, max:1.15, adj:[0,0,0.125,0.125,0.125,0.250] },
  { min:1.15, max:Infinity, adj:[0,0,0,0,0,0] },
];
const DSCR_PROPERTY_ADJ: Record<string, Array<number | null>> = {
  "2-4 Unit": [0.125,0.250,0.250,0.375,0.375,0.500],
  "Multifamily 5+": [1.000,1.125,1.375,null,null,null],
};
const DSCR_TXN_ADJ: Record<string, Array<number | null>> = {
  purchase: [-0.125,-0.125,-0.125,-0.125,-0.125,-0.125],
  ratetermrefi: [0,0,0,0,0,0],
  cashoutSmall: [0.375,0.375,0.375,0.375,0.500,null],
  cashoutLarge: [0.250,0.250,0.250,0.250,0.375,null],
};
const DSCR_LOAN_AMT_ADJ: Array<{ min: number; max: number; adj: number[] }> = [
  { min:1500000, max:Infinity, adj:[0.500,0.500,0.500,NaN,NaN,NaN] }, // NaN = over 65% LTV not allowed above $1.5M
  { min:1000000, max:1499999.99, adj:[0,0,0,0,0,0] },
  { min:350000, max:999999.99, adj:[-0.125,-0.125,-0.125,-0.125,-0.125,-0.125] },
  { min:150000, max:349999.99, adj:[0,0,0,0,0,0] },
  { min:100000, max:149999.99, adj:[0.250,0.250,0.250,0.250,0.250,0.250] },
  { min:0, max:99999.99, adj:[0.750,0.750,0.750,0.750,0.750,0.750] },
];
const DSCR_PREPAY_ADJ: Record<string, number[]> = {
  "5yr": [0,0,0,0,0,0], "3yr": [0.375,0.375,0.375,0.375,0.375,0.375],
  "2yr": [0.500,0.500,0.500,0.500,0.500,0.500], "1yr": [0.625,0.625,0.625,0.625,0.625,0.625],
  "none": [0.875,0.875,0.875,0.875,0.875,0.875],
};
const DSCR_FEE_BY_PROPERTY: Record<string, number> = {
  "SFR":1995, "Condo":1995, "Mixed-Use":1995, "Land":1995, "2-4 Unit":2495, "Multifamily 5+":3995,
};
const DSCR_BASE_RATE_PRICE = [
  {rate:7.750, price:102.125},{rate:7.625, price:102.000},{rate:7.500, price:101.875},
  {rate:7.375, price:101.750},{rate:7.250, price:101.500},{rate:7.125, price:101.250},
  {rate:7.000, price:101.000},{rate:6.875, price:100.750},{rate:6.750, price:100.375},
  {rate:6.625, price:100.000},
];
const DSCR_MAX_BUYUP = 1.125;
function dscrPriceForDelta(deltaFromPar: number): { rate: number; price: number } | null {
  if (deltaFromPar < -0.0001) return null;
  const tableRate = Math.round((DSCR_BASE_PAR_RATE + deltaFromPar) * 1000) / 1000;
  return DSCR_BASE_RATE_PRICE.find((p) => Math.abs(p.rate - tableRate) < 0.001) || null;
}

const RTL_AUTO_LOAN_TYPES = ["Fix & Flip", "Bridge", "Ground Up Construction"];
const RTL_BASE_RATES: Record<string, Record<string, number>> = {
  "1.00": { "11+":9.99, "5+":9.99, "3-4":10.49, "1-2":10.99 },
  "0.50": { "11+":10.99, "5+":10.99, "3-4":11.49, "1-2":11.99 },
  "0.00": { "11+":12.25, "5+":12.25, "3-4":12.75, "1-2":13.25 },
};
const RTL_FEE_BY_PROJECT: Record<string, number> = {
  bridge: 1995, light: 1995, heavy: 1995, guc_sfr: 2195, guc_24: 2695, multifamily_24: 2495,
};
const RTL_TXN_ADJ: Record<string, number> = { purchase: 0, ratetermrefi: 0.50, cashout: 1.00 };
function experienceTier(deals: number | null): string {
  const d = deals || 0;
  if (d >= 11) return "11+";
  if (d >= 6) return "5+";
  if (d >= 3) return "3-4";
  return "1-2";
}
function rehabClass(s: Scenario): string {
  if (!s.rehabBudget || !s.purchasePrice) return "bridge";
  const ratio = s.rehabBudget / s.purchasePrice;
  return ratio < 0.5 ? "light" : "heavy";
}

// Constructive's RTL sheet prices in flat origination-fee tiers (0/0.5/1
// points), each with its own fixed rate by experience tier -- not a
// continuous buy-up curve like DSCR. All three tiers come back as
// separate options so the comparison UI (and any future points/YSP
// control) can show the real tradeoff: lower points, higher rate.
function checkConstructiveRtl(s: Scenario): LenderResult {
  if (s.citizenshipStatus === "ITIN") {
    return { lender: "Constructive Capital", eligible: false, reason: "ITIN pricing isn't modeled on this sheet — needs manual pricing from underwriting." };
  }
  if (!s.loanAmount || !s.purchasePrice) {
    return { lender: "Constructive Capital", eligible: false, reason: "Missing loan amount or purchase price." };
  }
  const tier = experienceTier(s.experienceDeals);
  const isFN = s.citizenshipStatus === "Foreign National";
  const isGuc = s.loanType === "Ground Up Construction";
  if (isFN && tier === "1-2") {
    return { lender: "Constructive Capital", eligible: false, reason: "Foreign National borrowers need at least the \"3-4\" experience tier." };
  }
  if (isGuc && tier === "1-2") {
    return { lender: "Constructive Capital", eligible: false, reason: "Ground Up Construction requires at least the \"3-4\" experience tier." };
  }
  if (isFN) {
    const fnPct = (tier === "5+" || tier === "11+") ? 0.20 : 0.25;
    const fnMin = Math.max(50000, Math.round(s.loanAmount * fnPct));
    if (s.liquidity != null && s.liquidity < fnMin) {
      return { lender: "Constructive Capital", eligible: false, reason: "Foreign National liquidity requirement not met — needs " + fmtMoney(fnMin) + " seasoned 60+ days in a U.S. bank." };
    }
  }
  const txnKey = s.transactionType === "cashout" ? "cashout" : (s.transactionType === "ratetermrefi" ? "ratetermrefi" : "purchase");
  const txnAdj = RTL_TXN_ADJ[txnKey] || 0;
  const termMonths = s.termMonths || 12;
  const termBuydown = termMonths > 12 ? Math.ceil((termMonths - 12) / 3) * 0.5 : 0;
  const propertyType = s.propertyType === "Duplex" ? "2-4 Unit" : s.propertyType;
  const fee = isGuc
    ? (propertyType === "2-4 Unit" ? RTL_FEE_BY_PROJECT.guc_24 : RTL_FEE_BY_PROJECT.guc_sfr)
    : (propertyType === "2-4 Unit" ? RTL_FEE_BY_PROJECT.multifamily_24 : RTL_FEE_BY_PROJECT[rehabClass(s)]);

  const options: LenderResult["options"] = [];
  for (const points of ["0.00", "0.50", "1.00"]) {
    const base = RTL_BASE_RATES[points][tier];
    if (base == null) continue;
    // V7 RTL_Loan Sizer I37-I39: 1-2 band light rehab at 0 pts is 11.99 + 1.00 (not 12.25 + 1.00);
    // FICO under 700 adds 0.25.
    const v7Light12 = points === "0.00" && tier === "1-2" && !isGuc && bplV7Profile(s) === "light";
    let rate = (v7Light12 ? 12.99 : base) + (isGuc ? 0.75 : 0) + txnAdj + termBuydown + ((s.creditScore || 999) < 700 ? 0.25 : 0);
    rate = Math.round(rate * 100) / 100;
    // RTL loans are interest-only during the term -- price is irrelevant
    // here (there's no secondary market buy-up/down on this sheet), so
    // "price" carries the origination points instead, for the ladder
    // display to stay consistent across lenders.
    options.push({ program: "RTL (" + points + " pts)", rate, price: 100 + Number(points) });
  }
  if (!options.length) return { lender: "Constructive Capital", eligible: false, reason: "No pricing for this experience tier." };
  return { lender: "Constructive Capital", eligible: true, options, fees: { lenderFee: fee } };
}

// Maximum-leverage tables, ported from index.html (RTL_TIERS, GROUNDUP_TIERS,
// DSCR_LTV_BY_FICO, computeMaxLoanAmount, rtlNonCumulativeAdj). The pricer
// should tell the user the loan amount, not ask for it, so Constructive's
// own ceiling is computed here rather than trusted from the caller.
type RtlLimits = { ltc?: number; iltc?: number; ltarv?: number; totalLtc?: number };
const RTL_TIERS: Record<string, { bridge: RtlLimits; light: RtlLimits; heavy: RtlLimits | null }> = {
  "1-2": { bridge: { ltc: 75 }, light: { iltc: 80, ltc: 85, ltarv: 75 }, heavy: null },
  "3-4": { bridge: { ltc: 75 }, light: { iltc: 85, ltc: 85, ltarv: 75 }, heavy: { iltc: 80, ltc: 80, ltarv: 75 } },
  "5+": { bridge: { ltc: 75 }, light: { iltc: 90, ltc: 95, ltarv: 75 }, heavy: { iltc: 80, ltc: 90, ltarv: 75 } },
  "11+": { bridge: { ltc: 75 }, light: { iltc: 85, ltc: 90, ltarv: 75 }, heavy: { iltc: 80, ltc: 90, ltarv: 75 } },
};
const GROUNDUP_TIERS: Record<string, RtlLimits | null> = {
  "1-2": null,
  "3-4": { iltc: 65, totalLtc: 85, ltarv: 70 },
  "5+": { iltc: 70, totalLtc: 90, ltarv: 70 },
  "11+": { iltc: 70, totalLtc: 90, ltarv: 70 },
};
const DSCR_LTV_BY_FICO = [
  { minFico: 720, purchase: 80, rateTerm: 80, cashOut: 75 },
  { minFico: 700, purchase: 80, rateTerm: 80, cashOut: 75 },
  { minFico: 680, purchase: 80, rateTerm: 80, cashOut: 75 }, // single asset (the sheet's 75/70 under 700 is cross-collateral)
  { minFico: 660, purchase: 70, rateTerm: 70, cashOut: 70 },
];
const MAX_LOAN_SANITY_CEILING = 2000000;

// Constructive (BPL Mortgage) RTL leverage -- from Constructive's own "V7 C3
// Constructive Capital Pricing Engine" (bplhub.com library, uploaded 9/30/2026),
// sheets RTL_Grid / RTL_Loan Sizer / RTL_Lists, read 2026-10-06. The V7 engine
// is what Constructive actually sizes with; the "RTL Guidelines 9-15-26" PDF
// still carries an older matrix (effective 2/1/26), so V7 wins where they differ.
// Bands (RTL_Lists): 1-2 = 1 project or industry experience; 3-4 = 3+; 5+ = 6+;
// 11+ = 11+ (11+ only for light rehab $20k-$150k, FICO 700+, SFR, purchase --
// otherwise priced as 5+). ltc = initial LTC / LTPP, totalLtc = total LTC.
const BPL_V7_GRID: Record<string, Record<string, RtlLimits | null>> = {
  "1-2": { bridge: { ltc: 75 }, light: { iltc: 80, totalLtc: 85, ltarv: 75 }, heavy: null },
  "3-4": { bridge: { ltc: 75 }, light: { iltc: 85, totalLtc: 85, ltarv: 75 }, heavy: { iltc: 80, totalLtc: 80, ltarv: 75 } },
  "5+":  { bridge: { ltc: 75 }, light: { iltc: 90, totalLtc: 95, ltarv: 75 }, heavy: { iltc: 80, totalLtc: 90, ltarv: 75 } },
  "11+": { bridge: { ltc: 75 }, light: { iltc: 85, totalLtc: 90, ltarv: 75 }, heavy: { iltc: 80, totalLtc: 90, ltarv: 75 } },
};
// Ground-up isn't on the V7 RTL grid; Ground-Up Matrix (effective 1/1/26).
const BPL_GUC_MATRIX: Record<string, RtlLimits | null> = {
  "1-2": null,
  // Initial 65%/70% needs a clear exit, detailed scope, and plans & permits imminent; otherwise 50%.
  "3-4": { iltc: 65, totalLtc: 85, ltarv: 70 },
  "5+": { iltc: 70, totalLtc: 90, ltarv: 70 },
  "11+": { iltc: 70, totalLtc: 90, ltarv: 70 },
};
// V7 "POSSIBLE RESTRICTED GEOGRAPHY - CHECK W CONSTRUCTIVE" (RTL_Loan Sizer K22): these zips + NYC 100xx-105xx / 110xx-119xx.
const BPL_RESTRICTED_ZIPS = ["77013","77016","77026","77032","77037","77039","77044","77050","77078","77079","77502","77587"];
function rehabOf(s: Scenario): number { return s.loanType === "Bridge" ? 0 : (s.rehabBudget || 0); }
function bplZip(s: Scenario): string | null { return (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(s.propertyAddress || "") || [])[1] || null; }
// V7 RTL_Loan Sizer G12: Bridge = no rehab; Light = rehab < max($50k, half of lower of
// price / as-is) AND ARV < 3x price and as-is; anything else Heavy.
function bplV7Profile(s: Scenario): "bridge" | "light" | "heavy" {
  const rehab = s.loanType === "Bridge" ? 0 : (s.rehabBudget || 0);
  if (!rehab) return "bridge";
  const pp = s.purchasePrice || 0, aiv = s.currentValue || pp;
  const light = rehab < Math.max(50000, Math.min(aiv, pp) / 2) && (!s.arv || (s.arv < 3 * pp && s.arv < 3 * aiv));
  return light ? "light" : "heavy";
}
function bplV7Band(s: Scenario, profile: string): string {
  const t = experienceTier(s.experienceDeals);
  if (t !== "11+") return t;
  const ok11 = profile === "light" && (s.rehabBudget || 0) > 20000 && (s.rehabBudget || 0) < 150000 && (s.creditScore || 0) >= 700 && (s.propertyType || "SFR") === "SFR" && s.transactionType === "purchase";
  return ok11 ? "11+" : "5+";
}

async function constructiveMaxLoan(s: Scenario): Promise<{ amount: number; note?: string; reason?: string } | null> {
  if (RTL_AUTO_LOAN_TYPES.includes(s.loanType)) {
    const isGuc = s.loanType === "Ground Up Construction";
    if (s.purchasePrice == null || (s.purchasePrice === 0 && !isGuc)) return null;
    const profile = isGuc ? "guc" : bplV7Profile(s);
    const band = isGuc ? experienceTier(s.experienceDeals) : bplV7Band(s, profile);
    const state = stateFromAddress(s.propertyAddress);
    const zip = bplZip(s);
    const no = (reason: string) => ({ amount: 0, reason });
    if (state && ["ND", "SD", "NV"].includes(state)) return no("Constructive doesn't do fix & flip / bridge / ground-up in " + state + ".");
    if (state === "MD" && /\bBaltimore,\s*MD\b/i.test(s.propertyAddress || "") && !/county/i.test(s.propertyAddress || "")) return no("Baltimore City is ineligible for Constructive RTL.");
    if (s.creditScore != null && s.creditScore < (isGuc ? 700 : 680)) return no("Constructive needs a " + (isGuc ? "700" : "680") + "+ representative FICO on " + (isGuc ? "ground-up" : "fix & flip / bridge") + ".");
    if (isGuc && s.citizenshipStatus === "Foreign National") return no("Foreign nationals aren't eligible for Constructive ground-up.");
    if (isGuc && band === "1-2") return no("Constructive ground-up needs 3+ completed projects in the last 3 years.");
    if (!isGuc && profile === "heavy" && band === "1-2") return no("Heavy rehab at Constructive needs 3+ completed projects (V7 grid: 1-2 band is light rehab / bridge only).");
    if (isGuc && s.transactionType === "cashout") return no("No cash-out on Constructive ground-up.");
    // RTL Guidelines 9-15-26 (bplhub.com) §12.2/12.3, §7.3, App. G -- read 2026-10-07.
    if (s.ruralStatus === "rural") return no("Constructive doesn't lend on rural properties (fix & flip / bridge / ground-up).");
    if ((s as any).decliningMarket === "yes") return no("Constructive's RTL guidelines exclude properties in declining markets.");
    const BPL_RTL_TYPES = ["SFR", "Single Family", "Townhome", "Condo", "2-4 Unit", "Duplex"];
    if (!BPL_RTL_TYPES.includes(s.propertyType)) return no("Constructive fix & flip / bridge is 1-4 unit residential only (SFR, townhome/PUD, condo under 4 stories, 2-4 units) — not " + s.propertyType + ".");
    if (isGuc && s.propertyType === "Condo") return no("Condos aren't eligible for Constructive ground-up.");
    if (s.citizenshipStatus === "Foreign National" && (s.entityType || "LLC") === "Individual") return no("Constructive foreign-national guarantors must borrow through a U.S. entity.");
    if (s.citizenshipStatus === "Foreign National" && !s.creditScore) return no("Constructive foreign nationals need a valid credit report and score.");
    // RTL Guidelines App. E: ineligible countries for foreign-national guarantors.
    const BPL_FN_BANNED = ["afghanistan","libya","balkans","nicaragua","belarus","north korea","bosnia","russia","burma","myanmar","saudi arabia","burundi","somalia","central african republic","south sudan","crimea","sudan","cuba","syria","congo","turkey","egypt","ukraine","eritrea","united arab emirates","uae","haiti","vanuatu","iran","venezuela","iraq","yemen","lebanon","zimbabwe","liberia"];
    if (s.citizenshipStatus === "Foreign National" && s.countryOfDomicile && BPL_FN_BANNED.some((c) => s.countryOfDomicile!.toLowerCase().includes(c))) return no("Constructive can't lend to foreign nationals domiciled in " + s.countryOfDomicile + " (ineligible-country list).");
    const limitsRaw = isGuc ? BPL_GUC_MATRIX[band] : BPL_V7_GRID[band][profile];
    if (!limitsRaw) return null;
    const limits: RtlLimits = { ...limitsRaw };
    const notes: string[] = [];
    if (isGuc) notes.push("Initial " + limits.iltc + "% of land assumes a clear exit, detailed scope, and plans & permits imminent — otherwise 50%.");
    if (experienceTier(s.experienceDeals) === "11+" && band === "5+") notes.push("Priced in the 5+ band — V7's 11+ band is only light rehab $20k-$150k, 700+ FICO, SFR purchases.");
    if (profile === "heavy") notes.push("Heavy rehab may need a feasibility study / project review.");
    if (!isGuc && profile !== "bridge" && s.arv && s.arv < 1.15 * ((s.purchasePrice || 0) + rehabOf(s))) notes.push("ARV is under 115% of purchase + rehab — Constructive's written guidelines require at least " + fmtMoney(1.15 * ((s.purchasePrice || 0) + rehabOf(s))) + "; expect pushback.");
    if (zip && (BPL_RESTRICTED_ZIPS.includes(zip) || (+zip > 10000 && +zip < 10600) || (+zip > 11000 && +zip < 12000))) notes.push("Possible restricted geography (zip " + zip + ") — check with Constructive before quoting.");
    // V7 non-cumulative adjustments (RTL_Grid): cash-out -5, foreign national -5, New York -15.
    const candidates: Array<[number, string]> = [[0, ""]];
    if (state === "NY") candidates.push([-15, "New York"]);
    if (s.transactionType === "cashout") candidates.push([-5, "cash-out"]);
    if (s.citizenshipStatus === "Foreign National") candidates.push([-5, "foreign national"]);
    const [adj, why] = candidates.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (adj) {
      for (const k of ["ltc", "iltc", "ltarv", "totalLtc"] as const) if (limits[k] != null) limits[k] = (limits[k] as number) + adj;
      notes.push("Leverage " + adj + "% (" + why + "; Constructive's adjustments don't stack).");
    }
    const pp = (s.transactionType !== "purchase" && s.currentValue) ? s.currentValue : s.purchasePrice, rehab = s.rehabBudget || 0;
    const caps: number[] = [];
    if (profile === "bridge") {
      if (limits.ltc != null) caps.push(limits.ltc / 100 * pp);
    } else {
      if (limits.iltc != null) caps.push(limits.iltc / 100 * pp + rehab);
      if (limits.totalLtc != null) caps.push(limits.totalLtc / 100 * (pp + rehab));
      if (limits.ltarv != null && s.arv) caps.push(limits.ltarv / 100 * s.arv);
    }
    if (!caps.length) return null;
    // RTL Guidelines §14.3: minimum $7,500 borrower equity on every loan (on a purchase: cost minus loan).
    if (s.transactionType === "purchase") caps.push((pp + rehab) - 7500);
    if (experienceTier(s.experienceDeals) === "1-2") notes.push("Constructive's 0-2 project borrowers must own their primary residence.");
    const amt = Math.floor(Math.max(0, Math.min(MAX_LOAN_SANITY_CEILING, ...caps)));
    if (amt < 75000) return no("Below Constructive's $75,000 minimum (max here is " + fmtMoney(amt) + ").");
    notes.unshift("Constructive " + band + " band, " + (isGuc ? "ground-up" : profile === "bridge" ? "bridge" : profile + " rehab") + " (V7 pricing engine, 9/30/26).");
    return { amount: amt, note: notes.join(" ") };
  }
  if (s.loanType === "DSCR") {
    const basis = s.transactionType !== "purchase" && s.currentValue ? s.currentValue : s.purchasePrice;
    if (!basis || !s.creditScore) return null;
    const rural = s.ruralStatus === "rural";
    const tierRow = DSCR_LTV_BY_FICO.find((t) => (s.creditScore as number) >= t.minFico) || DSCR_LTV_BY_FICO[DSCR_LTV_BY_FICO.length - 1];
    const key = s.transactionType === "cashout" ? "cashOut" : (s.transactionType === "ratetermrefi" ? "rateTerm" : "purchase");
    const maxLtv = rural ? 65 : tierRow[key];
    const ltvCap = basis * (maxLtv / 100);
    let dscrCap = Infinity;
    if (s.rentEstimate) {
      const minDscr = constructiveMinDscr(s.creditScore, maxLtv, ltvCap, stateFromAddress(s.propertyAddress), rural);
      const trial = await checkConstructiveAt({ ...s, loanAmount: Math.min(ltvCap, MAX_LOAN_SANITY_CEILING), rentEstimate: null });
      const rate = trial.eligible && trial.options && trial.options.length ? trial.options[0].rate : 7.5;
      const r = rate / 100 / 12;
      const termM = s.termMonths || 360;
      const factor = r / (1 - Math.pow(1 + r, -termM));
      const hasExp = s.monthlyTaxes != null || s.monthlyInsurance != null;
      const targetPi = hasExp ? s.rentEstimate / minDscr - ((s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0)) : (s.rentEstimate / minDscr) / 1.2;
      dscrCap = Math.max(0, targetPi / factor);
    }
    let capped = Math.min(ltvCap, dscrCap, MAX_LOAN_SANITY_CEILING);
    // The note rate moves with the amount (LTV band), so step down until the sheet's own DSCR check passes.
    for (let i = 0; i < 12 && s.rentEstimate && capped > 50000; i++) {
      const chk = await checkConstructiveAt({ ...s, loanAmount: Math.floor(capped) });
      if (chk.eligible || !/DSCR/.test(chk.reason || "")) break;
      capped *= 0.98;
    }
    return { amount: Math.floor(Math.max(0, capped)), note: "Max " + maxLtv + "% LTV of " + (s.transactionType !== "purchase" && s.currentValue ? "current value" : "purchase price") + (dscrCap < ltvCap ? " — limited by rental income (DSCR)." : ".") };
  }
  return null;
}

// Constructive "State by State Licensing Matrix" (effective 9/1/2026, bplhub.com):
// broker license required in AZ, CA, MN, UT, and ID for DSCR on 1-4 units.
// Bridgepoint holds no licenses (Joe 2026-10-06), so those are out.
function constructiveLicenseBlock(s: Scenario): string | null {
  const st = stateFromAddress(s.propertyAddress);
  if (!st) return null;
  if (["AZ", "CA", "MN", "UT"].includes(st) || (st === "ID" && s.loanType === "DSCR")) return "Constructive requires a broker license in " + st + (st === "ID" ? " for DSCR" : "") + " — Bridgepoint can't place this loan there.";
  return null;
}
async function checkConstructive(s: Scenario): Promise<LenderResult> {
  const lic = constructiveLicenseBlock(s);
  if (lic) return { lender: "Constructive Capital", eligible: false, reason: lic };
  if (s.loanAmount) {
    const max = await constructiveMaxLoan(s);
    if (max && max.reason) return { lender: "Constructive Capital", eligible: false, reason: max.reason };
    if (max && max.amount && s.loanAmount > max.amount + 1) return { lender: "Constructive Capital", eligible: false, reason: "Over Constructive's max of " + fmtMoney(max.amount) + " on this deal. " + (max.note || "") };
    const r = await checkConstructiveAt(s);
    return { ...r, loanAmountUsed: s.loanAmount, maxLoanAmount: max ? max.amount : undefined, rehabHoldback: constructiveHoldback(s, s.loanAmount) };
  }
  if (s.loanType === "Mixed-Use" || s.propertyType === "Mixed-Use") return { lender: "Constructive Capital", eligible: false, reason: "Constructive doesn't lend on mixed-use properties." };
  if (s.loanType === "Portfolio/Blanket") return { lender: "Constructive Capital", eligible: false, reason: "Constructive portfolio/blanket loans aren't priced here yet — single-asset DSCR only." };
  const max = await constructiveMaxLoan(s);
  if (max && max.reason) return { lender: "Constructive Capital", eligible: false, reason: max.reason };
  if (!max || !max.amount) {
    return { lender: "Constructive Capital", eligible: false, reason: "Not enough information to size the loan yet (needs credit score, property value, and for rentals the monthly rent; for fix & flip/bridge/ground-up the purchase price, rehab, ARV, and experience)." };
  }
  const r = await checkConstructiveAt({ ...s, loanAmount: max.amount });
  const assumptions = (r.assumptions || []).concat(max.note ? [max.note] : []);
  return { ...r, assumptions, loanAmountUsed: max.amount, maxLoanAmount: max.amount, rehabHoldback: constructiveHoldback(s, max.amount) };
}
// Constructive's RTL sizing (constructiveMaxLoan) always funds 100% of the
// rehab/construction budget; any leverage cap comes off the day-one advance.
function constructiveHoldback(s: Scenario, amount: number): number | undefined {
  if (!RTL_AUTO_LOAN_TYPES.includes(s.loanType) || s.loanType === "Bridge") return RTL_AUTO_LOAN_TYPES.includes(s.loanType) ? 0 : undefined;
  return Math.min(s.rehabBudget || 0, amount);
}

async function checkConstructiveAt(s: Scenario): Promise<LenderResult> {
  if (RTL_AUTO_LOAN_TYPES.includes(s.loanType)) {
    return checkConstructiveRtl(s);
  }
  if (s.loanType !== "DSCR") {
    return { lender: "Constructive Capital", eligible: false, reason: "Only DSCR and RTL (Fix & Flip/Bridge/GUC) are ported into this live check so far." };
  }
  if (s.citizenshipStatus === "Foreign National" || s.citizenshipStatus === "ITIN") {
    return { lender: "Constructive Capital", eligible: false, reason: s.citizenshipStatus + " isn't modeled on this sheet — needs manual pricing from underwriting." };
  }
  const valueBasis = s.transactionType !== "purchase" && s.currentValue ? s.currentValue : s.purchasePrice;
  if (!s.creditScore || !s.loanAmount || !valueBasis) {
    return { lender: "Constructive Capital", eligible: false, reason: "Missing credit score, loan amount, or property value." };
  }
  const propState = stateFromAddress(s.propertyAddress);
  if (propState && DSCR_INELIGIBLE_STATES.includes(propState)) {
    return { lender: "Constructive Capital", eligible: false, reason: propState + " is on this program's ineligible-states list (ND, NV, SD)." };
  }
  // DSCR Guideline Matrix 7-1-26 (bplhub.com), read 2026-10-07.
  if (s.propertyType === "Mixed-Use" || s.propertyType === "Land") return { lender: "Constructive Capital", eligible: false, reason: "Constructive DSCR doesn't lend on " + s.propertyType + " (1-4 units, condos, PUDs and 5-8 unit multifamily only)." };
  if ((s.entityType || "LLC") === "Individual" && propState && ["CO", "NY", "FL", "VA", "GA"].includes(propState)) return { lender: "Constructive Capital", eligible: false, reason: "Constructive requires an entity borrower for DSCR loans in " + propState + "." };
  if (s.loanAmount < 50000) return { lender: "Constructive Capital", eligible: false, reason: "Below Constructive's $50,000 DSCR minimum." };
  if (s.loanAmount > 2000000) return { lender: "Constructive Capital", eligible: false, reason: "Above Constructive's $2,000,000 DSCR maximum." };
  if (valueBasis < 75000) return { lender: "Constructive Capital", eligible: false, reason: "Constructive DSCR needs a property value of at least $75,000." };
  const propertyType = pricingPropertyType(s.propertyType) || "SFR";
  const ltv = (s.loanAmount / valueBasis) * 100;
  const col = dscrLtvCol(ltv);
  if (col === -1) {
    return { lender: "Constructive Capital", eligible: false, reason: "LTV of " + ltv.toFixed(0) + "% is above 80%, off this rate sheet." };
  }
  const ficoRow = DSCR_FICO_ADJ.find((r) => (s.creditScore as number) >= r.min);
  if (!ficoRow || ficoRow.adj[col] == null) {
    return { lender: "Constructive Capital", eligible: false, reason: "This FICO/LTV combination isn't priced on this sheet." };
  }
  let rate = DSCR_BASE_PAR_RATE + (ficoRow.adj[col] as number);
  const assumedRate = rate;
  const termMonths = s.termMonths || 360;
  const monthlyRate = assumedRate / 100 / 12;
  const pi = monthlyRate ? s.loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1) : s.loanAmount / termMonths;
  let dscrVal: number | null = null;
  if (pi && s.rentEstimate) {
    const hasRealExpenses = s.monthlyTaxes != null || s.monthlyInsurance != null;
    const pitia = hasRealExpenses ? pi + (s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0) : pi * 1.2;
    dscrVal = s.rentEstimate / pitia;
    const band = DSCR_BAND_ADJ.find((b) => (dscrVal as number) >= b.min && (dscrVal as number) < b.max);
    if (band) {
      if (band.adj[col] == null) {
        return { lender: "Constructive Capital", eligible: false, reason: "This DSCR/LTV combination isn't priced on this sheet." };
      }
      const gateMet = !band.requiresGate || ((s.creditScore as number) >= 720 && s.loanAmount >= 150000);
      if (gateMet) rate += band.adj[col] as number;
    }
  }
  const propAdj = DSCR_PROPERTY_ADJ[propertyType];
  if (propAdj) {
    if (propAdj[col] == null) return { lender: "Constructive Capital", eligible: false, reason: "This property type/LTV combination isn't priced on this sheet." };
    rate += propAdj[col] as number;
  }
  const txnKey = s.transactionType === "cashout" ? "cashout" : (s.transactionType === "ratetermrefi" ? "ratetermrefi" : "purchase");
  const txnAdj = txnKey === "cashout" ? (s.loanAmount < 100000 ? DSCR_TXN_ADJ.cashoutSmall : DSCR_TXN_ADJ.cashoutLarge) : DSCR_TXN_ADJ[txnKey];
  if (txnAdj[col] == null) return { lender: "Constructive Capital", eligible: false, reason: "This transaction type/LTV combination isn't priced on this sheet." };
  rate += txnAdj[col] as number;
  const amtBand = DSCR_LOAN_AMT_ADJ.find((b) => s.loanAmount! >= b.min && s.loanAmount! <= b.max);
  if (amtBand && isNaN(amtBand.adj[col])) return { lender: "Constructive Capital", eligible: false, reason: "Loans over $1.5M are capped at 65% LTV at Constructive." };
  if (amtBand) rate += amtBand.adj[col];
  if (propState && DSCR_MIN_DSCR_STATES.includes(propState) && (s.creditScore as number) < 680) rate += DSCR_GEO_ADJ_SUB680;
  const prepayKey = s.prepayTerm || "5yr";
  rate += DSCR_PREPAY_ADJ[prepayKey][col];
  rate = Math.round(rate * 1000) / 1000;
  if (rate < DSCR_MIN_NOTE_RATE) rate = DSCR_MIN_NOTE_RATE;
  // Qualifying rules (matrix 7-1-26 + rate sheet 9-29-26): rural = 65% LTV / 720 FICO / DSCR 1.20+;
  // min DSCR by FICO / LTV / state, measured at the note rate.
  const rural = s.ruralStatus === "rural";
  if (rural && (ltv > 65 || (s.creditScore as number) < 720)) return { lender: "Constructive Capital", eligible: false, reason: "Rural rentals at Constructive need 720+ FICO and 65% LTV or less." };
  if (s.rentEstimate) {
    const r = rate / 100 / 12, n = s.termMonths || 360;
    const notePi = s.loanAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    const hasExp = s.monthlyTaxes != null || s.monthlyInsurance != null;
    const noteDscr = s.rentEstimate / (hasExp ? notePi + (s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0) : notePi * 1.2);
    const minD = constructiveMinDscr(s.creditScore as number, ltv, s.loanAmount, propState, rural);
    if (noteDscr < minD - 0.005) return { lender: "Constructive Capital", eligible: false, reason: "DSCR " + noteDscr.toFixed(2) + "x is under Constructive's " + minD.toFixed(2) + "x minimum here" + ((s.creditScore as number) < 720 ? " (1.20x under a 720 FICO)" : "") + " — lower the loan amount or raise the rent." };
    if (noteDscr < 1.0 && ((s.creditScore as number) < 720 || s.loanAmount < 150000)) return { lender: "Constructive Capital", eligible: false, reason: "DSCR under 1.00x needs 720+ FICO and a $150k+ loan at Constructive." };
  }

  const fee = DSCR_FEE_BY_PROPERTY[propertyType] || DSCR_FEE_BY_PROPERTY.SFR;
  const noYspAllowed = prepayKey === "none" || propertyType === "Multifamily 5+";
  // Build the full buy-up ladder (par through par+1.125%, in 0.125% steps)
  // the same way the CRM's own Pricer tab lets an LO quote above par to
  // earn YSP -- each step's DSCR shifts too, since a higher note rate
  // raises the payment.
  const options: LenderResult["options"] = [];
  for (let delta = 0; delta <= DSCR_MAX_BUYUP + 0.0001; delta += 0.125) {
    if (noYspAllowed && delta > 0) break;
    const priceRow = dscrPriceForDelta(Math.round(delta * 1000) / 1000);
    if (!priceRow) continue;
    if (priceRow.price > (DSCR_MAX_PRICE_BY_PPP[prepayKey] ?? 102.125) + 0.0005) break;
    const stepRate = Math.round((rate + delta) * 1000) / 1000;
    const stepMonthlyRate = stepRate / 100 / 12;
    const stepPi = stepMonthlyRate ? s.loanAmount * (stepMonthlyRate * Math.pow(1 + stepMonthlyRate, termMonths)) / (Math.pow(1 + stepMonthlyRate, termMonths) - 1) : s.loanAmount / termMonths;
    let stepDscr: number | null = null;
    if (stepPi && s.rentEstimate) {
      const hasRealExpenses = s.monthlyTaxes != null || s.monthlyInsurance != null;
      const pitia = hasRealExpenses ? stepPi + (s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0) : stepPi * 1.2;
      stepDscr = s.rentEstimate / pitia;
    }
    options.push({ program: "DSCR 30yr Fixed", rate: stepRate, price: priceRow.price, dscr: stepDscr });
  }
  if (!options.length) return { lender: "Constructive Capital", eligible: false, reason: "No priceable options for this scenario." };
  const dscrNotes: string[] = [];
  if (propertyType === "Multifamily 5+") dscrNotes.push("Constructive DSCR multifamily is 5-8 units only.");
  if (s.propertyType === "Condo") dscrNotes.push("Non-warrantable condos are capped at 65% LTV at Constructive.");
  if (s.loanAmount > 1000000) dscrNotes.push("Loans over $1M need Constructive second-level approval" + (s.loanAmount > 1500000 ? " and a second full appraisal." : "."));
  if (s.citizenshipStatus === "Non-Permanent Resident") dscrNotes.push("Non-permanent residents need an unexpired eligible visa (6+ months remaining).");
  return { lender: "Constructive Capital", eligible: true, options, fees: { lenderFee: fee }, assumptions: dscrNotes.length ? dscrNotes : undefined };
}

// ---------------------------------------------------------------------
// NextRes -- public, unauthenticated JSON API (api.commercial.nextres.com).
// Confirmed live 2026-09-30 by capturing the real requests both their DSCR
// and RTL (Fix & Flip/Bridge/GUC) Quick Quote forms send -- same endpoint,
// different payload shape per product.
// ---------------------------------------------------------------------
const NEXTRES_PROPERTY_TYPE: Record<string, string> = {
  "SFR": "SFR-Detached",
  "Duplex": "2-4 Units",
  "2-4 Unit": "2-4 Units",
  "Condo": "Condo",
  "Mixed-Use": "Mixed-Use",
  "Multifamily 5+": "Multifamily 5+",
};
const NEXTRES_ENTITY_TYPE: Record<string, string> = {
  "LLC": "LLC",
  "Corporation": "Corp",
  "Individual": "Individual",
};
const NEXTRES_CITIZENSHIP: Record<string, string> = {
  "US Citizen": "US Citizen",
  "Permanent Resident": "Permanent Resident",
  "Non-Permanent Resident": "Non Permanent Resident",
  "Foreign National": "Foreign National",
  "ITIN": "ITIN",
};
const NEXTRES_PREPAY: Record<string, string> = {
  "5yr": "60-5/5/5/5/5",
  "3yr": "36-5/5/5",
  "2yr": "24-5/5",
  "1yr": "12-5",
  "none": "0-0",
};
const NEXTRES_RTL_PRODUCT: Record<string, string> = {
  "Fix & Flip": "Fix and Flip",
  "Bridge": "Bridge",
  "Ground Up Construction": "Ground Up Construction",
};
// Maps "deals completed" to NextRes's experience bucket -- same shape as
// Constructive's experienceTier(), different label set.
function nextresExperience(deals: number | null): { experience: string; how: number } {
  const d = deals || 0;
  if (d >= 5) return { experience: "5-null", how: d };
  return { experience: d + "-" + d, how: d };
}

// Shared by DSCR and RTL -- both hit the same endpoint and come back in
// the same Prices -> Programs -> Prices[] shape.
async function callNextresPriceLoan(body: Record<string, unknown>, assumptions: string[]): Promise<LenderResult> {
  const res = await fetch("https://api.commercial.nextres.com/loan/priceLoan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "loan-number": "new",
      "borrower-separator": "",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Confirmed 2026-10-02: NextRes's Quick Quote used to price anonymously,
    // but now answers 403 "Loan number is required" to any request that
    // isn't carrying a signed-in session (the same call works from inside a
    // logged-in browser, and fails with credentials omitted). We don't use
    // anyone's login to get around that, so this is reported as unavailable.
    if (res.status === 403) {
      return { lender: "NextRes", eligible: false, reason: "NextRes live pricing is unavailable right now — their pricer now requires a signed-in NextRes session, which this tool doesn't use. Price NextRes directly on their site.", assumptions, unavailable: true };
    }
    return { lender: "NextRes", eligible: false, reason: "NextRes's pricer didn't return a quote (" + res.status + "): " + text.slice(0, 200) };
  }
  const data = await res.json();
  const prices = (data && data.data && data.data.Prices) || [];
  const options: LenderResult["options"] = [];
  for (const product of prices) {
    for (const program of (product.Programs || [])) {
      for (const row of (program.Prices || [])) {
        options.push({
          program: program.ProgramName + (product.InterestOnly ? " (IO)" : ""),
          rate: row.Rate,
          price: row.LockTermPrices && row.LockTermPrices[0] ? parseFloat(row.LockTermPrices[0].Price) : row.BaseRate,
          dscr: row.Dscr != null ? row.Dscr : null,
        });
      }
    }
  }
  if (!options.length) {
    return { lender: "NextRes", eligible: false, reason: "No eligible NextRes programs for this scenario.", assumptions };
  }
  return { lender: "NextRes", eligible: true, options, assumptions };
}

// RTL (Fix & Flip / Bridge / Ground Up Construction) -- confirmed live
// 2026-09-30 against real scenarios for all three. Fix & Flip and Ground
// Up Construction share one field set. Bridge is different: no rehab/ARV
// fields (it's a no-rehab product), and it has one extra required field
// keyed by a non-semantic numeric ID ("1784570255323" in their current
// build, not a real field name) for Business vs. Consumer Purpose Bridge
// -- hardcoded to Business Purpose since Bridgepoint only writes
// business-purpose loans. This key is fragile: if NextRes rebuilds their
// form, it will need re-capturing the same way it was found (inspect the
// real request body their own Quick Quote tool sends).
const NEXTRES_BRIDGE_LOAN_PURPOSE_FIELD = "1784570255323";
const NEXTRES_BRIDGE_BUSINESS_PURPOSE_VALUE = "1784570228520";
async function checkNextresRtl(s: Scenario): Promise<LenderResult> {
  if (!s.creditScore || !s.loanAmount || !s.purchasePrice) {
    return { lender: "NextRes", eligible: false, reason: "Missing credit score, loan amount, or purchase price." };
  }
  const assumptions: string[] = [
    "Assumed clean history: no bankruptcy/foreclosure/short sale/forbearance, 0x30 mortgage lates",
    "Assumed 6 months reserves (not tracked on the lead yet)",
    "Assumed Dutch interest type and 1st lien",
  ];
  const exp = nextresExperience(s.experienceDeals);
  const isGuc = s.loanType === "Ground Up Construction";
  const isBridge = s.loanType === "Bridge";
  const termMonths = s.termMonths || 12;
  const loanTerm = [6, 12, 18, 24].reduce((best, t) => Math.abs(t - termMonths) < Math.abs(best - termMonths) ? t : best, 12);
  const body: Record<string, unknown> = {
    productType: NEXTRES_RTL_PRODUCT[s.loanType] || "Fix and Flip",
    transactionType: s.transactionType === "purchase" ? "Purchase" : "Refinance",
    lienType: "0",
    interestType: "Dutch",
    proposedOccupancy: "Non Owner Occupied",
    loanTerm: String(loanTerm),
    borrowerType: NEXTRES_ENTITY_TYPE[s.entityType || "LLC"] || "LLC",
    proposedLoanAmount: fmtMoney(s.loanAmount),
    propertyPurchasePrice: fmtMoney(s.purchasePrice),
    asIsValue: fmtMoney(s.currentValue || s.purchasePrice),
    interestReserve: "0",
    closingCostEstimate: fmtMoney(s.loanAmount * 0.02),
    experience: exp.experience,
    howManyExperiences: exp.how,
    propertyType: NEXTRES_PROPERTY_TYPE[s.propertyType] || "SFR-Detached",
    numberOfUnits: s.propertyType === "Duplex" || s.propertyType === "2-4 Unit" ? 2 : 1,
    bankruptcy: "null-null-null",
    foreclosure: "null-null",
    deedInLieu: "null-null",
    shortSale: "null-null",
    mortgageLates: "0-0-30-12",
    forbearanceLoanModification: "null-null",
    secondLien: "0",
    firstTimeHomeBuyer: false,
    firstTimeHomeInvestor: !s.experienceDeals || s.experienceDeals === 0,
    ruralProperty: s.ruralStatus === "rural",
    isMultipleProperties: false,
    decliningMarketProperty: false,
    isNewConstructionProperty: isGuc,
    isPropertyInLeasableState: false,
    borrowerFirstName: s.guarantorFirstName || "",
    borrowerLastName: s.guarantorLastName || "",
    estimatedCreditScore: String(s.creditScore),
    propertyState: s.propertyState || "",
    subjectPropertyAddress: s.propertyAddress || "",
    residency: NEXTRES_CITIZENSHIP[s.citizenshipStatus || "US Citizen"] || "US Citizen",
    amortizationType: "IO - Fixed",
    monthsReserve: "6",
    email: "",
    showSubPrograms: false,
    changedLoanDetails: [],
  };
  if (isBridge) {
    // Bridge is a no-rehab product -- no ARV/rehab fields exist on its
    // form -- and needs the Business-vs-Consumer Purpose field instead.
    body.escrowRepairHoldback = "0";
    body[NEXTRES_BRIDGE_LOAN_PURPOSE_FIELD] = NEXTRES_BRIDGE_BUSINESS_PURPOSE_VALUE;
  } else {
    body.changeToSquareFootage = false;
    body.afterRepairValue = fmtMoney(s.arv || s.purchasePrice);
    body.rehabBudget = fmtMoney(s.rehabBudget);
    body.constructionReserve = Math.round(s.rehabBudget || 0);
  }
  return callNextresPriceLoan(body, assumptions);
}

// NextRes's API only prices a loan amount you hand it -- it never says what
// the most it would lend is. So when the caller doesn't pick an amount, find
// the ceiling by testing amounts against the live pricer: a coarse grid in
// parallel, then two rounds of narrowing between the highest accepted amount
// and the next one up. Lands within ~0.5% of the true ceiling, rounded down
// to $500. Assumes eligibility only gets harder as the amount goes up.
function nextresCeiling(s: Scenario): number | null {
  if (RTL_AUTO_LOAN_TYPES.includes(s.loanType)) {
    const cost = (s.purchasePrice || 0) + (s.rehabBudget || 0);
    if (!cost) return null;
    return s.arv ? Math.min(cost, s.arv * 0.8) : cost;
  }
  const basis = s.transactionType !== "purchase" && s.currentValue ? s.currentValue : s.purchasePrice;
  return basis ? basis * 0.85 : null;
}
async function checkNextres(s: Scenario): Promise<LenderResult> {
  if (s.loanAmount) {
    const r = await checkNextresAt(s);
    return { ...r, loanAmountUsed: s.loanAmount };
  }
  const hi = nextresCeiling(s);
  if (!hi || !s.creditScore) {
    return { lender: "NextRes", eligible: false, reason: "Not enough information to size the loan yet (needs credit score and property value; for fix & flip/bridge/ground-up the purchase price and rehab)." };
  }
  const roundDown = (n: number) => Math.floor(n / 500) * 500;
  const cache = new Map<number, LenderResult>();
  const probe = async (amt: number) => {
    const a = roundDown(amt);
    if (a <= 0 || cache.has(a)) return;
    cache.set(a, await checkNextresAt({ ...s, loanAmount: a }));
  };
  await probe(hi);
  const first = cache.get(roundDown(hi));
  if (first && first.unavailable) return first;
  await Promise.all([0.5, 0.58, 0.66, 0.74, 0.82, 0.9, 0.96].map((f) => probe(hi * f)));
  const sortedAmts = () => Array.from(cache.keys()).sort((a, b) => a - b);
  const highestEligible = () => sortedAmts().filter((a) => cache.get(a)!.eligible).pop();
  let lo = highestEligible();
  if (lo == null) {
    const lowest = sortedAmts()[0];
    const r = cache.get(lowest)!;
    return { ...r, eligible: false, reason: (r.reason || "No eligible NextRes programs for this scenario.") + " (Tried loan amounts from $" + fmtMoney(lowest) + " up to $" + fmtMoney(sortedAmts().pop()) + ".)" };
  }
  for (let round = 0; round < 2; round++) {
    const up = sortedAmts().find((a) => a > (lo as number));
    if (up == null) break;
    await Promise.all([0.25, 0.5, 0.75].map((f) => probe((lo as number) + (up - (lo as number)) * f)));
    lo = highestEligible();
  }
  const best = cache.get(lo as number)!;
  return { ...best, loanAmountUsed: lo as number, maxLoanAmount: lo as number, assumptions: (best.assumptions || []).concat(["Max loan found by testing amounts against NextRes's live pricer (rounded down to $500)."]) };
}

async function checkNextresAt(s: Scenario): Promise<LenderResult> {
  if (RTL_AUTO_LOAN_TYPES.includes(s.loanType)) {
    return checkNextresRtl(s);
  }
  const isDscr = s.loanType === "DSCR" || s.loanType === "Portfolio/Blanket";
  if (!isDscr) {
    return { lender: "NextRes", eligible: false, reason: "Only DSCR/Portfolio and RTL (Fix & Flip/Bridge/GUC) are wired up for NextRes so far." };
  }
  if (!s.creditScore || !s.loanAmount) {
    return { lender: "NextRes", eligible: false, reason: "Missing credit score or loan amount." };
  }
  if (s.transactionType === "purchase" ? !s.purchasePrice : (!s.currentValue || s.currentLoanBalance == null)) {
    return { lender: "NextRes", eligible: false, reason: s.transactionType === "purchase" ? "Missing purchase price." : "Refinances need the current value and the existing loan payoff balance." };
  }
  const assumptions: string[] = [];
  // NextRes's Quick Quote doesn't ask for these on the DSCR form the way it
  // asks for everything else -- there's no field on the lead for any of
  // them yet, so these are the conservative ("looks clean") defaults. A
  // real bad-credit-history borrower would price worse than what this
  // returns; flagging so nobody mistakes this for a guarantee.
  assumptions.push("Assumed clean history: no bankruptcy/foreclosure/short sale/forbearance, 0x30 mortgage lates");
  assumptions.push("Assumed 6 months reserves (not tracked on the lead yet)");

  const isPurchase = s.transactionType === "purchase";
  const body: Record<string, unknown> = {
    productType: "DSCR (Long Term Rental)",
    transactionType: isPurchase ? "Purchase" : "Refinance",
    lienType: "0",
    proposedOccupancy: "Non Owner Occupied",
    loanTerm: "360",
    borrowerType: NEXTRES_ENTITY_TYPE[s.entityType || "LLC"] || "LLC",
    proposedLoanAmount: fmtMoney(s.loanAmount),
    asIsValue: fmtMoney(s.currentValue || s.purchasePrice),
    closingCostEstimate: fmtMoney((s.loanAmount || 0) * 0.02),
    propertyType: NEXTRES_PROPERTY_TYPE[s.propertyType] || "SFR-Detached",
    numberOfUnits: s.propertyType === "Duplex" || s.propertyType === "2-4 Unit" ? 2 : 1,
    prepaymentPenalty: NEXTRES_PREPAY[s.prepayTerm || "5yr"] || "60-5/5/5/5/5",
    residency: NEXTRES_CITIZENSHIP[s.citizenshipStatus || "US Citizen"] || "US Citizen",
    amortizationType: "Fixed",
    escrowType: "Not Waived",
    firstTimeHomeBuyer: false,
    firstTimeHomeInvestor: !s.experienceDeals || s.experienceDeals === 0,
    ruralProperty: s.ruralStatus === "rural",
    isMultipleProperties: false,
    decliningMarketProperty: false,
    isNewConstructionProperty: false,
    isPropertyInLeasableState: true,
    isShortTermRental: false,
    bankruptcy: "null-null-null",
    foreclosure: "null-null",
    deedInLieu: "null-null",
    shortSale: "null-null",
    mortgageLates: "0-0-30-12",
    forbearanceLoanModification: "null-null",
    secondLien: "0",
    monthsReserve: "6",
    proposedMonthlyRent: fmtMoney(s.rentEstimate),
    proposedMonthlyTaxes: fmtMoney(s.monthlyTaxes),
    proposedMonthlyInsurance: fmtMoney(s.monthlyInsurance),
    proposedMonthlyHoaDues: fmtMoney(s.monthlyHoa),
    floodInsurance: "0",
    schoolTax: "0",
    otherTax: "0",
    borrowerFirstName: s.guarantorFirstName || "",
    borrowerLastName: s.guarantorLastName || "",
    estimatedCreditScore: String(s.creditScore),
    propertyState: s.propertyState || "",
    subjectPropertyAddress: s.propertyAddress || "",
    email: "",
    showSubPrograms: false,
    changedLoanDetails: [],
  };
  // Purchase and Refinance are different forms on NextRes's own DSCR Quick
  // Quote -- confirmed live 2026-10-01 against a real cash-out refi
  // scenario. Purchase asks for a purchase price and an escrow repair
  // holdback; Refinance drops those and asks for the existing lien payoff
  // and whether the property's been listed for sale recently instead.
  if (isPurchase) {
    body.propertyPurchasePrice = fmtMoney(s.purchasePrice);
    body.escrowRepairHoldback = "0";
  } else {
    body.lienPayoff = fmtMoney(s.currentLoanBalance);
    body.propertyHasBeenListed = false;
  }
  return callNextresPriceLoan(body, assumptions);
}

// ---------------------------------------------------------------------
// Kiavi -- researched MODEL, not a live call. Joe (2026-10-06): no automated
// logins at Kiavi. Every number below was pulled from Kiavi's own broker
// pricer on 2026-10-06 with the TBD placeholder entity/guarantor (a
// first-time, non-"pro" profile); raw data and notes live in
// Documents\Bridgepoint Pricing Research\kiavi. Kiavi prices experience off
// the guarantor profile, not an input, so these are first-time-investor
// terms: an experienced borrower prices the same or better.
// Fix & flip / bridge is a fixed grid (stable). Rental (DSCR) behaves like
// a daily rate sheet, so KIAVI_RENTAL_* needs re-pulling when rates move.
// The block between the BEGIN/END markers is plain JS on purpose so the
// accuracy test can run this exact code in a browser against Kiavi's pricer.
// ---------------------------------------------------------------------
// BEGIN KIAVI MODEL
const KIAVI_SNAPSHOT = "2026-10-06";
const KIAVI_BROKER_NOT_APPROVED = ["AZ","CA","ID","MN","NC","ND","NE","NJ","NV","NY","OR","SD","UT","VT"];
const KIAVI_MAX_BROKER_POINTS = 3;
// Minimum loan on bridge and fix & flip. Joe heard $75,000 on 10/6, but Kiavi's own
// engine still rejects under $100,000 ("Full Loan Amount ... must be at least
// $100,000", tested 2026-10-07), so the pricer follows the engine.
const KIAVI_MIN_LOAN = 100000;
// Kiavi broker guides (kiavi.com/broker-guide, read 2026-10-06): YSP up to 2.00% on
// fix & flip / bridge, up to 1.00% on rentals.
const KIAVI_MAX_YSP = 2.0;
const KIAVI_MAX_YSP_RENTAL = 1.0;
// 12-month fix & flip rate by FICO tier x loan-to-cost tier (<=75, <=80, <=85, <=90).
const KIAVI_HM_LTC_TIERS = [75, 80, 85, 90];
const KIAVI_HM_GRID = {
  "760": [9.24, 10.00, 11.00, 11.50],
  "700": [9.70, 10.50, 11.50, 12.24],
  "680": [10.00, 11.00, 12.00, 13.24],
};
const KIAVI_HM_TERM_ADDER = { 12: 0, 18: 0.75, 24: 1.00 };
// Experienced ("Pro", 3+ flips) borrowers -- pulled 2026-10-07 from Kiavi's own pricing
// query (HardMoneyLoanScenarioResults) on a Pro TEST draft vs a first-time TEST draft,
// identical inputs. First-time grid above matched Kiavi exactly; Pro prices 1.25-2.3 lower.
// Kiavi's 4 experience answers collapse to 2 tiers (verified 2026-10-07 on TEST drafts for
// each answer): None and 1-2 flips = first-time grid; 3-4 and 5+ = Pro grid (identical).
const KIAVI_HM_GRID_PRO = {
  "760": [8.50, 8.75, 8.95, 9.25],
  "700": [8.75, 9.25, 9.75, 9.95],
  "680": [9.50, 9.95, 10.50, 11.25],
};
const KIAVI_HM_TERM_ADDER_PRO = { 12: 0, 18: 0.50, 24: 1.00 };
const KIAVI_PRO_MIN_DEALS = 3;
// Bridge (no rehab), 12-month, by % of as-is value: <=65 / <=70 / <=75%.
// Max 70% under a 720 FICO, 75% at 720+ (first-time and Pro alike).
// Re-measured 2026-10-07 on Kiavi's pricing query (the first pass had 75% at 700+, wrong).
const KIAVI_BRIDGE = {
  first: { "760": { 65: 10.00, 70: 10.50, 75: 11.00 }, "720": { 65: 10.50, 70: 11.00, 75: 11.50 }, "700": { 65: 10.50, 70: 11.00 }, "680": { 65: 11.00, 70: 11.70 } },
  pro:   { "760": { 65: 8.95, 70: 9.50, 75: 10.25 },   "720": { 65: 9.50, 70: 9.95, 75: 10.75 },   "700": { 65: 9.50, 70: 9.95 },   "680": { 65: 9.95, 70: 10.50 } },
};
function kiaviBridgeTier(f) { return f >= 760 ? "760" : f >= 720 ? "720" : f >= 700 ? "700" : f >= 680 ? "680" : null; }
// Rental (DSCR) -- rebuilt 2026-10-07 from Kiavi's own pricing query
// (RentalLoanScenarioResults). Kiavi prices in points: each rate has a price on
// one ladder, the deal's adjustments (LLPAs) add up to a cost in points, and
// the par rate is the lowest rate whose price covers that cost (plus any YSP).
// LLPAs are by LTV tier (<=50/55/60/65/70/75/80): FICO base, prepay (3 yr = 0),
// property type, loan size (<150k / <250k / base), DSCR (<1.00 / <1.10 / <1.15
// / base) and cash-out. Least-squares fit on 785 live quotes: 97.5% exact rate
// on held-out deals (5-fold), 99.7% within 1/8, 100% exact in the 80% tier. The 60% tier
// was then re-measured directly (one factor at a time) because the fit left it noisy.
// Other products are the 30-yr fixed's price plus a flat adjustment (zero
// variance in 186 quotes): 5/1 ARM -0.375, 7/1 ARM -0.25, interest-only
// +0.25 (<=60% LTV) / +0.50 (65-70%) / +0.625 (75%); IO stops at 75% LTV.
// Rules from Kiavi's engine: min loan $100,000, max $1,500,000, FICO 660+,
// DSCR 0.80+, max LTV 65% (FICO <680 or DSCR <1.00) / 70% (680-699) / 75%
// (700+) / 80% (700+, SFR purchase, DSCR >= 1.10); max loan floors to $250;
// cash-out max $500,000 cash in hand; rate floor 7.125%. Rate/term refis
// (no cash out) price as purchases; any cash out takes the cash-out LLPA;
// seasoning doesn't change price. The ladder moves with Kiavi's rate sheet --
// re-pull it (research\kiavi\rental_model_2026-10-07.json has the method).
const KIAVI_RENTAL_SNAPSHOT = "2026-10-07";
const KIAVI_RENTAL_LADDER = {"7.125":-0.68,"7.25":0,"7.375":0.6175,"7.5":1.2331,"7.625":1.9931,"7.75":2.2897,"7.875":2.662,"8":3.037,"8.25":3.5648,"8.375":3.9388,"8.5":4.2495,"8.625":4.562,"8.75":4.8745,"8.875":5.1188,"9":5.367,"9.125":5.617,"9.25":5.867,"9.375":6.117,"9.5":6.2988,"9.625":6.4845,"9.75":6.672,"9.875":6.8595,"10":7.047,"10.125":7.2345};
const KIAVI_RENTAL_LLPA = {"B|660|50":0.951,"B|660|55":1.201,"B|660|60":1.326,"B|660|65":1.576,"B|680|50":0.7009,"B|680|55":0.826,"B|680|60":1.076,"B|680|65":1.326,"B|680|70":1.951,"B|700|50":-0.0491,"B|700|55":0.0759,"B|700|60":0.201,"B|700|65":0.5759,"B|700|70":0.826,"B|700|75":1.576,"B|700|80":3.451,"B|720|50":-0.5491,"B|720|55":-0.2991,"B|720|60":-0.174,"B|720|65":0.2009,"B|720|70":0.3259,"B|720|75":1.076,"B|720|80":2.326,"B|740|50":-0.5491,"B|740|55":-0.2991,"B|740|60":-0.174,"B|740|65":-0.0491,"B|740|70":0.0759,"B|740|75":0.951,"B|740|80":1.701,"B|760|50":-0.6741,"B|760|55":-0.4241,"B|760|60":-0.299,"B|760|65":-0.1741,"B|760|70":-0.0491,"B|760|75":0.826,"B|760|80":1.576,"B|780|50":-0.6741,"B|780|55":-0.4241,"B|780|60":-0.299,"B|780|65":-0.1741,"B|780|70":-0.0491,"B|780|75":0.826,"B|780|80":1.576,"B|800|50":-0.6741,"B|800|55":-0.4241,"B|800|60":-0.299,"B|800|65":-0.1741,"B|800|70":-0.0491,"B|800|75":0.826,"B|800|80":1.576,"d|da|50":0.75,"d|da|55":0.75,"d|da|60":1.25,"d|da|65":1.25,"d|db|50":0.25,"d|db|55":0.25,"d|db|60":0.25,"d|db|65":0.25,"d|db|70":0.5,"d|db|75":0.5,"d|dc|50":0.25,"d|dc|55":0.25,"d|dc|60":0.25,"d|dc|65":0.25,"d|dc|70":0.25,"d|dc|75":0.25,"d|dc|80":0.25,"pp|0|50":1,"pp|0|55":1,"pp|0|60":1,"pp|0|65":1,"pp|0|70":1,"pp|0|75":1,"pp|0|80":1,"pp|1|50":0.75,"pp|1|55":0.75,"pp|1|60":0.75,"pp|1|65":0.75,"pp|1|70":0.75,"pp|1|75":0.75,"pp|1|80":0.75,"pp|2|50":0.5,"pp|2|55":0.5,"pp|2|60":0.5,"pp|2|65":0.5,"pp|2|70":0.5,"pp|2|75":0.5,"pp|2|80":0.5,"pp|5|50":-0.5,"pp|5|55":-0.5,"pp|5|60":-0.5,"pp|5|65":-0.5,"pp|5|70":-0.5,"pp|5|75":-0.5,"pp|5|80":-0.5,"pt|2-4plex|50":0.375,"pt|2-4plex|55":0.375,"pt|2-4plex|60":0.5,"pt|2-4plex|65":0.5,"pt|2-4plex|70":0.625,"pt|2-4plex|75":0.875,"pt|condo|50":0,"pt|condo|55":0,"pt|condo|60":0,"pt|condo|65":0,"pt|condo|70":0.125,"pt|condo|75":0.375,"refi|50":0.25,"refi|55":0.25,"refi|60":0.375,"refi|65":0.375,"refi|70":0.625,"refi|75":0.875,"z|z1|50":1,"z|z1|55":1,"z|z1|60":1,"z|z1|65":1,"z|z1|70":1,"z|z1|75":1,"z|z1|80":1,"z|z2|50":0.25,"z|z2|55":0.25,"z|z2|60":0.25,"z|z2|65":0.25,"z|z2|70":0.25,"z|z2|75":0.25,"z|z2|80":0.25};
const KIAVI_RENTAL_PRODUCT_ADJ = { fixed: 0, arm5: -0.375, arm7: -0.25 };
function kiaviRentalIoAdj(ltvTier) { return ltvTier <= 60 ? 0.25 : ltvTier <= 70 ? 0.5 : 0.625; }
const KIAVI_RENTAL_MIN_LOAN = 100000;
const KIAVI_RENTAL_MAX_LOAN = 1500000;
const KIAVI_RENTAL_MAX_CASHOUT = 500000;
// 1e-7 slack: floating-point division can put an exact boundary loan (e.g. 55.0000001%) in the next tier.
function kiaviRentalLtvTier(l) { l = l - 1e-7; return l <= 50 ? 50 : l <= 55 ? 55 : l <= 60 ? 60 : l <= 65 ? 65 : l <= 70 ? 70 : l <= 75 ? 75 : 80; }
// Total LLPA in points for one deal (null if Kiavi has no price for that combination).
function kiaviRentalCost(fico, ltv, ppYears, unit, loan, dscr, cashOut) {
  const t = kiaviRentalLtvTier(ltv);
  const ft = fico >= 800 ? 800 : fico >= 780 ? 780 : fico >= 760 ? 760 : fico >= 740 ? 740 : fico >= 720 ? 720 : fico >= 700 ? 700 : fico >= 680 ? 680 : 660;
  const base = KIAVI_RENTAL_LLPA["B|" + ft + "|" + t];
  if (base == null) return null;
  let c = base;
  if (ppYears !== 3) c += KIAVI_RENTAL_LLPA["pp|" + ppYears + "|" + t] || 0;
  if (unit !== "single-family") c += KIAVI_RENTAL_LLPA["pt|" + unit + "|" + t] || 0;
  const z = loan < 150000 ? "z1" : loan < 250000 ? "z2" : null;
  if (z) c += KIAVI_RENTAL_LLPA["z|" + z + "|" + t] || 0;
  const d = dscr < 1.0 ? "da" : dscr < 1.1 ? "db" : dscr < 1.15 ? "dc" : null;
  if (d) c += KIAVI_RENTAL_LLPA["d|" + d + "|" + t] || 0;
  if (cashOut) c += KIAVI_RENTAL_LLPA["refi|" + t] || 0;
  return c;
}
// Lowest ladder rate whose price covers the cost plus any YSP taken (points).
function kiaviRentalRateFor(cost, ysp) {
  const rungs = Object.keys(KIAVI_RENTAL_LADDER).map(Number).sort(function (a, b) { return a - b; });
  for (const r of rungs) if (KIAVI_RENTAL_LADDER[String(r)] - cost >= (ysp || 0) - 1e-6) return r;
  return null;
}
const KIAVI_STATE_ADJ_HM = { TX: -0.5 };
const KIAVI_STATE_ADJ_HM_PRO = { TX: -0.25 };

function kiaviUnit(pt) {
  if (pt === "SFR") return "single-family";
  if (pt === "Duplex" || pt === "2-4 Unit") return "2-4plex";
  if (pt === "Condo") return "condo";
  if (pt === "Multifamily 5+") return "multifamily";
  return null; // Mixed-Use, Land: Kiavi doesn't lend on these
}
function kiaviTerm(months) {
  const m = months || 12;
  if (m <= 12) return 12;
  if (m <= 18) return 18;
  if (m <= 24) return 24;
  return null;
}
// Kiavi's own origination fee (its pricing query, 2026-10-07): first-time $3,500 under
// $150k else 1%; experienced (Pro) the greater of $1,500 or 1%.
function kiaviHmFee(loan, pro) { return pro ? Math.max(1500, Math.round(loan * 0.01)) : (loan < 150000 ? 3500 : Math.round(loan * 0.01)); }
// Kiavi: our points + Kiavi's points can't exceed 5% of the loan.
function kiaviHmMaxBrokerPts(loan, pro) { return Math.max(0, Math.min(KIAVI_MAX_BROKER_POINTS, Math.floor((5 - kiaviHmFee(loan, pro) / loan * 100) * 100) / 100)); }
function kiaviHmFicoTier(f) { return f >= 760 ? "760" : f >= 700 ? "700" : f >= 680 ? "680" : null; }
function kiaviRound8(r) { return Math.round(r * 8) / 8; }

// Plain-object version used by the edge function and the accuracy test.
// Returns { eligible, reason, options:[{program, rate, price, loanAmount}], maxLoanAmount, fees, assumptions }.
function kiaviPrice(s) {
  const L = "Kiavi";
  const out = { lender: L, eligible: false, source: "model", assumptions: [], compCaps: { maxBrokerPoints: KIAVI_MAX_BROKER_POINTS, maxYsp: KIAVI_MAX_YSP } };
  const st = (s.propertyState || "").toUpperCase();
  if (!st) { out.reason = "Needs the property state."; return out; }
  if (KIAVI_BROKER_NOT_APPROVED.indexOf(st) !== -1) { out.reason = "Bridgepoint isn't approved with Kiavi in " + st + "."; return out; }
  if (s.citizenshipStatus === "Foreign National" || s.citizenshipStatus === "ITIN") { out.reason = s.citizenshipStatus + " borrowers aren't modeled for Kiavi — price directly with Kiavi."; return out; }
  // kiavi.com FAQ (read 2026-10-07): entities only; SFR, PUD, 2-4plex, condo (not FL) and manufactured;
  // no mixed-use, commercial, mobile homes, 5+ units, or rural (agricultural-zoned / 4+ acres).
  if ((s.entityType || "LLC") === "Individual") { out.reason = "Kiavi only lends to business entities (LLC/Corp) — not individuals."; return out; }
  if (s.propertyType === "Multifamily 5+") { out.reason = "Kiavi lends on 1-4 units only (no 5+ multifamily)."; return out; }
  if (s.ruralStatus === "rural") { out.reason = "Kiavi doesn't lend on rural properties (agricultural-zoned / 4+ acres)."; return out; }
  const unit = kiaviUnit(s.propertyType);
  if (!unit) { out.reason = "Kiavi doesn't lend on " + s.propertyType + " properties."; return out; }
  if (!s.creditScore) { out.reason = "Needs a credit score."; return out; }
  if (s.loanType === "Ground Up Construction") { out.reason = "Kiavi new construction isn't modeled yet — price it on Kiavi directly."; return out; }
  if (s.loanType === "DSCR") return kiaviRental(s, out, unit, st);
  return kiaviHm(s, out, unit, st);
}

function kiaviHm(s, out, unit, st) {
  const tier = kiaviHmFicoTier(s.creditScore);
  if (!tier) { out.reason = "Kiavi needs at least a 680 credit score on fix & flip/bridge (first-time investor)."; return out; }
  if (unit === "condo" && st === "FL") { out.reason = "Kiavi doesn't finance condos in Florida."; return out; }
  const term = kiaviTerm(s.termMonths);
  if (!term) { out.reason = "Kiavi's bridge terms are 12, 18 or 24 months."; return out; }
  const refi = s.transactionType !== "purchase";
  if (refi) out.assumptions.push("Priced as an unseasoned refinance (Kiavi has paused brokered seasoned refis).");
  // Unseasoned refi: Kiavi sizes leverage (LTC, as-is LTV, the 35% holdback cap)
  // off the ORIGINAL purchase price, not today's value (accuracy test 2026-10-07:
  // "Loan-To-Cost is 94%" = initial / purchase price). Use the lower of the two.
  const basis = refi
    ? ((s.purchasePrice && s.currentValue) ? Math.min(s.purchasePrice, s.currentValue) : (s.purchasePrice || s.currentValue))
    : s.purchasePrice;
  if (!basis) { out.reason = refi ? "Needs the original purchase price (or current value)." : "Needs the purchase price."; return out; }
  if (refi && s.purchasePrice && s.currentValue && s.currentValue > s.purchasePrice) out.assumptions.push("Unseasoned refi: Kiavi sizes off the $" + Math.round(s.purchasePrice).toLocaleString("en-US") + " purchase price, not the $" + Math.round(s.currentValue).toLocaleString("en-US") + " current value.");
  if (refi && !s.purchasePrice) out.assumptions.push("No purchase price on file: sized off current value. Kiavi uses the original purchase price on unseasoned refis, so this may be high.");
  // Experience: Kiavi prices "Pro" borrowers (3+ completed flips) on a separate, lower grid.
  const deals = Number(s.experienceDeals || 0);
  const pro = deals >= KIAVI_PRO_MIN_DEALS;
  const grid = pro ? KIAVI_HM_GRID_PRO : KIAVI_HM_GRID;
  const stateAdj = (pro ? KIAVI_STATE_ADJ_HM_PRO[st] : KIAVI_STATE_ADJ_HM[st]) || 0;
  const termAdj = (pro ? KIAVI_HM_TERM_ADDER_PRO : KIAVI_HM_TERM_ADDER)[term];
  out.assumptions.push(pro ? ("Priced on Kiavi's experienced-investor (Pro) grid: " + deals + " completed deals.")
    : deals > 0 ? ("Priced as first-time investor: Kiavi's lower Pro pricing starts at " + KIAVI_PRO_MIN_DEALS + " completed flips (file shows " + deals + ").")
    : "Priced as first-time investor (no completed deals on file). 3+ flips gets Kiavi's Pro pricing, 1.25-2.3% lower.");
  const rehab = s.loanType === "Bridge" ? 0 : (s.rehabBudget || 0);
  const opts = [];
  if (rehab <= 0) {
    // Bridge (no rehab): <=65 / <=70 / <=75% of as-is (75% only at 720+).
    const tbl = KIAVI_BRIDGE[pro ? "pro" : "first"][kiaviBridgeTier(s.creditScore)];
    const tiers = Object.keys(tbl).map(Number).sort(function (a, b) { return b - a; });
    for (const t of tiers) {
      const amt = Math.min(Math.floor(basis * t / 100 / 100) * 100, 1000000);
      if (amt < KIAVI_MIN_LOAN) continue;
      const rate = Math.round((tbl[t] + termAdj + stateAdj) * 100) / 100;
      opts.push({ program: term + "-mo bridge · " + t + "% of value", rate, price: 100 + kiaviHmFee(amt, pro) / amt * 100, loanAmount: amt });
    }
    if (!opts.length) { out.reason = "Below Kiavi's $100,000 minimum loan at " + tiers[tiers.length - 1] + "% of value."; return out; }
    if (basis * tiers[0] / 100 > 1000000) out.assumptions.push("Capped at Kiavi's $1,000,000 maximum.");
  } else {
    if (!s.arv) { out.reason = "Needs the after-repair value."; return out; }
    // Rehab Kiavi will fund: $300k max, and 35% of the purchase price under a
    // 720 FICO (accuracy test 2026-10-06: "Loan Holdback Amount ... must be no
    // more than" exactly 35% of purchase at 685-705; 725+ funded 40-55%).
    // Under 720 the cap is also $200,000 (test #2: "Rehab Cost ... must be no more than $200,000" at 698).
    let funded = Math.min(rehab, s.creditScore < 720 ? 200000 : 300000);
    if (s.creditScore < 720) funded = Math.min(funded, basis * 0.35);
    (out as LenderResult).rehabHoldback = Math.round(funded);
    if (funded < rehab) out.assumptions.push("Kiavi funds $" + Math.round(funded).toLocaleString("en-US") + " of the $" + Math.round(rehab).toLocaleString("en-US") + " rehab" + (s.creditScore < 720 ? " (35% of purchase / $200k max under a 720 credit score)" : " ($300k max)") + "; the borrower covers the rest.");
    // 2-4 units: 85% max at 700+, 80% under 700.
    const capTier = unit === "2-4plex" ? (s.creditScore >= 700 ? 85 : 80) : 90;
    const arvCap = s.arv * 0.75;
    for (let i = KIAVI_HM_LTC_TIERS.length - 1; i >= 0; i--) {
      const t = KIAVI_HM_LTC_TIERS[i];
      if (t > capTier) continue;
      let initial = basis * t / 100;
      let total = initial + funded;
      if (total > arvCap) { total = arvCap; initial = total - funded; }
      if (initial <= 0) continue;
      total = Math.min(Math.floor(total / 100) * 100, 1000000);
      if (total < KIAVI_MIN_LOAN) continue;
      const ltc = (total - funded) / basis * 100;
      let idx = KIAVI_HM_LTC_TIERS.findIndex(function (x) { return ltc <= x + 0.0001; });
      if (idx < 0) continue;
      const rate = Math.round((grid[tier][idx] + termAdj + stateAdj) * 100) / 100;
      if (opts.some(function (o) { return o.loanAmount === total; })) continue;
      opts.push({ program: term + "-mo · " + KIAVI_HM_LTC_TIERS[idx] + "% of " + (refi ? "value" : "purchase"), rate, price: 100 + kiaviHmFee(total, pro) / total * 100, loanAmount: total });
    }
    if (!opts.length) { out.reason = "Below Kiavi's $100,000 minimum loan or over 75% of ARV at every leverage tier."; return out; }
  }
  if (s.loanAmount) {
    // Caller asked for a specific amount: keep only the option at or under it.
    const fit = opts.filter(function (o) { return o.loanAmount <= s.loanAmount + 1; });
    if (fit.length) { opts.length = 0; Array.prototype.push.apply(opts, fit); }
  }
  opts.sort(function (a, b) { return b.loanAmount - a.loanAmount; });
  out.eligible = true;
  out.options = opts;
  out.loanAmountUsed = opts[0].loanAmount;
  out.maxLoanAmount = opts[0].loanAmount;
  out.fees = { lenderFee: kiaviHmFee(opts[0].loanAmount, pro) };
  out.compCaps.maxBrokerPoints = kiaviHmMaxBrokerPts(opts[0].loanAmount, pro);
  if (out.compCaps.maxBrokerPoints < KIAVI_MAX_BROKER_POINTS) out.assumptions.push("Kiavi caps total points (ours + theirs) at 5%: origination here can be at most " + out.compCaps.maxBrokerPoints + " points.");
  out.compCaps.yspRatePerPoint = 1; // fix & flip YSP is 1:1 (+1.00% rate pays 1 point)
  out.assumptions.push("Kiavi model " + KIAVI_SNAPSHOT + ", checked against Kiavi's own pricer 2026-10-07. Lower leverage = lower rate.");
  return out;
}

function kiaviRentalDscr(loan, rate, s, io) {
  const r = rate / 100 / 12;
  const pi = io ? loan * r : loan * r / (1 - Math.pow(1 + r, -360));
  const pitia = pi + (s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0);
  return pitia > 0 ? (s.rentEstimate || 0) / pitia : 0;
}
function kiaviRental(s, out, unit, st) {
  if (unit === "multifamily") { out.reason = "Kiavi's rental program doesn't take 5+ unit multifamily."; return out; }
  const fico = s.creditScore;
  if (fico < 660) { out.reason = "Kiavi rentals need at least a 660 credit score."; return out; }
  const purchase = s.transactionType === "purchase";
  const value = purchase ? Math.min(s.purchasePrice || Infinity, s.currentValue || Infinity) : (s.currentValue || s.purchasePrice);
  if (!value || !isFinite(value)) { out.reason = purchase ? "Needs the purchase price." : "Needs the current value."; return out; }
  if (!s.rentEstimate) { out.reason = "Needs the monthly rent to size a Kiavi rental."; return out; }
  const ppYears = ({ "5yr": 5, "4yr": 3, "3yr": 3, "2yr": 2, "1yr": 1, none: 0 })[s.prepayTerm || "5yr"];
  if (ppYears == null) { out.reason = "Unknown prepay term."; return out; }
  if (s.prepayTerm === "4yr") out.assumptions.push("Kiavi doesn't offer a 4-year prepay; priced at 3 years.");
  const payoff = s.currentLoanBalance;
  const hasPayoff = !purchase && payoff != null && payoff >= 0;
  if (!purchase && !hasPayoff) out.assumptions.push(s.transactionType === "cashout" ? "No payoff balance on file: priced as cash-out; Kiavi caps cash in hand at $500,000." : "No payoff balance on file: priced as rate/term (no cash out). Any cash out prices as cash-out on Kiavi.");
  // Max LTV for this deal at a given DSCR (Kiavi's engine, 2026-10-07).
  function capFor(dscr) {
    if (dscr < 0.8) return 0;
    if (dscr < 1.0 || fico < 680) return 65;
    if (fico < 700) return 70;
    return purchase && unit === "single-family" && dscr >= 1.1 ? 80 : 75;
  }
  // Price one loan amount. DSCR depends on the rate and the rate (via the DSCR
  // LLPA and the DSCR-based LTV cap) on the DSCR, so walk the ladder up and take
  // the lowest rate whose price covers the adjustments computed AT THAT RATE's
  // DSCR (iterating can flip-flop at a band edge and under-quote; caught in the
  // 10/7 fresh-deal test). Kiavi takes ONE DSCR for all products (its calculator
  // input), so IO and ARMs price off the 30-yr fixed's DSCR (fixedDscr); the
  // option still shows its own payment coverage.
  function priceAt(loan, adj, io, fixedDscr) {
    const ltv = loan / value * 100;
    const tier = kiaviRentalLtvTier(ltv);
    if (io && tier > 75) return null;
    const cashOut = !purchase && (hasPayoff ? loan > payoff + 0.5 : s.transactionType === "cashout");
    const extra = adj + (io ? kiaviRentalIoAdj(tier) : 0);
    const rungs = Object.keys(KIAVI_RENTAL_LADDER).map(Number).sort(function (a, b) { return a - b; });
    for (const r of rungs) {
      const own = kiaviRentalDscr(loan, r, s, io);
      const d = fixedDscr != null ? fixedDscr : own;
      if (tier > capFor(d)) continue;
      const cost = kiaviRentalCost(fico, ltv, ppYears, unit, loan, d, cashOut);
      if (cost == null) continue;
      if (KIAVI_RENTAL_LADDER[String(r)] - (cost + extra) >= -1e-6) return { rate: r, dscr: Math.round(own * 100) / 100, raw: own, cashOut };
    }
    return null;
  }
  const opts = [];
  const seen = {};
  let maxLoanFound = 0, capNote = "";
  for (const t of [80, 75, 70, 65, 60, 55, 50]) {
    let loan = Math.floor(value * t / 100 / 250 + 1e-9) * 250;
    if (loan > KIAVI_RENTAL_MAX_LOAN) { loan = KIAVI_RENTAL_MAX_LOAN; capNote = "Capped at Kiavi's $1,500,000 rental maximum."; }
    if (hasPayoff && loan > payoff + KIAVI_RENTAL_MAX_CASHOUT) { loan = Math.floor((payoff + KIAVI_RENTAL_MAX_CASHOUT) / 250) * 250; capNote = "Capped at Kiavi's $500,000 maximum cash out."; }
    if (s.loanAmount && loan > s.loanAmount) continue;
    if (loan < KIAVI_RENTAL_MIN_LOAN || seen[loan]) continue;
    const fx = priceAt(loan, KIAVI_RENTAL_PRODUCT_ADJ.fixed, false);
    if (!fx) continue;
    seen[loan] = true;
    const lt = kiaviRentalLtvTier(loan / value * 100);
    maxLoanFound = Math.max(maxLoanFound, loan);
    opts.push({ program: "30-yr fixed · " + lt + "% LTV", rate: fx.rate, price: 100, dscr: fx.dscr, loanAmount: loan });
    const io = priceAt(loan, KIAVI_RENTAL_PRODUCT_ADJ.fixed, true, fx.raw);
    if (io) opts.push({ program: "30-yr fixed IO · " + lt + "% LTV (IO)", rate: io.rate, price: 100, dscr: io.dscr, loanAmount: loan });
    if (loan === maxLoanFound) {
      const a7 = priceAt(loan, KIAVI_RENTAL_PRODUCT_ADJ.arm7, false, fx.raw), a5 = priceAt(loan, KIAVI_RENTAL_PRODUCT_ADJ.arm5, false, fx.raw);
      if (a7) opts.push({ program: "7/1 ARM · " + lt + "% LTV", rate: a7.rate, price: 100, dscr: a7.dscr, loanAmount: loan });
      if (a5) opts.push({ program: "5/1 ARM · " + lt + "% LTV", rate: a5.rate, price: 100, dscr: a5.dscr, loanAmount: loan });
    }
  }
  if (!opts.length) { out.reason = "No Kiavi rental tier fits: needs 660+ credit, DSCR 0.80+ (1.00+ above 65% LTV), and a $100,000-$1,500,000 loan."; return out; }
  out.eligible = true;
  out.options = opts;
  out.loanAmountUsed = maxLoanFound;
  out.maxLoanAmount = maxLoanFound;
  out.fees = { lenderFee: 0 };
  out.compCaps.yspRatePerPoint = 0.25; // rental YSP is price-based: about +0.125-0.25% rate per point
  out.compCaps.maxYsp = KIAVI_MAX_YSP_RENTAL;
  if (capNote) out.assumptions.push(capNote);
  out.assumptions.push("Kiavi rental priced from Kiavi's own rate ladder and adjustments as of " + KIAVI_RENTAL_SNAPSHOT + " (97.5% exact rate on untested deals, 99.7% within 0.125%). No Kiavi origination fee on rentals.");
  const ageDays = (Date.now() - Date.parse(KIAVI_RENTAL_SNAPSHOT + "T12:00:00Z")) / 86400000;
  if (ageDays > 7) out.assumptions.unshift("Kiavi rental rates are " + Math.floor(ageDays) + " days old — Kiavi's rate sheet may have moved; confirm on Kiavi before quoting.");
  return out;
}// END KIAVI MODEL

// ---------------------------------------------------------------------
// A&D Mortgage DSCR -- researched MODEL (2026-10-06, Quick Pricer Pro via
// Joe's AIM login; raw data in Documents\Bridgepoint Pricing Research\ad).
// A&D prices off one base ladder: discount(rate) = AD_BASE[rate] - total
// adjustments, floored at a 2.5-point credit. Adjustments are additive in
// points by CLTV bucket (fitted on ~300 live quotes). Tested on 100 fresh
// quotes: US citizens/residents 93% eligibility, 94% exact par rate;
// foreign national / ITIN only 50% -> flagged as estimates.
// Compensation: Borrower Paid = broker charges points, any credit goes to
// the BORROWER. Lender Paid = A&D pays the broker 2.75% through the rate
// (every rate costs exactly 2.75 points more), no points on top.
// ---------------------------------------------------------------------
const AD_SNAPSHOT = "A&D rate sheet 10/06/26 09:04 AM ET";
const AD_LPC = 2.75;
const AD_MAX_CREDIT = 2.5;
const AD_FIT = {"fico":{"620":{"50":-3.5,"55":-3.5,"60":-4,"65":-4.25,"70":null,"75":null,"80":null},"640":{"50":-2.25,"55":-2.25,"60":-2.375,"65":-2.75,"70":-3.75,"75":null,"80":null},"660":{"50":-0.625,"55":-0.625,"60":-1.125,"65":-1.5,"70":-2.5,"75":-3.375,"80":null},"680":{"50":0,"55":0,"60":-0.125,"65":-0.875,"70":-1.5,"75":-2.5,"80":-4.5},"700":{"50":0.375,"55":0.375,"60":0.25,"65":0,"70":-0.5,"75":-1.125,"80":-2.875},"720":{"50":0.625,"55":0.625,"60":0.5,"65":0.25,"70":-0.125,"75":-0.5,"80":-1.625},"740":{"50":0.75,"55":0.75,"60":0.625,"65":0.5,"70":0.125,"75":-0.375,"80":-1.125},"760":{"50":0.875,"55":0.875,"60":0.75,"65":0.625,"70":0.375,"75":-0.125,"80":-0.875},"780":{"50":1,"55":1,"60":0.875,"65":0.75,"70":0.5,"75":0,"80":-0.625}},"B":{"6.75":1.75,"6.875":1,"6.99":0.375,"7.125":-0.375,"7.25":-1.125,"7.375":-1.75,"7.49":-2.375,"7.625":-2.75,"7.75":-3,"7.875":-3.25,"7.99":-3.5,"8.125":-3.625,"8.25":-3.75,"8.375":-3.875,"8.49":-4,"8.625":-4.125,"8.75":-4.25,"8.875":-4.375,"8.99":-4.5,"9.125":-4.625,"9.25":-4.75,"9.375":-4.875,"9.49":-5,"9.625":-5.125,"9.75":-5.25,"9.875":-5.375,"9.99":-5.5,"10.125":-5.625,"10.25":-5.75,"10.375":-5.875,"10.49":-6,"10.625":-6.125,"10.75":-6.25,"10.875":-6.375,"10.99":-6.5,"11.125":-6.625,"11.25":-6.75,"11.375":-6.875}};
// Eligibility (null = A&D doesn't offer that combination), measured in single-factor sweeps.
const AD_NOT_OFFERED: Record<string, number[]> = { // factor -> CLTV buckets not offered
  "d4": [80], "d5": [75, 80], "co": [80], "pt_condotel": [80], "c_fn": [80], "c_itin": [75, 80],
};
const AD_NO_STATES = ["HI"];
function adCltvBucket(c: number): number { return Math.min(80, Math.max(50, Math.ceil(c / 5) * 5)); }
function adFicoBucket(f: number): string { return String(Math.min(780, Math.max(620, Math.floor(f / 20) * 20))); }
function adAmtBand(a: number): string { return a < 100000 ? "a0" : a <= 1000000 ? "a1" : a <= 1500000 ? "a2" : a <= 2000000 ? "a3" : "a4"; }
function adDscrBand(d: number): string { return d >= 1.25 ? "d1" : d >= 1.10 ? "d2" : d >= 1.0 ? "d3" : d >= 0.75 ? "d4" : "d5"; }
type AdIn = { fico: number; cltv: number; dscr: number; ppp: string; purpose: string; pt: string; cit: string; amt: number; st: string };
function adKeys(s: AdIn): string[] {
  const c = adCltvBucket(s.cltv), k: string[] = [];
  const db = adDscrBand(s.dscr); if (db !== "d1") k.push(db + "|" + c);
  k.push("ppp_" + s.ppp);
  if (s.purpose === "cashout") k.push("co|" + c);
  if (s.pt !== "sfr") k.push("pt_" + s.pt + "|" + c);
  if (s.cit !== "us") k.push("c_" + s.cit + "|" + c);
  const ab = adAmtBand(s.amt); if (ab !== "a1") k.push(ab + "|" + c);
  if (s.st === "NY") k.push("ny|" + c);
  if (s.cit === "fn" && s.pt !== "sfr") k.push("fnpt|" + c);
  if (s.cit === "fn" && s.purpose !== "purchase") k.push("fnpu|" + c);
  return k;
}
// Daily snapshot written by the "ad-rate-refresh" scheduled task (Joe's
// logged-in A&D session in the Claude app). It replaces the base ladder (B)
// and the credit x CLTV grid (fico) when present; everything else stays the
// measured structure above. Cached per function instance for 10 minutes.
let adSnapCache: { at: number; B: any; fico: any; asOf: string | null; captured: string | null } | null = null;
async function adSnapshot() {
  if (adSnapCache && Date.now() - adSnapCache.at < 600000) return adSnapCache;
  let row: any = null;
  if (SUPABASE_URL_RCN && SERVICE_KEY_RCN) {
    const r = await fetch(SUPABASE_URL_RCN + "/rest/v1/lender_pricing_snapshots?lender=eq.ad&select=data,sheet_as_of,captured_at", { headers: { apikey: SERVICE_KEY_RCN, Authorization: "Bearer " + SERVICE_KEY_RCN } }).catch(() => null);
    if (r && r.ok) { const rows = await r.json().catch(() => []); row = rows && rows[0]; }
  }
  adSnapCache = { at: Date.now(), B: (row && row.data && row.data.B) || AD_FIT.B, fico: (row && row.data && row.data.fico) || AD_FIT.fico, asOf: row ? row.sheet_as_of : AD_SNAPSHOT, captured: row ? row.captured_at : null };
  return adSnapCache;
}
// A&D DSCR Matrix 10/01/2026: max loan amount by credit tier and HCLTV.
function adMaxLoan(fico: number, cltv: number, purpose: string): number {
  const tiers: Array<[number, number]> = purpose === "cashout"
    ? (fico >= 720 ? [[55, 3e6], [60, 2.5e6], [70, 2e6], [75, 1.5e6]]
      : fico >= 700 ? [[55, 3e6], [60, 2.5e6], [65, 2e6], [75, 1.5e6]]
      : fico >= 680 ? [[55, 2.5e6], [65, 2e6], [70, 1.5e6]]
      : [[65, 1e6]])
    : (fico >= 720 ? [[65, 3e6], [70, 2.5e6], [75, 2e6], [80, 1.5e6]]
      : fico >= 700 ? [[65, 2.5e6], [70, 2e6], [80, 1.5e6]]
      : fico >= 680 ? [[55, 2.5e6], [70, 2e6], [75, 1e6]]
      : fico >= 640 ? [[70, 1e6]]
      : [[65, 1e6]]);
  for (const [c, amt] of tiers) if (cltv <= c + 1e-9) return amt;
  return 0;
}
// Returns total adjustment in points, or null when A&D doesn't offer the scenario.
function adAdjust(s: AdIn, ficoGrid: any = AD_FIT.fico): number | null {
  const c = adCltvBucket(s.cltv);
  if (AD_NO_STATES.indexOf(s.st) !== -1) return null;
  const fb = ficoGrid[adFicoBucket(s.fico)];
  const base = fb ? fb[String(c)] : null;
  if (base == null) return null;
  const db = adDscrBand(s.dscr);
  if ((AD_NOT_OFFERED[db] || []).indexOf(c) !== -1) return null;
  if (s.purpose === "cashout" && AD_NOT_OFFERED.co.indexOf(c) !== -1) return null;
  if (s.cit !== "us" && (AD_NOT_OFFERED["c_" + s.cit] || []).indexOf(c) !== -1) return null;
  if (s.amt > 2500000 || (s.amt > 2000000 && c >= 75) || (s.amt > 1500000 && c >= 80)) return null;
  // Layered guideline "no"s found in testing (never contradicted in ~340 quotes).
  if (s.fico < 680 && (s.dscr < 1.0 || (s.purpose === "cashout" && s.cltv > 67) || s.pt === "rural")) return null;
  if (s.cit === "itin" && (s.cltv > 65 || s.fico < 700 || s.purpose === "cashout")) return null;
  if ((s.pt === "condo" || s.pt === "condotel") && s.dscr < 1.0) return null;
  // DSCR Matrix 10/01/2026 (admortgage.com/documents-forms), read 2026-10-07.
  if (s.cit === "np" && s.fico < 700) return null;                                   // non-permanent residents: 700 min
  if (s.purpose === "cashout" && ((s.dscr < 0.75 && s.cltv > 65) || (s.dscr < 1.0 && s.cltv > 70))) return null;
  if (s.amt > adMaxLoan(s.fico, s.cltv, s.purpose)) return null;
  let adj = base;
  for (const k of adKeys(s)) adj += adMain(k, s);
  if (s.fico < 680 && s.purpose === "cashout") adj -= 0.125;
  return Math.round(adj * 1000) / 1000;
}
// Every main adjustment was measured directly in single-factor sweeps
// (locked; the fitter is NOT allowed to move these). Only the foreign-
// national interaction terms (fnpt/fnpu) come from fitting. Condo pricing
// is worse in Florida (the sweeps ran in Tampa): FL condo -0.5/-0.75/-1,
// elsewhere -0.25/-0.5/-0.5 (fresh-quote test: US borrowers 96% exact).
function adMain(k: string, s: AdIn): number {
  const [a, cs] = k.split("|"); const c = Number(cs);
  if (a.startsWith("ppp_")) return ({ none: -1.5, "6m": -1.25, "1yr": -1, "2yr": -0.5, "3yr": 0, "4yr": 0.25, "5yr": 0.375 } as Record<string, number>)[a.slice(4)] || 0;
  if (a === "pt_condo") return s.st === "FL" ? (c <= 70 ? -0.5 : c <= 75 ? -0.75 : -1) : (c <= 70 ? -0.25 : -0.5);
  if (a === "fnpt" || a === "fnpu") { const v = (AD_FN_INTERACT as any)[k]; return v != null ? v : 0; }
  const t: Record<string, (c: number) => number> = {
    d2: () => -0.25, d3: () => -0.25, d4: (c) => c <= 60 ? -1.25 : c <= 65 ? -1.5 : c <= 70 ? -1.625 : -1.75, d5: (c) => c <= 55 ? -1.75 : c <= 60 ? -2 : c <= 65 ? -2.125 : -2.25,
    co: (c) => c <= 60 ? -0.375 : c <= 65 ? -0.5 : c <= 70 ? -0.75 : -0.875,
    "pt_2-4": (c) => c <= 55 ? -0.375 : c <= 75 ? -0.5 : -0.75, "pt_rural": (c) => c <= 70 ? -0.5 : c <= 75 ? -0.625 : -0.75, "pt_pud": () => 0,
    c_np: () => -1, c_fn: (c) => c <= 65 ? -2.125 : c <= 70 ? -2 : -2.75, c_itin: () => -2,
    a0: () => -0.25, a2: () => 0, a3: (c) => c >= 75 ? -0.25 : 0, a4: () => -0.25, ny: (c) => c >= 75 ? -0.25 : 0,
  };
  return t[a] ? t[a](c) : 0;
}
const AD_FN_INTERACT = { "fnpu|50": 0.125, "fnpt|75": -0.25, "fnpt|50": 0.125, "fnpu|70": 0.25, "fnpt|55": 0.125 };
function adLadder(adj: number, lenderPaid: boolean, B: any = AD_FIT.B): Array<[number, number]> {
  return Object.entries(B).map(([r, b]) => [Number(r), Math.max(-AD_MAX_CREDIT, Math.round(((b as number) - adj) * 1000) / 1000) + (lenderPaid ? AD_LPC : 0)] as [number, number]).sort((a, b) => a[0] - b[0]);
}
// Weekdays (Eastern) between the snapshot and today: Friday's sheet on Monday = 1.
function adBusinessDaysOld(captured: string | null): number | null {
  if (!captured) return null;
  const etDate = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const a = etDate(new Date(captured)), b = etDate(new Date());
  a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
  let n = 0;
  for (const d = new Date(a); d < b; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
function adMonthlyPI(loan: number, rate: number): number { const r = rate / 100 / 12; return loan * r / (1 - Math.pow(1 + r, -360)); }

async function checkAD(s: Scenario): Promise<LenderResult> {
  const L = "A&D Mortgage";
  if (s.loanType !== "DSCR") return { lender: L, eligible: false, reason: "A&D is only set up for DSCR rentals in this pricer." };
  const pt = s.propertyType === "SFR" ? "sfr" : s.propertyType === "Condo" ? "condo" : (s.propertyType === "2-4 Unit" || s.propertyType === "Duplex") ? "2-4" : null;
  if (!pt) return { lender: L, eligible: false, source: "model", reason: "A&D's DSCR program doesn't take " + s.propertyType + " properties." };
  const cit = s.citizenshipStatus === "Foreign National" ? "fn" : s.citizenshipStatus === "ITIN" ? "itin" : s.citizenshipStatus === "Non-Permanent Resident" ? "np" : "us";
  if (!s.creditScore || s.creditScore < 620) return { lender: L, eligible: false, source: "model", reason: "A&D needs at least a 620 credit score." };
  // Scenario-runner rule (Joe 10/7): A&D foreign-national / ITIN pricing only matched A&D 32-50% of the
  // time in testing, so no price is shown until it's re-measured -- confirm those on AIM.
  if (cit === "fn" || cit === "itin") return { lender: L, eligible: false, source: "model", reason: "A&D " + (cit === "fn" ? "foreign-national" : "ITIN") + " pricing isn't verified to our accuracy bar yet — price it on A&D's AIM pricer." };
  const refi = s.transactionType !== "purchase";
  const value = refi ? (s.currentValue || s.purchasePrice) : Math.min(s.purchasePrice || Infinity, s.currentValue || Infinity);
  if (!value || !isFinite(value)) return { lender: L, eligible: false, source: "model", reason: refi ? "Needs the current value." : "Needs the purchase price." };
  if (!s.rentEstimate) return { lender: L, eligible: false, source: "model", reason: "Needs the monthly rent to size an A&D DSCR loan." };
  const pppAsked = ({ "5yr": "5yr", "3yr": "3yr", "2yr": "2yr", "1yr": "1yr", none: "none" } as Record<string, string>)[s.prepayTerm || "5yr"] || "5yr";
  const purpose = s.transactionType === "cashout" ? "cashout" : s.transactionType === "ratetermrefi" ? "rt" : "purchase";
  const st = (s.propertyState || stateFromAddress(s.propertyAddress) || "").toUpperCase();
  // A&D DSCR UW Requirements (9/11/2026): Philadelphia County is ineligible.
  const zip = (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(s.propertyAddress || "") || [])[1] || "";
  if (st === "PA" && /^191/.test(zip)) return { lender: L, eligible: false, source: "model", reason: "A&D doesn't lend in Philadelphia County." };
  // Bridgepoint holds no state licenses (Joe 2026-10-06: business-purpose only, most states
  // don't require one), so only A&D's "Eligible States Inv (No License Required)" list applies.
  const AD_NO_LICENSE_STATES = ["AK","AL","AR","CO","CT","DE","FL","GA","IA","IL","IN","KS","KY","LA","MA","MD","ME","MO","MS","MT","NC","NE","NH","NJ","NY","OH","OK","PA","RI","SC","TN","TX","WA","WI","WV","WY"];
  if (st && !AD_NO_LICENSE_STATES.includes(st)) return { lender: L, eligible: false, source: "model", reason: "A&D requires a broker license in " + st + " — Bridgepoint can't place A&D loans there." };
  if (st === "MD" && /\bBaltimore\b/i.test(s.propertyAddress || "")) return { lender: L, eligible: false, source: "model", reason: "A&D excludes Baltimore City and Baltimore County for unlicensed brokers." };
  // A&D state prepay rules (same document): no prepay (buydown required) in some states / below
  // some loan sizes; shorter caps in others. Returns the prepay A&D will actually allow.
  const yrs: Record<string, number> = { "5yr": 5, "3yr": 3, "2yr": 2, "1yr": 1, none: 0 };
  const units12 = s.propertyType !== "2-4 Unit" || (s as any).units == null || (s as any).units <= 2;
  const pppFor = (loan: number): string => {
    const individual = s.entityType === "Individual";
    if (["AK","AR","KS","MI","MN","NM","RI"].includes(st)) return "none";
    if ((st === "MD" || st === "VA") && loan < 75000) return "none";
    if (st === "OH" && units12 && loan < 116356) return "none";
    if (st === "PA" && units12 && loan < 329411) return "none";
    if (individual && ["IL","NJ","VT"].includes(st)) return "none";
    const cap = ["ID","MA","DC","MD"].includes(st) || (st === "IL") ? 3 : st === "MS" ? 2 : 5;
    if (yrs[pppAsked] > cap) return cap === 3 ? "3yr" : "2yr";
    return pppAsked;
  };
  const escrow = (s.monthlyTaxes || 0) + (s.monthlyInsurance || 0) + (s.monthlyHoa || 0);
  const snap = await adSnapshot();
  const ageDays = snap.captured ? (Date.now() - new Date(snap.captured).getTime()) / 86400000 : null;
  // Highest CLTV A&D will do on this deal: try 80 down to 50; DSCR depends on
  // the par rate, which depends on the DSCR band -- iterate twice.
  const tiers = s.loanAmount ? [Math.min(80, s.loanAmount / value * 100)] : [80, 75, 70, 65, 60, 55, 50];
  for (const cltv of tiers) {
    const loan = s.loanAmount || Math.floor(value * cltv / 100 / 500) * 500;
    if (loan < 75000) continue;
    let dscr = 1.3, adj: number | null = null, par = 0;
    const ppp = pppFor(loan);
    for (let i = 0; i < 3; i++) {
      adj = adAdjust({ fico: s.creditScore, cltv, dscr, ppp, purpose, pt, cit, amt: loan, st }, snap.fico);
      if (adj == null) break;
      const lad = adLadder(adj, false, snap.B);
      par = (lad.find((x) => x[1] <= 0) || lad[lad.length - 1])[0];
      dscr = (s.rentEstimate || 0) / (adMonthlyPI(loan, par) + escrow);
    }
    if (adj == null) continue;
    const bp = adLadder(adj, false, snap.B).filter((x) => x[1] <= 2.0 && x[1] >= -AD_MAX_CREDIT).slice(0, 7);
    const lp = adLadder(adj, true, snap.B).filter((x) => x[1] <= 2.0).slice(0, 5);
    const pmtD = (rate: number) => Math.round((s.rentEstimate || 0) / (adMonthlyPI(loan, rate) + escrow) * 100) / 100;
    const options = bp.map(([rate, d]) => ({ program: "30-yr fixed · Borrower Paid", rate, price: 100 - d, dscr: pmtD(rate), creditToBorrower: d < 0 }))
      .concat(lp.map(([rate, d]) => ({ program: "30-yr fixed · Lender Paid (A&D pays " + AD_LPC + "%)", rate, price: 100 - d, dscr: pmtD(rate), revenuePts: AD_LPC })));
    const assumptions = [
      "A&D model, rate sheet " + (snap.asOf || AD_SNAPSHOT) + (ageDays != null ? " (refreshed " + (ageDays < 1 ? "today" : Math.floor(ageDays) + " day(s) ago") + ")" : " (built-in snapshot)") + ". Long-term rental, no interest-only, 30-yr fixed (40-yr and 5/6 or 7/6 ARMs also available).",
      "Borrower Paid: your origination is on top, and any negative price is a lender credit to the BORROWER, not yield spread to us. Lender Paid: A&D pays Bridgepoint " + AD_LPC + "% through the rate; no origination points can be added.",
    ];
    if (ppp !== pppAsked) assumptions.unshift(ppp === "none" ? "A&D doesn't allow a prepay penalty here (" + st + (st === "OH" || st === "PA" || st === "MD" || st === "VA" ? " at this loan size" : "") + ") — priced with no prepay (buydown required)." : "A&D caps the prepay at " + ppp.replace("yr", " years") + " in " + st + " — priced that way.");
    // A&D "Fees Information" (wholesale, effective 12/26): Non-QM underwriting fee $1,595; plus
    // $80 tax service, $6.95 flood cert, $24.95 MERS (the CRM adds those as lender charges).
    const res: LenderResult = { lender: L, eligible: true, source: "model", options: options as any, loanAmountUsed: loan, maxLoanAmount: loan, assumptions, fees: { lenderFee: 1595 } };
    if (cit !== "us") { res.rateTolerance = 0.25; assumptions.unshift("Foreign national / ITIN pricing at A&D is only accurate to about 0.25% here — confirm with A&D."); }
    // A&D reprices every business day; the refresh job runs each weekday morning and fails
    // when the AIM login has expired. More than 1 business day old = flag it loudly.
    const bizOld = adBusinessDaysOld(snap.captured);
    if (bizOld == null || bizOld > 1) {
      res.rateTolerance = Math.max(res.rateTolerance || 0, 0.25);
      // LOs only see the plain warning; the login fix is for Joe/Fiore/Erika (Joe 2026-10-07:
      // LOs don't know what AIM is) -- the CRM shows staleFix only to them.
      res.staleWarning = "These rates are from " + (snap.captured ? new Date(snap.captured).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "an older rate sheet") + " and may have changed. Confirm before quoting.";
      res.staleFix = "The daily A&D rate refresh hasn't run — usually the AIM login expired. Log back into AIM so it can refresh.";
      assumptions.unshift(res.staleWarning);
    }
    return res;
  }
  return { lender: L, eligible: false, source: "model", reason: "No A&D DSCR tier fits (credit, leverage, DSCR, loan size, or a layered guideline like low credit with DSCR under 1.00)." };
}

async function checkKiavi(s: Scenario): Promise<LenderResult> {
  return kiaviPrice(s) as LenderResult;
}

// ---------------------------------------------------------------------
// RCN Capital -- LIVE, through RCN's own broker pricing tool (BLN Software,
// broker.commerciallendingservicesllc.com). Joe approved a server-side
// session for RCN (2026-10-06). Credentials come from the RCN_USERNAME /
// RCN_PASSWORD function secrets, which Joe enters himself. The session is
// cached in lender_sessions so we log in once, not per quote. Request and
// response formats are documented in
// Documents\Bridgepoint Pricing Research\rcn\request_templates.md.
// If the secrets aren't set or RCN can't be reached, this falls back to the
// researched RTL model below and says so.
// ---------------------------------------------------------------------
const RCN_BROKER = "https://broker.commerciallendingservicesllc.com";
const RCN_SECURE = "https://secure.commerciallendingservicesllc.com";
const RCN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const SUPABASE_URL_RCN = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY_RCN = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

type RcnSession = { cookies: Record<string, string>; csrf: string };
let rcnSessionMemo: RcnSession | null = null;

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}
function absorbCookies(jar: Record<string, string>, res: Response) {
  const raw: string[] = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
  raw.forEach((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
    if (/expires=Thu, 01-Jan-1970/i.test(c) || v === "deleted") delete jar[k]; else jar[k] = v;
  });
}
async function rcnFetch(jar: Record<string, string>, url: string, init: RequestInit = {}, hops = 8): Promise<{ res: Response; body: string; url: string }> {
  let cur = url;
  let opts: RequestInit = init;
  for (let i = 0; i < hops; i++) {
    const res = await fetch(cur, { ...opts, redirect: "manual", headers: { "User-Agent": RCN_UA, "Accept": "text/html,application/json,*/*", ...(opts.headers || {}), "Cookie": cookieHeader(jar) } });
    absorbCookies(jar, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      opts = { method: "GET" };
      continue;
    }
    return { res, body: await res.text(), url: cur };
  }
  throw new Error("RCN redirect loop");
}
async function rcnLoadStoredSession(): Promise<RcnSession | null> {
  if (!SUPABASE_URL_RCN || !SERVICE_KEY_RCN) return null;
  const r = await fetch(SUPABASE_URL_RCN + "/rest/v1/lender_sessions?lender=eq.rcn&select=session", { headers: { apikey: SERVICE_KEY_RCN, Authorization: "Bearer " + SERVICE_KEY_RCN } }).catch(() => null);
  if (!r || !r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows && rows[0] && rows[0].session ? rows[0].session as RcnSession : null;
}
async function rcnStoreSession(sess: RcnSession) {
  if (!SUPABASE_URL_RCN || !SERVICE_KEY_RCN) return;
  await fetch(SUPABASE_URL_RCN + "/rest/v1/lender_sessions", { method: "POST", headers: { apikey: SERVICE_KEY_RCN, Authorization: "Bearer " + SERVICE_KEY_RCN, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ lender: "rcn", session: sess, updated_at: new Date().toISOString() }) }).catch(() => null);
}
function rcnCsrfFrom(html: string, jar?: Record<string, string>): string | null {
  const pats = [
    // RCN's server-side sessions get an EMPTY token (var _csrfToken = '';) -- still valid.
    /_csrfToken\s*[=:]\s*['"]([^'"]*)['"]/,
    /name=["']_csrfToken["'][^>]*value=["']([^"']+)["']/,
    /value=["']([^"']+)["'][^>]*name=["']_csrfToken["']/,
    /<meta[^>]*name=["']csrf(?:-t|T)oken["'][^>]*content=["']([^"']+)["']/,
    /csrfToken["']?\s*[=:]\s*['"]([^'"]+)['"]/,
  ];
  for (const re of pats) { const m = re.exec(html); if (m) return m[1]; }
  // CakePHP also keeps the token in the csrfToken cookie.
  if (jar && jar.csrfToken) return decodeURIComponent(jar.csrfToken);
  return null;
}
async function rcnLogin(): Promise<RcnSession> {
  const user = Deno.env.get("RCN_USERNAME"), pass = Deno.env.get("RCN_PASSWORD");
  if (!user || !pass) throw new Error("not_configured");
  const jar: Record<string, string> = {};
  const page = await rcnFetch(jar, RCN_SECURE + "/members/login");
  const field = (name: string) => { const re = new RegExp('name="' + name.replace(/[\[\]]/g, "\\$&") + '"[^>]*value="([^"]*)"'); const m = re.exec(page.body); return m ? m[1] : ""; };
  const form = new URLSearchParams();
  form.set("_method", "POST");
  form.set("data[_Token][key]", field("data[_Token][key]"));
  form.set("data[Member][login]", user);
  form.set("data[Member][password]", pass);
  form.set("data[Member][rurl]", "");
  form.set("data[_Token][fields]", field("data[_Token][fields]"));
  form.set("data[_Token][unlocked]", field("data[_Token][unlocked]"));
  const post = await rcnFetch(jar, RCN_SECURE + "/members/login/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": RCN_SECURE + "/members/login" }, body: form.toString() });
  // Still on the login form = RCN rejected the username/password; surface RCN's own message.
  if (/MemberIndexForm/.test(post.body)) {
    const flash = /<div[^>]*(?:flash|alert|error|message)[^>]*>([\s\S]{0,300}?)<\/div>/i.exec(post.body);
    const msg = flash ? flash[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) : "";
    throw new Error("login_rejected" + (msg ? ": " + msg : ""));
  }
  const calc = await rcnFetch(jar, RCN_BROKER + "/pricing-tool/loan-calculator");
  const csrf = rcnCsrfFrom(calc.body, jar);
  if (csrf == null) throw new Error("login_failed (signed in, but no pricing-tool token; ended at " + new URL(calc.url).pathname + ", status " + calc.res.status + ", cookies: " + Object.keys(jar).join("/") + (/MemberIndexForm/.test(calc.body) ? ", page is a login form" : "") + ")");
  const sess = { cookies: jar, csrf };
  await rcnStoreSession(sess);
  return sess;
}
async function rcnSession(fresh = false): Promise<RcnSession> {
  if (!fresh && rcnSessionMemo) return rcnSessionMemo;
  if (!fresh) { const stored = await rcnLoadStoredSession(); if (stored) { rcnSessionMemo = stored; return stored; } }
  rcnSessionMemo = await rcnLogin();
  return rcnSessionMemo;
}
function formEncode(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  Object.entries(obj).forEach(([k, v]) => {
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (v !== null && typeof v === "object") formEncode(v as Record<string, unknown>, key, out);
    else out.append(key, v == null ? "" : String(v));
  });
  return out;
}
async function rcnCalculate(data: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sess = await rcnSession(attempt > 0);
    const r = await rcnFetch(sess.cookies, RCN_BROKER + "/pricing-tool/loan-calculator/calculate-loan?_=" + Math.random(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", "X-CSRF-Token": sess.csrf, "Accept": "application/json", "Referer": RCN_BROKER + "/pricing-tool/loan-calculator" },
      body: formEncode(data).toString(),
    }, 2);
    let j: any = null;
    try { j = JSON.parse(r.body); } catch (_) { j = null; }
    if (j && j.status) return j;
    rcnSessionMemo = null; // got a login page instead of JSON: session expired, log in again
  }
  throw new Error("session_expired");
}

const RCN_PROPERTY_TYPE: Record<string, string> = { "SFR": "6", "Duplex": "14", "2-4 Unit": "14", "Condo": "2", "Multifamily 5+": "9", "Mixed-Use": "8" };
const RCN_CITIZENSHIP: Record<string, string> = { "US Citizen": "0", "Foreign National": "1", "Permanent Resident": "2", "ITIN": "4" };
const RCN_PREPAY: Record<string, string> = { "5yr": "60", "3yr": "36", "2yr": "24", "1yr": "12", "none": "0" };
// RCN's overlays are zip-based; when the address has no zip, use the state's
// largest metro so at least the state rules apply (and say so).
const STATE_DEFAULT_ZIP: Record<string, string> = { AL:"35203",AK:"99501",AZ:"85004",AR:"72201",CA:"90012",CO:"80202",CT:"06103",DE:"19801",DC:"20001",FL:"33610",GA:"30303",HI:"96813",ID:"83702",IL:"60601",IN:"46204",IA:"50309",KS:"67202",KY:"40202",LA:"70112",ME:"04101",MD:"21202",MA:"02108",MI:"48226",MN:"55401",MS:"39201",MO:"64106",MT:"59101",NE:"68102",NV:"89101",NH:"03101",NJ:"07102",NM:"87102",NY:"10007",NC:"28202",ND:"58102",OH:"43215",OK:"73102",OR:"97204",PA:"19107",RI:"02903",SC:"29201",SD:"57104",TN:"37203",TX:"75201",UT:"84101",VT:"05401",VA:"23219",WA:"98104",WV:"25301",WI:"53202",WY:"82001" };
function zipFromAddress(a: string | null): string | null {
  const m = /\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(a || "");
  return m ? m[1] : null;
}
function rcnFlips(d: number | null): string { const n = d || 0; return n >= 10 ? "10" : n >= 5 ? "5" : n >= 3 ? "3" : n >= 1 ? "1" : "0"; }

function rcnBuildRequest(s: Scenario, assumptions: string[]): Record<string, unknown> | string {
  const isRtl = RTL_AUTO_LOAN_TYPES.includes(s.loanType);
  const program = s.loanType === "Fix & Flip" ? "1" : s.loanType === "Bridge" ? "2" : s.loanType === "Ground Up Construction" ? "5" : "3";
  const loanTypeId = s.transactionType === "cashout" ? "3" : s.transactionType === "ratetermrefi" ? "2" : "1";
  const pt = RCN_PROPERTY_TYPE[s.propertyType];
  if (!pt) return "RCN doesn't price " + s.propertyType + " in this tool.";
  let zip = zipFromAddress(s.propertyAddress);
  if (!zip) { zip = STATE_DEFAULT_ZIP[s.propertyState] || null; if (zip) assumptions.push("No zip on the address; priced with " + s.propertyState + " default zip " + zip + " (RCN has city-level overlays)."); }
  if (!zip) return "Needs the property zip code or state.";
  const asis = (s.transactionType !== "purchase" ? s.currentValue : (s.currentValue || s.purchasePrice)) || s.purchasePrice || 0;
  const base: Record<string, unknown> = {
    lender_pricing_program_id: program, lender_pricing_loan_type_id: loanTypeId, property_type_id: pt,
    mhv_exception: "0", rate_lock_type: "0", heavy_rehab_experience: "0", guc_experience: "0", commercial_experience: "0", residential_experience: "0",
    outstanding_mtg: "0", foreign_national: RCN_CITIZENSHIP[s.citizenshipStatus || "US Citizen"] || "0", credit_score: String(s.creditScore || ""), zipcode: zip,
    asis_value: asis.toFixed(2), as_stabilized_value: "0.00", purchase_price: (s.purchasePrice || asis).toFixed(2),
    estimated_payoff: (s.currentLoanBalance || 0).toFixed(2), interest_rate: "", loan_stage: "", property_expenses: "0.00",
    amount_requested: (s.loanAmount || 0).toFixed(2), exit_strategy: "", lender_a_points: 0, rehab_needed: "0",
    broker_points: String(s.pointsCharged || 0),
  };
  if (isRtl) {
    Object.assign(base, {
      loan_term: String([9, 12, 18].reduce((a, b) => Math.abs(b - (s.termMonths || 12)) < Math.abs(a - (s.termMonths || 12)) ? b : a, 12)),
      completed_flips: rcnFlips(s.experienceDeals), interest_type: "UPB", ir_selection: "", completed_rehab: "", soft_costs: "0.00", rehab_costs: "0.00",
      hard_costs: (s.loanType === "Bridge" ? 0 : (s.rehabBudget || 0)).toFixed(2), unit_count: s.propertyType === "2-4 Unit" || s.propertyType === "Duplex" ? "2" : "1",
      estimated_taxes: "0.00", flood_insurance: "0.00", hoa_dues: "0.00", sdira_loan: "0", tear_down: "0", construction_completion: "0", change_property: "0", property_alteration: "0",
      gross_rent: 0, gr_period: "M", markupIncluded: "1",
    });
    if (s.loanType === "Ground Up Construction") Object.assign(base, { acv: (s.arv || 0).toFixed(2), zero_ia: "0", entitlements: "1", full_plans: "1", approved_permits: "1" });
    else base.arv = (s.arv || asis).toFixed(2);
  } else {
    if (!s.rentEstimate) return "Needs the monthly rent.";
    Object.assign(base, {
      loan_term: "", completed_flips: "", interest_type: "", ir_selection: "", amortization_type: "FRM", prepayment_period: RCN_PREPAY[s.prepayTerm || "5yr"] || "60", io_period: "NOIO",
      completed_rehab: "0.00", hard_costs: "0.00", soft_costs: "0.00", rehab_costs: "0.00", unit_count: 1, broker_rebate: "0",
      estimated_taxes: String(Math.round((s.monthlyTaxes || 0) * 12)), insurance_premium: String(Math.round((s.monthlyInsurance || 0) * 12)), flood_insurance: "0", hoa_dues: String(Math.round((s.monthlyHoa || 0) * 12)),
      portfolio_properties: { units: { units: [{ leasing_status: "Leased (LTR)", actual_rent: s.rentEstimate, market_rent: s.rentEstimate }] } },
      vacant_units: 0, lease_type: "LTR", gross_rent: s.rentEstimate, gr_period: "M",
    });
  }
  return base;
}

function rcnParse(s: Scenario, j: any, assumptions: string[]): LenderResult {
  const L = "RCN Capital";
  const R = (j && j.results) || {};
  // No yield spread at RCN (Joe 2026-10-06: on fix & flip only Kiavi pays YSP;
  // RCN rental prices are all at or below par).
  const caps = { maxBrokerPoints: undefined, maxYsp: undefined };
  if (Array.isArray(R.pricings)) {
    // Rental: one entry per lender-points option.
    const opts = R.pricings.filter((p: any) => p && p.o_interest_rate).map((p: any) => ({
      program: "30-yr fixed · " + (Number(p.o_lender_points) * 100).toFixed(2) + " pts to RCN",
      rate: Math.round(p.o_interest_rate * 100000) / 1000,
      price: 100 - Number(p.o_lender_points) * 100,
      dscr: p.o_dscr != null ? Math.round(p.o_dscr * 100) / 100 : null,
    }));
    if (!opts.length) return { lender: L, eligible: false, source: "live", reason: (j && j.message && String(j.message).length > 3 ? j.message : "RCN returned no rental pricing for this scenario" + (s.propertyType === "Mixed-Use" ? " (RCN's rental program doesn't take this mixed-use scenario)." : ".")), assumptions };
    const max = R.pricings[0].o_max_loan_amount;
    // RCN "Product Fee Sheet – Long Term Rental" (Lender Documents): $1,995 closing fee (not NY),
    // plus $129 desktop review + $60 tax cert + $15 flood cert paid in processing.
    assumptions.push("RCN fees: $1,995 closing fee" + ((s.propertyState || "").toUpperCase() === "NY" ? " (NY differs — confirm)" : "") + "; $204 paid in processing (desktop review, tax and flood certs).");
    return { lender: L, eligible: true, source: "live", options: opts, loanAmountUsed: s.loanAmount || max, maxLoanAmount: max, assumptions, compCaps: caps, fees: { lenderFee: 1995 } };
  }
  if (!R.o_max_loan_amount || !R.o_interest_rate) {
    const why = (j && j.message && String(j.message).length > 3 ? j.message : "") || ((j && j.minimum && j.minimum.length) ? JSON.stringify(j.minimum) : "") || "RCN's pricer returned no terms (common reasons: credit under 650, or leverage/ARV limits).";
    return { lender: L, eligible: false, source: "live", reason: why, assumptions };
  }
  const ladder = (R.suggested_rates || []).map((x: any) => ({ program: "RCN " + (x.points * 100).toFixed(2) + " pts", rate: Math.round(x.rate * 100000) / 1000, price: 100 + x.points * 100 }));
  const adj = Object.values(R.ltv_adjustments || {}).flatMap((g: any) => Object.entries(g || {}).filter(([, v]) => v).map(([k, v]) => k + " " + v + "%"));
  if (adj.length) assumptions.push("RCN leverage adjustments applied: " + adj.join(", "));
  return {
    lender: L, eligible: true, source: "live", options: ladder.length ? ladder : [{ program: "RCN", rate: R.o_interest_rate * 100, price: 100 + (R.o_lender_points || 0) * 100 }],
    loanAmountUsed: R.o_loan_amount || R.o_max_loan_amount, maxLoanAmount: R.o_max_loan_amount,
    rehabHoldback: R.o_rehab_lender_fund != null && isFinite(Number(R.o_rehab_lender_fund)) ? Math.round(Number(R.o_rehab_lender_fund)) : undefined,
    // RCN "Product Fee Sheet – RTL": $1,995 closing fee when the calculator doesn't itemize it.
    fees: { lenderFee: (R.o_closing_fees || []).reduce((a: number, f: any) => a + Number(f.amount || 0), 0) || 1995 },
    assumptions, compCaps: caps,
  };
}

// Fallback when the live session isn't available: the RTL rules measured
// 2026-10-06 (Documents\Bridgepoint Pricing Research\rcn\01-02). Rentals and
// ground-up have no fallback model.
function rcnRtlModel(s: Scenario, assumptions: string[]): LenderResult {
  const L = "RCN Capital";
  const f = s.creditScore || 0;
  if (f < 650) return { lender: L, eligible: false, source: "model", reason: "RCN needs at least a 650 credit score.", assumptions };
  if (!s.purchasePrice) return { lender: L, eligible: false, source: "model", reason: "Needs the purchase price.", assumptions };
  const ft = f >= 700 ? 2 : f >= 680 ? 1 : 0;
  const e = s.experienceDeals || 0;
  const et = e >= 10 ? 3 : e >= 5 ? 2 : e >= 1 ? 1 : 0;
  const rates = [[11.49, 10.89, 10.39, 10.39], [11.14, 10.64, 10.14, 10.14], [10.89, 10.39, 9.89, 9.89]];
  const ltvs = [[75, 80, 85, 85], [80, 85, 90, 90], [85, 90, 95, f >= 720 ? 100 : 95]];
  const rehab = s.loanType === "Bridge" ? 0 : (s.rehabBudget || 0);
  let rate = rates[ft][et];
  let ltv = ltvs[ft][et];
  const ratio = rehab / s.purchasePrice;
  if (rehab <= 0) { ltv = 75; rate += 0.6; assumptions.push("RCN bridge (no rehab) estimated at 75% of value."); }
  else if (ratio <= 0.1) rate += 0.1;
  else if (ratio >= 0.9) { rate += 0.2; ltv = Math.min(ltv, et >= 3 ? 75 : 70); }
  else if (ratio >= 0.5) rate -= 0.05;
  if (s.arv && s.arv > 2 * s.purchasePrice) ltv -= 10;
  let initial = s.purchasePrice * ltv / 100;
  let total = initial + rehab;
  if (s.arv && total > s.arv * 0.75) total = s.arv * 0.75;
  total = Math.floor(total / 500) * 500;
  const pts = Math.max(0.5, 1500 / total * 100);
  rate = Math.round(rate * 100) / 100;
  assumptions.push("RCN live connection isn't set up yet — this is Bridgepoint's estimate of RCN's rehab pricing (" + "measured 2026-10-06" + "), 12-month term.");
  return { lender: L, eligible: true, source: "model", options: [{ program: "RCN " + pts.toFixed(2) + " pts (est.)", rate, price: 100 + pts }, { program: "RCN 1.00 pt (est.)", rate: Math.round((rate - (et === 0 ? 0.5 : 0.75)) * 100) / 100, price: 101 }], loanAmountUsed: total, maxLoanAmount: total, assumptions, fees: { lenderFee: 1995 } };
}

// RCN's zip overlays (from RCN's Loan Sizer -- see rcn_geo.ts). RCN's online
// calculator ignores them, RCN underwriting doesn't (Joe 2026-10-06: quote what
// actually closes). Fix & flip / bridge / ground-up only (rentals use a separate sheet).
// RCN rental rules from RCN's Product Summary (Lender Documents, read 2026-10-06):
// 680 FICO min; property value $115k+ ($125k FN); min DSCR 1.00 at 720+, 1.10 at
// 700+, 1.20 at 680+, 1.30 foreign national. Options under the DSCR floor are dropped.
function rcnRentalRules(s: Scenario, r: LenderResult): LenderResult {
  if (!r.eligible || !/DSCR|Portfolio/i.test(s.loanType)) return r;
  const fn = s.citizenshipStatus === "Foreign National";
  const f = s.creditScore || 0;
  const no = (reason: string): LenderResult => ({ lender: r.lender, eligible: false, source: r.source, reason });
  if (f && f < 680 && !fn) return no("RCN rentals need a 680+ credit score.");
  const value = (s.transactionType !== "purchase" && s.currentValue) ? s.currentValue : s.purchasePrice;
  if (value && value < (fn ? 125000 : 115000)) return no("RCN rentals need a property value of at least " + fmtMoney(fn ? 125000 : 115000) + ".");
  // LTR geo overlays (sizer 9/24/26): blocked areas, and DSCR/value floors in Philadelphia, Birmingham, Baltimore-area counties.
  const zip = (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(s.propertyAddress || "") || [])[1];
  const area = zip ? RCN_LTR_ZIP.get(zip) : undefined;
  const ov = area ? RCN_LTR_AREAS[area] : null;
  if (ov && !ov.permitted) return no("RCN isn't doing rentals in the " + area + " area (zip " + zip + ", RCN sizer " + RCN_LTR_GEO_DATE + ").");
  if (ov && ov.minValue && value && value < ov.minValue) return no("RCN rentals in the " + area + " area need a property value of at least " + fmtMoney(ov.minValue) + ".");
  const minD = Math.max(fn ? 1.3 : f >= 720 ? 1.0 : f >= 700 ? 1.1 : 1.2, s.propertyType === "Multifamily 5+" ? 1.25 : 0, (ov && ov.minDscr) || 0);
  const opts = (r.options || []).filter((o) => o.dscr == null || o.dscr >= minD - 0.005);
  if (!opts.length) return no("DSCR is under RCN's " + minD.toFixed(2) + "x minimum for this credit score — lower the loan amount or raise the rent.");
  return { ...r, options: opts };
}
function rcnApplyGeo(s: Scenario, r: LenderResult): LenderResult {
  r = rcnRentalRules(s, r);
  if (!RTL_AUTO_LOAN_TYPES.includes(s.loanType) || !r.eligible) return r;
  const zip = (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(s.propertyAddress || "") || [])[1];
  if (!zip) return { ...r, assumptions: (r.assumptions || []).concat(["No zip code on the address — RCN's zip-level market rules (do-not-lend zips, reduced leverage) couldn't be checked."]) };
  if (RCN_KILLED.has(zip)) return { lender: r.lender, eligible: false, source: r.source, reason: "RCN isn't lending in zip " + zip + " (on RCN's declining-market do-not-lend list, sizer " + RCN_GEO_DATE + ")." };
  const out: LenderResult = { ...r, assumptions: (r.assumptions || []).slice() };
  const area = RCN_TARGET.get(zip);
  if (area) {
    const value = Math.min(s.purchasePrice || Infinity, s.currentValue || Infinity);
    if (isFinite(value) && value < 175000) return { lender: r.lender, eligible: false, source: r.source, reason: "RCN needs a $175,000+ property value in the " + (RCN_TARGET_NAMES[area] || area) + " overlay area (zip " + zip + ")." };
    const adj = (s.experienceDeals || 0) >= 5 ? 0.05 : 0.10;
    const basis = (s.transactionType !== "purchase" && s.currentValue) ? s.currentValue : (s.purchasePrice || 0);
    const cut = Math.round(basis * adj);
    if (out.maxLoanAmount) out.maxLoanAmount = Math.max(0, Math.floor((out.maxLoanAmount - cut) / 100) * 100);
    if (out.loanAmountUsed && out.maxLoanAmount && out.loanAmountUsed > out.maxLoanAmount) out.loanAmountUsed = out.maxLoanAmount;
    out.assumptions!.push("RCN " + (RCN_TARGET_NAMES[area] || area) + " overlay: -" + adj * 100 + "% leverage in zip " + zip + " (RCN's calculator doesn't apply it; underwriting does) — max reduced by " + fmtMoney(cut) + ".");
  }
  if (RCN_REDUCE.has(zip)) out.assumptions!.push("RCN flags zip " + zip + " as a declining market (\"Reduce LTV\") — expect RCN underwriting to cut leverage; confirm before quoting max.");
  return out;
}

async function checkRcn(s: Scenario): Promise<LenderResult> {
  // Joe 2026-10-07: "RCN does not do rural at all" -- any loan type. Blocked before quoting,
  // even though RCN's own calculator will still return a price for a rural flag.
  if (s.ruralStatus === "rural") return { lender: "RCN Capital", eligible: false, source: "model", reason: "RCN doesn't lend on rural properties." };
  // Joe 2026-10-07: "RCN starts mixed uses at 250k" -- RCN's own calculator still prices smaller ones.
  const RCN_MIXED_MIN = 250000;
  if (s.propertyType === "Mixed-Use" && s.loanAmount && s.loanAmount < RCN_MIXED_MIN) return { lender: "RCN Capital", eligible: false, source: "model", reason: "RCN's mixed-use loans start at $250,000." };
  // RCN Product Summary (Lender Documents, rev 10/21/25, read 2026-10-07).
  const L = "RCN Capital";
  const big = s.propertyType === "Mixed-Use" || s.propertyType === "Multifamily 5+";
  const isGuc = s.loanType === "Ground Up Construction";
  const isRtl = RTL_AUTO_LOAN_TYPES.includes(s.loanType);
  if (isGuc && s.citizenshipStatus && s.citizenshipStatus !== "US Citizen") return { lender: L, eligible: false, source: "model", reason: "RCN ground-up is for US citizens only." };
  if (isGuc && s.arv && s.arv < 175000) return { lender: L, eligible: false, source: "model", reason: "RCN ground-up needs a completed value (ARV) of at least $175,000." };
  if (isRtl && !isGuc && s.loanType !== "Bridge" && s.arv && s.arv < 100000) return { lender: L, eligible: false, source: "model", reason: "RCN needs an ARV of at least $100,000." };
  if (s.creditScore && s.creditScore < 650) return { lender: L, eligible: false, source: "model", reason: "RCN's minimum credit score is 650." };
  if (!isRtl && s.propertyType === "Multifamily 5+" && s.creditScore && s.creditScore < 700) return { lender: L, eligible: false, source: "model", reason: "RCN 5-9 unit rentals need a 700+ credit score." };
  const rcnRes = rcnApplyGeo(s, await checkRcnRaw(s));
  if (rcnRes.eligible) {
    const amt = rcnRes.loanAmountUsed || rcnRes.maxLoanAmount || 0;
    const fn = s.citizenshipStatus === "Foreign National";
    let min = 75000, max = 2000000, why = "";
    if (big) { min = 250000; max = isRtl ? 3000000 : 2000000; why = s.propertyType === "Mixed-Use" ? "mixed-use" : "5+ unit"; }
    if (isGuc) { min = Math.max(min, 100000); max = 2000000; }
    if (!isRtl && fn) min = Math.max(min, 85000);
    if (amt && amt < min) return { lender: L, eligible: false, source: rcnRes.source, reason: "RCN's " + (why ? why + " " : "") + (fn && !isRtl ? "foreign-national " : "") + "loans start at " + fmtMoney(min) + " (this deal sizes to " + fmtMoney(amt) + ")." };
    if (amt && amt > max) rcnRes.assumptions = (rcnRes.assumptions || []).concat(["Above RCN's " + fmtMoney(max) + " standard max — needs RCN approval."]);
    if (!isRtl && s.propertyType === "Multifamily 5+") rcnRes.assumptions = (rcnRes.assumptions || []).concat(["RCN 5-9 unit rentals: 1.25x DSCR minimum, 70% max (65% cash-out), 1 point minimum."]);
  }
  return rcnRes;
}
async function checkRcnRaw(s: Scenario): Promise<LenderResult> {
  const assumptions: string[] = [];
  const req = rcnBuildRequest(s, assumptions);
  if (typeof req === "string") return { lender: "RCN Capital", eligible: false, reason: req };
  try {
    const j = await rcnCalculate(req);
    return rcnParse(s, j, assumptions);
  } catch (err) {
    const why = String((err as Error).message || err);
    if (RTL_AUTO_LOAN_TYPES.includes(s.loanType) && s.loanType !== "Ground Up Construction") {
      return rcnRtlModel(s, assumptions.concat(why === "not_configured" ? [] : ["RCN live pricing failed (" + why + ")."]));
    }
    return { lender: "RCN Capital", eligible: false, unavailable: true, reason: why === "not_configured" ? "RCN live pricing isn't connected yet (Joe needs to add the RCN login to the server)." : "RCN's pricer couldn't be reached (" + why + ").", assumptions };
  }
}

// ---------------------------------------------------------------------
// Lender registry -- add a new lender by adding one entry here.
// ---------------------------------------------------------------------
const LENDERS: Array<{ key: string; check: (s: Scenario) => Promise<LenderResult> }> = [
  { key: "constructive", check: checkConstructive },
  { key: "nextres", check: checkNextres },
  { key: "kiavi", check: checkKiavi },
  { key: "rcn", check: checkRcn },
  { key: "ad", check: checkAD },
  { key: "velocity", check: (s: Scenario) => checkVelocity(s as any) },
  { key: "lend", check: (s: Scenario) => checkLend(s as any) },
];

// ---------------------------------------------------------------------
// Final guideline gate (Joe 10/7/26: "only return rates that actually qualify"). Runs on every
// lender's result after its own check, for rules that cut across lenders or that a lender's own
// calculator doesn't enforce. Unknown policies are flagged, never silently passed.
// ---------------------------------------------------------------------
const APPRAISAL_TRANSFER: Record<string, "no" | "yes" | "unknown"> = {
  "RCN Capital": "no", "Lend Investors Capital": "no",
  "Constructive Capital": "yes",   // RTL Guidelines §13.1.2: allowed with a release letter + lender approval
};
const APPRAISAL_TRANSFER_NOTE: Record<string, string> = {
  "Constructive Capital": "Constructive accepts the transferred appraisal with a release letter, subject to their review.",
};
// Joe 2026-10-07: "A&D and RCN are both out of Baltimore; Constructive still doing it deal by deal
// and capped at 65% LTV on cash-out -- Baltimore turning into a straight no-go right now."
// Deal-by-deal = no price (scenario-runner rule), so Baltimore City is out for every lender.
function isBaltimoreCity(s: Scenario): boolean {
  const a = s.propertyAddress || "";
  return /\bBaltimore,\s*MD\b/i.test(a) && !/county/i.test(a);
}
function guidelineGate(s: Scenario, r: LenderResult): LenderResult {
  // Joe 10/7: "I think NextRes does Baltimore" -- confirmed: NextRes's own quote engine prices Baltimore City
  // fix & flip (10.99%, 10/7); it won't price any Maryland DSCR (statewide, not Baltimore-specific).
  if (r && isBaltimoreCity(s) && r.lender === "NextRes" && RTL_AUTO_LOAN_TYPES.includes(s.loanType)) {
    if (r.eligible) r.assumptions = (r.assumptions || []).concat(["NextRes's engine prices Baltimore City fix & flip; confirm the specific address with NextRes before quoting."]);
    return r;
  }
  if (r && isBaltimoreCity(s)) {
    return { lender: r.lender, eligible: false, source: r.source,
      reason: r.lender === "Constructive Capital"
        ? "Baltimore City is deal-by-deal only at Constructive (65% LTV max on cash-out) — not quotable; bring it to Joe."
        : r.lender + " isn't lending in Baltimore City right now." };
  }
  if (!r || !r.eligible) return r;
  if (Array.isArray(r.options)) {
    r.options = r.options.filter((o) => o && isFinite(Number(o.rate)) && Number(o.rate) > 0 && (!o.loanAmount || o.loanAmount > 0));
    if (!r.options.length) return { ...r, eligible: false, options: [], reason: "No valid rate came back for this scenario." };
  }
  if (s.appraisalTransfer === "yes") {
    const pol = APPRAISAL_TRANSFER[r.lender] || "unknown";
    if (pol === "no") return { lender: r.lender, eligible: false, source: r.source, reason: r.lender + " doesn't accept transferred appraisals — they'd need to order a new one." };
    r.assumptions = (r.assumptions || []).concat([pol === "yes" ? (APPRAISAL_TRANSFER_NOTE[r.lender] || r.lender + " accepts transferred appraisals.") : "Confirm " + r.lender + " will accept the existing appraisal as a transfer."]);
  }
  return r;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }
  try {
    const body = await req.json();
    // Server-key-only: read one of Velocity's reference lists (e.g. "LoanPurpose", "PropertyType").
    if (body.velocityList && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      return new Response(JSON.stringify(await velocityGet(String(body.velocityList).replace(/[^A-Za-z]/g, ""))), { headers: CORS_HEADERS });
    }
    if (body.velocityRaw && (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      return new Response(JSON.stringify(await velocityPost(String(body.velocityPath || "GetPricing").replace(/[^A-Za-z]/g, ""), body.velocityRaw)), { headers: CORS_HEADERS });
    }
    const scenario: Scenario = body.lead;
    if (!scenario) {
      return new Response(JSON.stringify({ error: "missing_lead" }), { status: 400, headers: CORS_HEADERS });
    }
    // Optional body.lenders: ["velocity", ...] prices only those (used for accuracy testing).
    const picked = Array.isArray(body.lenders) && body.lenders.length ? LENDERS.filter(function (l) { return body.lenders.indexOf(l.key) !== -1; }) : LENDERS;
    const results = await Promise.allSettled(picked.map(function (l) { return l.check(scenario); }));
    const out = results.map(function (r, i) {
      if (r.status === "fulfilled") return guidelineGate(scenario, r.value);
      return { lender: picked[i].key, eligible: false, reason: "Lookup failed: " + String(r.reason) };
    });
    return new Response(JSON.stringify({ ok: true, results: out }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
