// Lend Investors Capital (LEND / LEAPP, Builders Capital) -- Joe 10/7/26: add LEND, "be sure to go
// through all their matrix and their rules, I don't want to be pre-approving loans that don't fit".
//
// LEND's portal (leapplenderportal.com) prices through LoanPASS behind a Salesforce login that needs
// an emailed code, so it can't be called from the server. This is a researched model of LEND's own
// quotes (measured 10/7/26 by running scenarios through their Quote tool, rate sheet v5862), plus the
// exact eligibility rules from their product matrices (Rehab Cosmetic rev 10/5/26, Rehab Structural
// rev 9/14/26). A weekly refresh in Joe's logged-in browser re-measures the numbers and writes them to
// lender_pricing_snapshots (lender='lend'); when present they replace LEND_FIT below.

type S = {
  loanType: string; transactionType: string; propertyAddress: string; propertyState: string; propertyType: string;
  creditScore: number | null; purchasePrice: number | null; currentValue: number | null; loanAmount: number | null;
  rehabBudget: number | null; arv: number | null; entityType: string | null; citizenshipStatus: string | null;
  experienceDeals: number | null; termMonths: number | null; ruralStatus: string | null; currentLoanBalance: number | null;
  appraisalTransfer?: string | null; rehabScope?: string | null; decliningMarket?: string | null; vacationArea?: string | null;
};

export const LEND_FIT = {
  sheet: "5862", measured: "2026-10-07",
  // Par rate by loan amount at 7+ deals / 700+ FICO (identical across IL/FL/TX/GA/NY/OH/NJ and SFR/condo/townhome/2-4).
  // Breakpoints measured: $197,750 -> 9.75, $207,500 -> 9.125; $498,000 -> 9.125, $525,000 -> 9.0.
  rateBands: [ { min: 0, rate: 9.75 }, { min: 200000, rate: 9.125 }, { min: 500000, rate: 9.0 } ],
  structuralRate: 0.25,        // Rehab Structural = cosmetic + 0.25 (7+ deals, $203,400: 9.375 vs 9.125)
  // Rate add-ons (%), by completed deals in the last 36 months and by FICO.
  expRate: { "0": 2.125, "1": 1.75, "2": 0.5, "3": 0.5, "4": 0.25, "5": 0.25, "6": 0.25 } as Record<string, number>,
  ficoRate: [ { max: 679, add: 0.5 }, { max: 699, add: 0.25 } ],
  // Lender charge = max($2,500, 1% of loan) + these % of the loan.
  feeFloor: 2500, feeMinPct: 1.0,
  expFeePct: { "0": 1.0, "1": 0.5, "2": 0.25 } as Record<string, number>,
  ficoFeePct: [ { max: 699, add: 0.25 } ],
  termFeePctPer3Mo: 0.25,      // 15 mo +0.25, 18 mo +0.5, 21 +0.75, 24 +1.0 (12/18/24 measured)
  // New Construction (ground-up), measured 10/7/26 at $297,000: 7+ builds 10.5, 4-6 10.75, 2-3 11.0, 1 11.25.
  // Size break measured: $297,000 -> 10.5, $305,100 -> 9.5; flat 9.5 through $1.045M.
  // and $1,080,000 @ 90% LTC -> 9.25 ($1M+ band).
  ncRateBands: [ { min: 0, rate: 10.5 }, { min: 300000, rate: 9.5 }, { min: 1000000, rate: 9.25 } ],
  ncHighLtcAdd: 0.25,          // loans over 90% LTC (the 93/95% low-land tiers): 275,500 @95% = 10.75; 324,000 @90% = no add
  ncExpRate: { "1": 0.75, "2": 0.5, "3": 0.5, "4": 0.25, "5": 0.25, "6": 0.25 } as Record<string, number>,
  ncExpFeePct: { "1": 0.75, "2": 0.5, "3": 0.25 } as Record<string, number>,
  buydownPtsPerRate: 1.0,      // -0.25% rate = +0.25 pts (to -1.00%)
  buyupPtsPerRate: 0.5,        // +0.50% rate = -0.25 pts
};

