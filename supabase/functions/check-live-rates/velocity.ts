// Velocity Mortgage Capital -- live pricing (Joe 2026-10-07: "velocity only requires a login,
// lets do that like we did rcn"). Velocity's broker portal (generatevelocity.com) has no
// standalone pricer; its product-selection page calls POST /api/GetPricing, which prices any
// scenario without creating a loan. We sign in with Joe's broker login (VELOCITY_USERNAME /
// VELOCITY_PASSWORD secrets, entered by Joe) through Velocity's Microsoft (Azure AD) sign-in,
// then call the same endpoint.
//
// Programs (portal, 10/7/26): Perm = 30-yr ($75K-$5M; 1-4, 5+, mixed-use, commercial);
// FixFlip = "Flex I/O" 24-mo interest-only, max 75% of as-is value, NO rehab holdback;
// ARVPro = discontinued. Broker rebate (YSP) up to 2% on the current matrix.

const TENANT = "cf53a247-d337-47ba-be5a-1efb52ec417b";
const CLIENT_IDS = ["5a085745-2b95-46e5-80f7-7efade63dc4d", "6e83e819-5748-4c9f-b86b-afc738d9beef"]; // "Broker Portal Client" first (the portal's own sign-in)
const API = "https://www.generatevelocity.com/api/";

let tokenMemo: { token: string; exp: number } | null = null;

export async function velocityToken(fresh = false): Promise<string> {
  if (!fresh && tokenMemo && tokenMemo.exp > Date.now() + 60000) return tokenMemo.token;
  const email = Deno.env.get("VELOCITY_USERNAME"), pass = Deno.env.get("VELOCITY_PASSWORD");
  if (!email || !pass) throw new Error("not_configured");
  // Velocity's Azure directory signs brokers in by an internal name, not the email typed on the
  // login page (the page maps it). Joe's, read from his own portal session 2026-10-07.
  const VEL_UPN: Record<string, string> = { "joe@bplending.com": "joe_bplending-com_uevjquvmhm@vccbrokerportal.onmicrosoft.com" };
  const user = Deno.env.get("VELOCITY_UPN") || VEL_UPN[email.trim().toLowerCase()] || email.trim();
  // The portal's API expects an access token for its own resource (seen in the browser's
  // requests 10/7/26: aud http://vccbrokerportal.onmicrosoft.com/api, appid = Broker Portal Client).
  const r = await fetch("https://login.microsoftonline.com/" + TENANT + "/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: CLIENT_IDS[0], resource: "http://vccbrokerportal.onmicrosoft.com/api", username: user.trim(), password: pass }),
  }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (d.access_token) { tokenMemo = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3000) * 1000 }; return d.access_token; }
  throw new Error((d.error_description || d.error || "login_failed").toString().split("\r")[0].slice(0, 160));
}

// ASP.NET anti-forgery pair: the site sets an XSRF-TOKEN cookie (plus its own antiforgery cookie)
// on page load, and the API wants the token echoed in X-XSRF-TOKEN.
let xsrfMemo: { cookie: string; token: string; at: number } | null = null;
async function velocityXsrf(): Promise<{ cookie: string; token: string }> {
  if (xsrfMemo && Date.now() - xsrfMemo.at < 20 * 60000) return xsrfMemo;
  const r = await fetch("https://www.generatevelocity.com/", { redirect: "follow" });
  const setc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : [r.headers.get("set-cookie") || ""];
  const pairs = setc.flatMap((c: string) => c.split(/,(?=\s*[^;,]+=)/)).map((c: string) => c.split(";")[0].trim()).filter(Boolean);
  const tokPair = pairs.find((p: string) => p.startsWith("XSRF-TOKEN="));
  xsrfMemo = { cookie: pairs.join("; "), token: tokPair ? decodeURIComponent(tokPair.slice(11)) : "", at: Date.now() };
  return xsrfMemo;
}

export async function velocityPost(path: string, body: unknown, retry = true): Promise<any> {
  const tok = await velocityToken();
  const x = await velocityXsrf();
  const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Authorization": "Bearer " + tok, "X-XSRF-TOKEN": x.token, "Cookie": x.cookie, "X-App-Source": "AngularJS" }, body: JSON.stringify(body) });
  if ((r.status === 401 || r.status === 403) && retry) { tokenMemo = null; await velocityToken(true); return velocityPost(path, body, false); }
  if (!r.ok) throw new Error("velocity_http_" + r.status);
  return r.json();
}

export async function velocityGet(path: string): Promise<any> {
  const tok = await velocityToken();
  const x = await velocityXsrf();
  const r = await fetch(API + path, { headers: { "Accept": "application/json", "Authorization": "Bearer " + tok, "X-XSRF-TOKEN": x.token, "Cookie": x.cookie, "X-App-Source": "AngularJS" } });
  return r.ok ? r.json() : { http: r.status };
}

