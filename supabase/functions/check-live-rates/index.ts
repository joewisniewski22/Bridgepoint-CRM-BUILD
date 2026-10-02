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
  options?: Array<{ program: string; rate: number; price: number; dscr?: number | null }>;
  // Loan amount every option above was priced at. When the caller doesn't
  // supply a loan amount, this is the highest amount the lender will do on
  // this scenario (maxLoanAmount === loanAmountUsed); when they do supply
  // one, maxLoanAmount is still reported where it can be found.
  loanAmountUsed?: number;
  maxLoanAmount?: number;
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
const DSCR_GEO_ADJ_STATES = ["AL","GA","KS","ME","MO","MS","NE","SD","WI","WY"];
const DSCR_GEO_ADJ = 0.375;
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
  { min:1500000, max:Infinity, adj:[0.500,0.500,0.500,0.000,0.000,0.000] },
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
    let rate = base + (isGuc ? 0.75 : 0) + txnAdj + termBuydown;
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
  { minFico: 680, purchase: 80, rateTerm: 80, cashOut: 75 },
  { minFico: 660, purchase: 70, rateTerm: 70, cashOut: 70 },
];
const MAX_LOAN_SANITY_CEILING = 2000000;

async function constructiveMaxLoan(s: Scenario): Promise<{ amount: number; note?: string } | null> {
  if (RTL_AUTO_LOAN_TYPES.includes(s.loanType)) {
    const isGuc = s.loanType === "Ground Up Construction";
    if (s.purchasePrice == null || (s.purchasePrice === 0 && !isGuc)) return null;
    const tier = experienceTier(s.experienceDeals);
    const limitsRaw = isGuc ? GROUNDUP_TIERS[tier] : RTL_TIERS[tier][s.loanType === "Bridge" ? "bridge" : (rehabClass(s) as "light" | "heavy")];
    if (!limitsRaw) return null;
    const limits: RtlLimits = { ...limitsRaw };
    const state = stateFromAddress(s.propertyAddress);
    const candidates = [0];
    if (state === "NY") candidates.push(-15);
    if (s.transactionType === "cashout") candidates.push(-5);
    if (s.citizenshipStatus === "Foreign National") candidates.push(-5);
    const adj = Math.min(...candidates);
    if (adj) {
      for (const k of ["ltc", "iltc", "ltarv", "totalLtc"] as const) if (limits[k] != null) limits[k] = (limits[k] as number) + adj;
    }
    const pp = s.purchasePrice, rehab = s.rehabBudget || 0;
    const caps: number[] = [];
    if (s.loanType === "Bridge") {
      if (limits.ltc != null) caps.push(limits.ltc / 100 * pp);
    } else if (isGuc) {
      if (limits.iltc != null) caps.push(limits.iltc / 100 * pp + rehab);
      if (limits.totalLtc != null) caps.push(limits.totalLtc / 100 * (pp + rehab));
      if (limits.ltarv != null && s.arv) caps.push(limits.ltarv / 100 * s.arv);
    } else {
      if (limits.iltc != null) caps.push(limits.iltc / 100 * pp + rehab);
      if (limits.ltc != null) caps.push(limits.ltc / 100 * (pp + rehab));
      if (limits.ltarv != null && s.arv) caps.push(limits.ltarv / 100 * s.arv);
    }
    if (!caps.length) return null;
    return { amount: Math.floor(Math.max(0, Math.min(MAX_LOAN_SANITY_CEILING, ...caps))), note: adj ? "Leverage reduced " + Math.abs(adj) + "% (state / cash-out / foreign national adjustment)." : undefined };
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
      const minDscr = rural ? 1.20 : 1.0;
      const trial = await checkConstructiveAt({ ...s, loanAmount: Math.min(ltvCap, MAX_LOAN_SANITY_CEILING) });
      const rate = trial.eligible && trial.options && trial.options.length ? trial.options[0].rate : 7.0;
      const r = rate / 100 / 12;
      const termM = s.termMonths || 360;
      const factor = r / (1 - Math.pow(1 + r, -termM));
      const targetPi = (s.rentEstimate / minDscr) / 1.2;
      dscrCap = targetPi / factor;
    }
    const capped = Math.min(ltvCap, dscrCap, MAX_LOAN_SANITY_CEILING);
    return { amount: Math.floor(Math.max(0, capped)), note: "Max " + maxLtv + "% LTV of " + (s.transactionType !== "purchase" && s.currentValue ? "current value" : "purchase price") + (dscrCap < ltvCap ? " — limited by rental income (DSCR)." : ".") };
  }
  return null;
}

async function checkConstructive(s: Scenario): Promise<LenderResult> {
  if (s.loanAmount) {
    const r = await checkConstructiveAt(s);
    const max = await constructiveMaxLoan(s);
    return { ...r, loanAmountUsed: s.loanAmount, maxLoanAmount: max ? max.amount : undefined };
  }
  const max = await constructiveMaxLoan(s);
  if (!max || !max.amount) {
    return { lender: "Constructive Capital", eligible: false, reason: "Not enough information to size the loan yet (needs credit score, property value, and for rentals the monthly rent; for fix & flip/bridge/ground-up the purchase price, rehab, ARV, and experience)." };
  }
  const r = await checkConstructiveAt({ ...s, loanAmount: max.amount });
  const assumptions = (r.assumptions || []).concat(max.note ? [max.note] : []);
  return { ...r, assumptions, loanAmountUsed: max.amount, maxLoanAmount: max.amount };
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
  if (amtBand) rate += amtBand.adj[col];
  if (propState && DSCR_GEO_ADJ_STATES.includes(propState)) rate += DSCR_GEO_ADJ;
  const prepayKey = s.prepayTerm || "5yr";
  rate += DSCR_PREPAY_ADJ[prepayKey][col];
  rate = Math.round(rate * 1000) / 1000;
  if (rate < DSCR_MIN_NOTE_RATE) rate = DSCR_MIN_NOTE_RATE;

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
  return { lender: "Constructive Capital", eligible: true, options, fees: { lenderFee: fee } };
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
// Lender registry -- add a new lender by adding one entry here.
// ---------------------------------------------------------------------
const LENDERS: Array<{ key: string; check: (s: Scenario) => Promise<LenderResult> }> = [
  { key: "constructive", check: checkConstructive },
  { key: "nextres", check: checkNextres },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }
  try {
    const body = await req.json();
    const scenario: Scenario = body.lead;
    if (!scenario) {
      return new Response(JSON.stringify({ error: "missing_lead" }), { status: 400, headers: CORS_HEADERS });
    }
    const results = await Promise.allSettled(LENDERS.map(function (l) { return l.check(scenario); }));
    const out = results.map(function (r, i) {
      if (r.status === "fulfilled") return r.value;
      return { lender: LENDERS[i].key, eligible: false, reason: "Lookup failed: " + String(r.reason) };
    });
    return new Response(JSON.stringify({ ok: true, results: out }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