// Rehab Cosmetic tiers (matrix p.5). ltc/arv/ia = max LTC, max LTV-of-ARV, initial advance (% of cost basis).
const COSMETIC_TIERS = [
  { name: "95 LTC", minExp: 7, f700: { ltc: 95, arv: 75, ia: 90 }, f660: { ltc: 92.5, arv: 75, ia: 90 }, cashout: false, declining: true, vacationCap: 87.5, nonWarrCondo: false },
  { name: "92.5 LTC", minExp: 4, f700: { ltc: 92.5, arv: 75, ia: 90 }, f660: { ltc: 87.5, arv: 70, ia: 87.5 }, cashout: false, declining: true, vacationCap: 87.5, nonWarrCondo: false },
  { name: "87.5 LTC", minExp: 2, f700: { ltc: 87.5, arv: 70, ia: 87.5 }, f660: { ltc: 83, arv: 70, ia: 83 }, cashout: false, declining: true, vacationCap: null, nonWarrCondo: true },
  { name: "83 LTC", minExp: 1, f700: { ltc: 83, arv: 70, ia: 83 }, f660: null, cashout: true, declining: true, vacationCap: null, nonWarrCondo: true },
  { name: "80 LTC", minExp: 0, f700: { ltc: 80, arv: 65, ia: 80 }, f660: null, cashout: false, declining: false, vacationCap: null, nonWarrCondo: false, maxBudget: 250000, maxLoan: 500000 },
];
// Rehab Structural (matrix p.5): 2+ deals required.
const STRUCTURAL_TIERS = [
  { name: "7+", minExp: 7, f700: { ltc: 90, arv: 75, ia: 90 }, f660: { ltc: 90, arv: 75, ia: 90 } },
  { name: "4+", minExp: 4, f700: { ltc: 90, arv: 75, ia: 90 }, f660: { ltc: 87.5, arv: 70, ia: 87.5 } },
  { name: "2+", minExp: 2, f700: { ltc: 87.5, arv: 70, ia: 87.5 }, f660: { ltc: 83, arv: 70, ia: 83 } },
];

const NO_STATES = ["AR", "ND", "NH", "SD", "VT"];
const EXCEPTION_STATES = ["AK", "HI"];
const EXCEPTION_CITIES = [/\bDetroit\b.*\bMI\b/i, /\bIndianapolis\b.*\bIN\b/i, /\bCleveland\b.*\bOH\b/i, /\bBaltimore\b.*\bMD\b/i, /\bPhiladelphia\b.*\bPA\b/i];
const OK_PROPERTY = ["SFR", "Single Family", "Condo", "Townhome", "2-4 Unit", "Duplex"];

let snapCache: { at: number; fit: typeof LEND_FIT; captured: string | null } | null = null;
async function lendFit() {
  if (snapCache && Date.now() - snapCache.at < 600000) return snapCache;
  let row: any = null;
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && key) {
    const r = await fetch(url + "/rest/v1/lender_pricing_snapshots?lender=eq.lend&select=data,captured_at", { headers: { apikey: key, Authorization: "Bearer " + key } }).catch(() => null);
    if (r && r.ok) { const rows = await r.json().catch(() => []); row = rows && rows[0]; }
  }
  snapCache = { at: Date.now(), fit: row && row.data && row.data.rateBands ? { ...LEND_FIT, ...row.data } : LEND_FIT, captured: row ? row.captured_at : null };
  return snapCache;
}

