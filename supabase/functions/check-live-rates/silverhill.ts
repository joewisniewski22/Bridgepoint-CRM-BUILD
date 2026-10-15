// Silver Hill Capital -- FALLBACK lender (Joe 2026-10-14: "they'd only be used for property types/scenarios the other lenders don't take ...
// keep the pricer live but write in the code that Silver Hill is only checked on property types/scenarios the other lenders don't accept").
//
// Phase 1 (this file): rules-only fit check from Silver Hill's public program pages and the pricing forms in their broker portal
// (read 10/14/26). It never calls Silver Hill and never creates anything in Joe's portal account. When the scenario fits, it returns
// portalOnly = true ("manual quote"): the CRM shows that the deal may be placeable and has to be priced in Silver Hill's portal.
// Phase 2 (later): live rate from the portal once the server can sign in (SILVERHILL_USERNAME / SILVERHILL_PASSWORD secrets are saved;
// the portal's username is the email plus ".shc").
//
// index.ts only keeps this result when NO other lender places the scenario (see FALLBACK_LENDERS there).

type S = any;

// States missing from Silver Hill's DSCR pricing form (the form lists 43 states + DC).
const EXCLUDED_STATES = ["HI", "ID", "MT", "NV", "ND", "SD", "WV", "WY"];

// 1-4 unit rental (DSCR) program property types, from the DSCR pricing form: single family, 2-4 family, PUD, townhouse/row house, residential condo.
const DSCR_TYPES = ["SFR", "Single Family", "Duplex", "2-4 Unit", "Condo", "Townhome", "PUD"];
// Small-balance commercial property types, from the commercial pricing form.
const SBC_TYPES = ["Multifamily 5+", "Mixed-Use", "Mixed-Use (Commercial Heavy)", "Office", "Retail", "Warehouse", "Self-Storage", "Automotive", "Mobile Home Park", "Commercial Condo", "Day Care"];

import { silverHillQuoteCached } from "./silverhill_live.ts";

// Rules first (free, no portal call); only a scenario that fits is priced live. A live rate makes Silver Hill an eligible lender; if the live
// price can't be had (sign-in down, outside their guidelines, hourly cap) the result stays a "manual quote" with the reason.
export async function checkSilverHill(s: S): Promise<any> {
  const base = checkSilverHillRules(s);
  if (!base.portalOnly) return base;
  const q = await silverHillQuoteCached(s);
  if (!q.ok || !q.rate) {
    base.assumptions = (base.assumptions || []).concat(["Live rate not available: " + (q.reason || "Silver Hill returned no rate") + (q.errors ? " (" + q.errors + ")" : "")]);
    return base;
  }
  // A rate that comes back with a portal warning ("Final DSCR less than Required DSCR", etc.) isn't an offer Silver Hill will certainly take.
  if (q.errors) {
    base.assumptions = (base.assumptions || []).concat(["Silver Hill's portal showed " + q.rate + "% but flagged: " + q.errors + ". Not shown as a price; a person needs to look at it with their account executive."]);
    return base;
  }
  const dscr = /DSCR/.test(q.program || "");
  const amt = Number(s.loanAmount) || 0;
  return {
    lender: "Silver Hill", eligible: true, source: "live",
    options: [{ program: (q.program || "Silver Hill") + " · 30-yr fixed" + (dscr ? "" : " · full doc"), rate: q.rate, price: 100, loanAmount: amt || undefined, note: "Rate from Silver Hill's broker portal; no lender points." }],
    loanAmountUsed: amt || undefined, maxLoanAmount: amt || undefined,
    compCaps: dscr ? { maxBrokerPoints: 5 } : { maxBrokerPoints: 3, maxYsp: 2 },
    assumptions: ["Live Silver Hill portal rate" + (q.cached ? " (reused from the last 24 hours)" : "") + ", no lender points. Broker compensation up to 5 points" + (dscr ? "" : " (3 origination + 2 yield spread)") + " per Silver Hill; confirm yield-spread handling with their account executive before quoting.", ...(dscr ? ["Estimated DSCR was worked out at about an 8% rate; Silver Hill sets the final rate from the real DSCR on their application."] : [])],
  };
}