const VEL_PROPERTY: Record<string, string> = {
  "SFR": "SingleFamilyResidence", "Single Family": "SingleFamilyResidence", "Condo": "SingleFamilyCondo", "Townhome": "SingleFamilyPUD",
  "2-4 Unit": "2to4Units", "Duplex": "2to4Units", "Multifamily 5+": "5plusUnits", "Mixed-Use": "MixedUse",
  "Office": "Office", "Retail": "Retail", "Warehouse": "Warehouse", "Self-Storage": "Storage", "Storage": "Storage",
  // Velocity's full PropertyType list (its reference API, 10/8/26) -- commercial added at Joe's OK.
  "Automotive": "Automotive", "Mobile Home Park": "MobileHomePark", "Commercial Condo": "CommercialCondo",
  "Day Care": "DayCare", "Mixed-Use (Commercial Heavy)": "Mixed Use - Commercial Heavy",
};
// Velocity's own values (portal code, 10/7/26): "US Citizen" | "Foreign National" (in the US, not a
// permanent resident) | "Foreign Investor" (lives abroad, no US credit) | "Foreign Investor with Credit".
// Velocity has no permanent-resident option -- green card holders go in as US Citizen.
function velCitizen(c: string | null, fico: number | null): string {
  if (c === "Non-Permanent Resident") return "Foreign National";
  if (c === "Foreign National") return fico ? "Foreign Investor with Credit" : "Foreign Investor";
  return "US Citizen";
}
const VEL_ENTITY: Record<string, string> = { "LLC": "Limited Liability Company", "Corporation": "Corporation", "Trust": "Trust", "Limited Partnership": "Limited Partnership", "General Partnership": "General Partnership", "Partnership": "General Partnership" };

export type VelScenario = {
  loanType: string; transactionType: string; propertyAddress: string; propertyState: string; propertyType: string; numUnits?: number | null;
  creditScore: number | null; purchasePrice: number | null; currentValue: number | null; loanAmount: number | null; rehabBudget: number | null; arv: number | null;
  entityType: string | null; citizenshipStatus: string | null; experienceDeals: number | null; currentLoanBalance?: number | null;
  prepayTerm?: string | null;
};
// Velocity's 30-yr carries a 5-yr step-down prepay (5/4/3/2/1%) by default; shorter ones are bought
// down for a fee (measured 10/7/26: 3-yr = +0.75 pts, 1-yr = +1.5 pts). PrepayBuydownYears = years removed.
const VEL_PREPAY_BUYDOWN: Record<string, number> = { "5yr": 0, "4yr": 1, "3yr": 2, "2yr": 3, "1yr": 4 };

function city(addr: string): string {
  const parts = String(addr || "").split(",").map((x) => x.trim());
  return parts.length >= 3 ? parts[parts.length - 3] : "";
}