export function lendRate(fit: typeof LEND_FIT, loan: number, exp: number, fico: number): number {
  let base = fit.rateBands[0].rate;
  for (const b of fit.rateBands) if (loan >= b.min) base = b.rate;
  const e = exp >= 7 ? 0 : (fit.expRate[String(Math.max(0, Math.floor(exp)))] ?? 0);
  const f = (fit.ficoRate.find((x) => fico <= x.max) || { add: 0 }).add;
  return Math.round((base + e + f) * 1000) / 1000;
}
export function lendFee(fit: typeof LEND_FIT, loan: number, exp: number, fico: number, term: number): number {
  const pct = (fit.expFeePct[String(Math.max(0, Math.floor(exp)))] ?? 0) + ((fit.ficoFeePct.find((x) => fico <= x.max) || { add: 0 }).add) + Math.max(0, Math.round((term - 12) / 3)) * fit.termFeePctPer3Mo;
  return Math.round((Math.max(fit.feeFloor, loan * fit.feeMinPct / 100) + loan * pct / 100) * 100) / 100;
}

// New Construction matrix (p.5). ltcLow/ltcHigh = max LTC when land value is under / at-or-over 15% of ARV.
// ia = initial advance (% of lot). bigLot = lot price or land value over $200k allowed.
const NC_TIERS = [
  { name: "7+", minExp: 7, f700: { ltcLow: 95, ltcHigh: 90, arv: 75, ia: 75, bigLot: true }, f660: { ltcLow: 93, ltcHigh: 88, arv: 72.5, ia: 70, bigLot: true }, declining: true },
  { name: "4+", minExp: 4, f700: { ltcLow: 93, ltcHigh: 88, arv: 72.5, ia: 70, bigLot: true }, f660: { ltcLow: 90, ltcHigh: 83, arv: 70, ia: 70, bigLot: false }, declining: true },
  // Matrix table says 2+ "not eligible" in declining markets, but the product overview says "requires 2+ NC
  // experience and a 5% LTV reduction" and LEND's own pricer approves 2+ (measured 10/7) -- follow the pricer.
  { name: "2+", minExp: 2, f700: { ltcLow: 90, ltcHigh: 83, arv: 70, ia: 70, bigLot: false }, f660: { ltcLow: 85, ltcHigh: 78, arv: 65, ia: 65, bigLot: false }, declining: true },
  { name: "1", minExp: 1, f700: { ltcLow: 85, ltcHigh: 78, arv: 65, ia: 65, bigLot: false }, f660: null, declining: false },
];
const NC_PROPERTY = ["SFR", "Single Family", "Townhome", "2-4 Unit", "Duplex"];