export function checkSilverHillRules(s: S): any {
  const L = "Silver Hill";
  const no = (reason: string) => ({ lender: L, eligible: false, source: "model", reason });
  const lt = String(s.loanType || "");
  if (!/^(DSCR|Portfolio\/Blanket|Mixed-Use)$/i.test(lt)) return no("Silver Hill doesn't offer " + (lt || "this loan type") + " (rentals and commercial only).");
  const pt = String(s.propertyType || "");
  const isDscr = DSCR_TYPES.indexOf(pt) !== -1;
  const isSbc = SBC_TYPES.indexOf(pt) !== -1;
  if (!isDscr && !isSbc) return no("Silver Hill doesn't lend on " + (pt || "this property type") + ".");
  if (lt === "Portfolio/Blanket" && isSbc) return no("Silver Hill's portfolio loans are 1-4 unit rentals only.");
  const st = String(s.propertyState || "").toUpperCase();
  if (st && EXCLUDED_STATES.indexOf(st) !== -1) return no("Silver Hill doesn't lend in " + st + ".");
  const cit = String(s.citizenshipStatus || "US Citizen");
  if (cit !== "US Citizen" && cit !== "Permanent Resident") return no("Silver Hill's rules for " + cit + " borrowers aren't verified here -- ask them directly.");
  if (s.creditEvent === "yes") return no("Recent credit event -- Silver Hill needs a manual review.");
  const fico = Number(s.creditScore) || 0;
  if (!fico) return no("Needs a credit score.");
  const twoToFour = pt === "Duplex" || pt === "2-4 Unit";
  const minFico = isDscr ? (twoToFour ? 680 : 660) : 650;
  if (fico < minFico) return no("Credit score is below Silver Hill's " + minFico + " minimum for this property type.");
  const amt = Number(s.loanAmount) || 0;
  const maxAmt = isDscr ? (lt === "Portfolio/Blanket" ? 6250000 : 2000000) : 2500000;
  const minAmt = lt === "Portfolio/Blanket" ? 500000 : 100000;
  if (amt && amt < minAmt) return no("Loan is under Silver Hill's $" + minAmt.toLocaleString("en-US") + " minimum.");
  if (amt && amt > maxAmt) return no("Loan is over Silver Hill's $" + maxAmt.toLocaleString("en-US") + " maximum.");
  const refi = s.transactionType && s.transactionType !== "purchase";
  const value = refi ? (s.currentValue || s.purchasePrice) : (s.purchasePrice && s.currentValue ? Math.min(s.purchasePrice, s.currentValue) : (s.purchasePrice || s.currentValue));
  if (amt && value && amt / value > 0.8001) return no("Silver Hill lends up to 80% of value; this is " + Math.round(amt / value * 1000) / 10 + "%.");
  return {
    lender: L, eligible: false, portalOnly: true, source: "model",
    reason: "Silver Hill may fit this " + (isDscr ? "rental" : "commercial") + " deal (" + pt + ", " + (st || "state not set") + "). They price it by hand in their broker portal (" + (isDscr ? "1-4 DSCR" : "Small Balance Commercial") + " calculator).",
    assumptions: [
      isDscr ? "Silver Hill DSCR: $100k-$2M, 30-yr fixed, up to 80% LTV, FICO " + minFico + "+, minimum DSCR 0.75, no tax returns, 10 prepay options." : "Silver Hill commercial: $100k-$2.5M, up to 80% LTV, FICO 650+ (no-doc streamline 700, 75% purchase / 70% refi LTV), 5-yr hybrid or fixed.",
      "Rules only: not a rate. Each price run in their portal creates a Deal Scenario record in the account, so it is not run automatically.",
    ],
  };
}