export async function checkVelocity(s: VelScenario): Promise<any> {
  const L = "Velocity";
  const out: any = { lender: L, eligible: false, source: "live", assumptions: [] };
  const lt = s.loanType || "";
  if (lt === "Ground Up Construction") { out.reason = "Velocity doesn't do ground-up construction."; return out; }
  const program = (lt === "DSCR" || lt === "Portfolio/Blanket" || lt === "Mixed-Use") ? "Perm" : (lt === "Fix & Flip" || lt === "Bridge") ? "FixFlip" : null;
  if (!program) { out.reason = "Velocity doesn't offer " + lt + "."; return out; }
  const pt = VEL_PROPERTY[s.propertyType] || (lt === "Mixed-Use" ? "MixedUse" : null);
  if (!pt) { out.reason = "Velocity property type not mapped for " + s.propertyType + "."; return out; }
  if (!s.creditScore && s.citizenshipStatus !== "Foreign National") { out.reason = "Needs a credit score."; return out; }
  if (s.citizenshipStatus === "Permanent Resident") out.assumptions.push("Velocity prices permanent residents the same as US citizens.");
  const refi = s.transactionType && s.transactionType !== "purchase";
  const value = refi ? (s.currentValue || s.purchasePrice) : (s.purchasePrice && s.currentValue ? Math.min(s.purchasePrice, s.currentValue) : (s.purchasePrice || s.currentValue));
  if (!value) { out.reason = refi ? "Needs the current value." : "Needs the purchase price."; return out; }
  const purpose = !refi ? "Purchase" : s.transactionType === "cashout" ? "CashOutRefinance" : "Refinance";
  let prepayBuydown = 0;
  if (program === "Perm") {
    const pp = s.prepayTerm || "5yr";
    prepayBuydown = VEL_PREPAY_BUYDOWN[pp] ?? 0;
  }
  if (program === "FixFlip" && (s.rehabBudget || 0) > 0) out.assumptions.push("Velocity's fix & flip (Flex I/O) doesn't fund rehab — loan is on the as-is value only, rehab is the borrower's.");

  const base: any = {
    LoanGUID: "", PropertyType: [pt], PropertyCounties: [], PropertyCities: [city(s.propertyAddress)].filter(Boolean), PropertyState: (s.propertyState || "").toUpperCase(),
    FICO: s.creditScore || 0, CitizenshipStatus: velCitizen(s.citizenshipStatus, s.creditScore), OtherLienAmounts: [], NumberOfUnits: [s.numUnits || (pt === "2to4Units" ? 2 : 1)],
    LoanPurpose: purpose, MatrixDate: "", VestedEntity: (s.entityType || "LLC") !== "Individual", EntityType: (s.entityType || "LLC") === "Individual" ? "" : (VEL_ENTITY[s.entityType || "LLC"] || "Limited Liability Company"), OwnerOccupied: false,
    ProgramType: program, ARVInvestorExperienceLevel: Number(s.experienceDeals || 0), ProgramSubType: "", FirstTimeInvestor: !s.experienceDeals, FirstTimeBuyer: false,
    FixedTerm: "", BrokerRebatePoints: 0, RateBuydownFeePOC: 0, PrepayBuydownYears: prepayBuydown, RebateOrBuydown: "Buydown", LenderFeeBuydown: 0, RateOrFee: "Fee", PromoCodes: [],
    PurchasePrice: s.purchasePrice || 0, EstimatedCurrentValue: s.currentValue || value, EstimatedFutureValue: s.arv || 0, CostOfImprovements: 0,
    InitialDistribution: 0, Holdback: 0, PolicyExceptions: {}, SelectedLTC: 0, SelectedLTV: 0, SelectedARV: 0, SelectedARVProOption: 3, AddressPropTypes: "", LoanType: "", IOPeriod: 0, FixedPeriodType: "PI", NewModel: true,
  };
  // Highest leverage Velocity allows: try the requested amount, then step down to its max LTV.
  const tiers = s.loanAmount ? [Math.round(s.loanAmount / value * 1000) / 10] : [];
  for (const t of [80, 75, 70, 65, 60, 55, 50]) if (!tiers.length || t < tiers[0]) tiers.push(t);
  let first: any = null;
  const options: any[] = [];
  for (const ltv of tiers) {
    const amt = s.loanAmount && ltv === tiers[0] ? s.loanAmount : Math.floor(value * ltv / 100 / 500) * 500;
    if (amt < 75000) break;
    let d: any;
    try { d = await velocityPost("GetPricing", Object.assign({}, base, { LoanAmount: amt, LTV: ltv })); }
    catch (e) { const m = String((e as Error).message || e); return { lender: L, eligible: false, unavailable: true, reason: m === "not_configured" ? "Velocity isn't connected yet (add the Velocity login in Supabase)." : "Velocity pricing failed (" + m + ")." }; }
    if (!first) {
      first = d;
      // No-prepay request: only possible where the state itself bars prepay penalties.
      if (program === "Perm" && s.prepayTerm === "none" && !(d.PrepayTerms && d.PrepayTerms.NoPrepayState)) {
        out.reason = "Velocity's 30-year loan requires a prepayment penalty (1-year minimum) in " + (s.propertyState || "this state") + ". Price it with a 1–5 year prepay to see Velocity.";
        return out;
      }
    }
    const fatal = (d.PricingViolations || []).find((v: string) => !/LTV|Max loan|loan amount/i.test(v));
    if (fatal) { out.reason = "Velocity: " + fatal; return out; }
    if (!d.IsValid) continue;
    const lt2 = d.LoanTerms || {};
    const prepayPts = program === "Perm" ? Number((d.PrepayTerms && d.PrepayTerms.PrepayFeeAmount) || 0) : 0;
    const pts = Number(lt2.LenderFeePOC || 0) + prepayPts;
    const ppText = program === "Perm" && d.PrepayTerms ? (d.PrepayTerms.NoPrepayState ? " · no prepay (state)" : " · " + (String(d.PrepayTerms.PrepayYears || "").split(",").length) + "-yr prepay") : "";
    options.push({ program: (program === "Perm" ? "30-yr fixed" : "24-mo Flex I/O") + " · " + Math.round(ltv) + "% LTV" + ppText, rate: Number(d.FinalRate), price: 100 + pts, loanAmount: amt, lenderPoints: pts, term: lt2.FixedTerm || null, appraisalFee: (d.AppraisalFees || [])[0] || null, adjustments: String(d.RateAdjustmentString || "").split("#").filter(Boolean) });
    if (options.length >= 2) break;
  }
  if (!options.length) { out.reason = "Velocity: " + (((first && first.PricingViolations) || [])[0] || "no eligible leverage tier"); return out; }
  out.eligible = true;
  out.options = options;
  out.loanAmountUsed = options[0].loanAmount;
  out.maxLoanAmount = options[0].loanAmount;
  out.fees = { lenderFee: Math.round(options[0].loanAmount * options[0].lenderPoints / 100) };
  out.compCaps = { maxBrokerPoints: 3, maxYsp: 2.0 };
  out.assumptions.push("Live Velocity pricing (matrix " + ((first && first.MatrixDate) || "current") + "). Lender fee " + options[0].lenderPoints + " pts. Broker rebate up to 2% available.");
  return out;
}