async function checkLendNc(s: S, out: any): Promise<any> {
  const no = (why: string) => { out.reason = why; return out; };
  if ((s.entityType || "LLC") === "Individual") return no("LEND ground-up requires an entity borrower.");
  if (s.citizenshipStatus === "Foreign National") return no("LEND doesn't lend to foreign nationals on ground-up.");
  const fico = Number(s.creditScore || 0);
  if (!fico) return no("Needs a credit score.");
  if (fico < 660) return no("LEND's ground-up minimum FICO is 660.");
  const exp = Math.max(0, Math.floor(Number(s.experienceDeals || 0)));
  if (exp < 1) return no("LEND ground-up needs at least 1 completed new-construction project in the last 3 years.");
  const st = (s.propertyState || "").toUpperCase();
  if (NO_STATES.includes(st)) return no("LEND doesn't lend in " + st + ".");
  if (EXCEPTION_STATES.includes(st)) return no("LEND only lends in " + st + " by exception — not quotable.");
  if (EXCEPTION_CITIES.some((re) => re.test(s.propertyAddress || ""))) return no("LEND only lends in this city by exception — not quotable.");
  if (s.ruralStatus === "rural") return no("LEND doesn't do rural ground-up.");
  if (!NC_PROPERTY.includes(s.propertyType)) return no("LEND ground-up is SFR, townhome/PUD or 2-4 units only (condos case-by-case) — not " + s.propertyType + ".");
  if (s.appraisalTransfer === "yes") return no("LEND doesn't accept transferred appraisals — a new valuation would be needed.");
  const lot = s.purchasePrice && s.currentValue ? Math.min(s.purchasePrice, s.currentValue) : Number(s.purchasePrice || s.currentValue || 0);
  const budget = Number(s.rehabBudget || 0), arv = Number(s.arv || 0);
  if (!lot) return no("Needs the lot price.");
  if (!budget) return no("Needs the construction budget.");
  if (!arv) return no("Needs the after-completion value (ARV).");
  const term = [12, 15, 18, 21, 24].includes(Number(s.termMonths)) ? Number(s.termMonths) : 12;
  const fit = (await lendFit()).fit;
  const landHigh = lot / arv >= 0.15;
  const options: any[] = [];
  let firstReason = "";
  for (const t of NC_TIERS) {
    if (exp < t.minExp) continue;
    const lim = fico >= 700 ? t.f700 : t.f660;
    if (!lim) { firstReason = firstReason || "LEND's 1-build tier needs a 700+ FICO."; continue; }
    if (lot > 200000 && !lim.bigLot) { firstReason = firstReason || "LEND only finances lots over $200k for 7+ builders (or 4+ with a 700+ FICO)."; continue; }
    if (s.transactionType === "cashout") { firstReason = firstReason || "Cash-out on LEND ground-up isn't priced here yet."; continue; }
    let ltc = landHigh ? lim.ltcHigh : lim.ltcLow, arvPct = lim.arv;
    if (s.decliningMarket === "yes") { if (!t.declining) { firstReason = firstReason || "LEND ground-up in a declining market needs 2+ builds."; continue; } arvPct -= 5; }
    if (s.vacationArea === "yes") ltc = Math.min(ltc - 5, 85);
    let max = Math.min((lot + budget) * ltc / 100, arv * arvPct / 100, lot * lim.ia / 100 + budget);
    max = Math.floor(max + 1e-6);
    const amt = s.loanAmount ? Math.min(s.loanAmount, max) : max;
    if (amt < 100000) { firstReason = firstReason || "LEND's minimum loan is $100,000."; continue; }
    if (amt > 3000000) continue;
    let base = fit.ncRateBands[0].rate; for (const b of fit.ncRateBands) if (amt >= b.min) base = b.rate;
    const highLtc = amt / (lot + budget) > 0.9000001 ? (fit.ncHighLtcAdd ?? 0.25) : 0;
    const rate = Math.round((base + highLtc + (exp >= 7 ? 0 : (fit.ncExpRate[String(exp)] ?? 0)) + ((fit.ficoRate.find((x) => fico <= x.max) || { add: 0 }).add)) * 1000) / 1000;
    const pct = (exp >= 4 ? 0 : (fit.ncExpFeePct[String(exp)] ?? 0)) + ((fit.ficoFeePct.find((x) => fico <= x.max) || { add: 0 }).add) + Math.max(0, Math.round((term - 12) / 3)) * fit.termFeePctPer3Mo;
    const fee = Math.round((Math.max(fit.feeFloor, amt * fit.feeMinPct / 100) + amt * pct / 100) * 100) / 100;
    if (options.some((o) => o.loanAmount === amt && o.rate === rate)) continue;
    options.push({ program: "New Construction " + t.name + " · " + term + "-mo I/O", rate, price: 100 + fee / amt * 100, loanAmount: amt, lenderPoints: Math.round(fee / amt * 100000) / 1000, lenderFee: fee, term });
  }
  if (!options.length) return no(firstReason || "No LEND ground-up tier fits this deal.");
  options.sort((a, b) => b.loanAmount - a.loanAmount || a.rate - b.rate);
  out.eligible = true; out.options = options.slice(0, 3);
  out.loanAmountUsed = options[0].loanAmount; out.maxLoanAmount = options[0].loanAmount;
  out.rehabHoldback = budget; out.fees = { lenderFee: Math.round(options[0].lenderFee) };
  out.compCaps = { maxBrokerPoints: 5 }; out.rateTolerance = 0.125;
  out.assumptions.push("LEND ground-up pricing measured from LEND's own quote tool. Land " + (landHigh ? "≥" : "<") + " 15% of ARV. Licensed GC required (1-build borrowers need a GC with 3+ builds); 1-build loans need approved permits before closing.");
  out.assumptions.push("LEND counts only completed NEW-CONSTRUCTION projects (last 3 yrs) as experience here — " + exp + " assumed.");
  out.assumptions.push("LEND requires a top-300 MSA and does its own valuation (transfers not accepted).");
  return out;
}

export async function checkLend(s: S): Promise<any> {
  const L = "Lend Investors Capital";
  const out: any = { lender: L, eligible: false, source: "model", assumptions: [] as string[] };
  const no = (why: string) => { out.reason = why; return out; };
  const lt = s.loanType || "";
  if (lt === "Ground Up Construction") return checkLendNc(s, out);
  if (lt !== "Fix & Flip") return no("LEND is priced here for fix & flip and ground-up only (their rental pricing wasn't competitive; bridge not measured yet).");
  // ---- borrower
  if ((s.entityType || "LLC") === "Individual") return no("LEND rehab loans require an entity borrower (LLC/LP/Corp) — individuals aren't eligible.");
  if (s.citizenshipStatus === "Foreign National") return no("LEND doesn't lend to foreign nationals on rehab loans.");
  const fico = Number(s.creditScore || 0);
  if (!fico) return no("Needs a credit score.");
  if (fico < 660) return no("LEND's minimum FICO is 660.");
  const exp = Math.max(0, Math.floor(Number(s.experienceDeals || 0)));
  // ---- property / location
  const st = (s.propertyState || "").toUpperCase();
  if (NO_STATES.includes(st)) return no("LEND doesn't lend in " + st + ".");
  if (EXCEPTION_STATES.includes(st)) return no("LEND only lends in " + st + " by exception — not quotable.");
  if (EXCEPTION_CITIES.some((re) => re.test(s.propertyAddress || ""))) return no("LEND only lends in this city by exception (Detroit, Indianapolis, Cleveland, Baltimore, Philadelphia) — not quotable.");
  if (s.ruralStatus === "rural") return no("LEND only does rural properties by exception — not quotable.");
  if (!OK_PROPERTY.includes(s.propertyType)) return no("LEND rehab loans are 1-4 unit residential only (no " + s.propertyType + ").");
  if (s.appraisalTransfer === "yes") return no("LEND doesn't accept transferred appraisals — a new valuation would be needed ($595 hybrid or full appraisal).");
  // ---- program
  const structural = s.rehabScope === "structural";
  const tiers: any[] = structural ? STRUCTURAL_TIERS : COSMETIC_TIERS;
  if (structural && exp < 2) return no("LEND's structural rehab program needs 2+ completed projects in the last 3 years.");
  const price = Number(s.purchasePrice || 0), asIs = Number(s.currentValue || 0), rehab = Number(s.rehabBudget || 0), arv = Number(s.arv || 0);
  const refi = !!s.transactionType && s.transactionType !== "purchase";
  const cashout = s.transactionType === "cashout";
  if (!arv) return no("Needs the after-repair value.");
  const basis = refi ? (asIs || price) : (price && asIs ? Math.min(price, asIs) : (price || asIs));
  if (!basis) return no(refi ? "Needs the as-is value." : "Needs the purchase price.");
  const cost = basis + rehab;
  const term = [12, 15, 18, 21, 24].includes(Number(s.termMonths)) ? Number(s.termMonths) : 12;
  if (term > 15) out.assumptions.push("Terms over 15 months need LEND management approval.");
  const fit = (await lendFit()).fit;
  const options: any[] = [];
  let firstReason = "";
  for (const t of tiers) {
    if (exp < t.minExp) continue;
    const lim = fico >= 700 ? t.f700 : t.f660;
    if (!lim) { firstReason = firstReason || ("LEND's " + t.name + " tier needs a 700+ FICO."); continue; }
    if (cashout && !structural && !t.cashout) { firstReason = firstReason || "LEND doesn't allow cash-out on this tier."; continue; }
    if (t.maxBudget && rehab > t.maxBudget) { firstReason = firstReason || ("LEND's no-experience tier caps the rehab budget at $" + t.maxBudget.toLocaleString() + "."); continue; }
    let ltc = lim.ltc, arvPct = lim.arv;
    if (cashout) { ltc -= 5; arvPct -= 5; if (structural) { ltc = Math.min(ltc, 78); arvPct = Math.min(arvPct, 65); } }
    // Reductions first, caps after (measured: 92.5 tier, declining + vacation = 82.5% LTC, not 80%).
    const caps: number[] = [];
    if (s.decliningMarket === "yes") { if (t.declining === false) { firstReason = firstReason || "LEND's no-experience tier isn't available in declining markets."; continue; } ltc -= 5; arvPct -= 5; caps.push(85); }
    if (s.vacationArea === "yes") { ltc -= 5; if (t.vacationCap) caps.push(t.vacationCap); }
    if (caps.length) ltc = Math.min(ltc, ...caps);
    const ia = Math.min(lim.ia, ltc);
    let max = Math.min(cost * ltc / 100, arv * arvPct / 100, basis * ia / 100 + rehab);
    if (t.maxLoan) max = Math.min(max, t.maxLoan);
    max = Math.floor(max + 1e-6);   // LEND doesn't round (e.g. 87.5% x $695,000 = $608,125)
    const amt = s.loanAmount ? Math.min(s.loanAmount, max) : max;
    if (amt < 100000) { firstReason = firstReason || "LEND's minimum loan is $100,000."; continue; }
    if (amt > 3000000) continue;
    const rate = Math.round((lendRate(fit, amt, exp, fico) + (structural ? (fit.structuralRate ?? 0.25) : 0)) * 1000) / 1000;
    const fee = lendFee(fit, amt, exp, fico, term);
    if (options.some((o) => o.loanAmount === amt && o.rate === rate)) continue;
    options.push({ program: (structural ? "Rehab Structural " : "Rehab Cosmetic ") + t.name + " · " + term + "-mo I/O", rate, price: 100 + fee / amt * 100, loanAmount: amt, lenderPoints: Math.round(fee / amt * 100000) / 1000, lenderFee: fee, term });
  }
  if (!options.length) return no(firstReason || "No LEND tier fits this deal.");
  options.sort((a, b) => b.loanAmount - a.loanAmount || a.rate - b.rate);
  out.eligible = true;
  out.options = options.slice(0, 3);
  out.loanAmountUsed = options[0].loanAmount;
  out.maxLoanAmount = options[0].loanAmount;
  out.rehabHoldback = rehab;
  out.fees = { lenderFee: Math.round(options[0].lenderFee) };
  out.compCaps = { maxBrokerPoints: 5 };
  out.rateTolerance = 0.125;
  out.assumptions.push("LEND pricing measured from LEND's own quote tool (sheet " + fit.sheet + "). Lender charge includes LEND's fees; their $1,295 processing + $500 closing are separate.");
  if (!structural) out.assumptions.push("Priced as cosmetic (non-structural) rehab. Gut rehabs, additions, conversions, ADUs or fire/water damage go under LEND's structural program.");
  if (amtOver1M(options[0].loanAmount)) out.assumptions.push("Loans over $1M need LEND committee approval and comparable experience.");
  out.assumptions.push("LEND requires a top-300 MSA and does its own valuation ($595 hybrid or full appraisal; transfers not accepted).");
  return out;
}
function amtOver1M(n: number) { return n > 1000000; }
