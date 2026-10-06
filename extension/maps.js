// Per-lender maps: which of the lender's screens we recognize, which package
// value goes in which field, and which document categories go in which upload
// slot. Built one lender at a time in a mapping session (staff logged in, test
// data only). A lender with no pages yet still gets the panel's copy-and-
// download view.
//
// Page shape:
//   { name, match: () => boolean,
//     fields: [ { label | selector (+index), value: "dotted.package.path" | (pkg)=>value, fmt?: money|pct|int|mdy|ymd|upper }
//             | { radioName | radioPrefix, value }        -- picks the radio whose value= matches
//             | { click: "css", index? }                  -- reveal-only buttons, never submit/sign/send
//             | { wait: ms } ],
//     uploads: [{ label, category | categories:[], slot: { label | selector } }] }
// Package paths: loan.*, property.*, borrower.entityName, borrower.guarantor.*, borrower.coGuarantor.*, trackRecord[], documents[]
(function () {
  const STATE_NAMES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District Of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };
  const stateName = (s) => STATE_NAMES[String(s || "").toUpperCase()] || "";
  // "123 Main St, Tampa, FL 33610" -> parts (guarantor home address is one string on our side).
  function splitAddr(a) {
    const t = String(a || "").replace(/,\s*(USA|US|United States)\s*$/i, "").trim();
    const m = /^(.*?),\s*([^,]+),\s*([A-Za-z]{2})\s*(\d{5})?/.exec(t);
    return m ? { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] || "" } : { street: t, city: "", state: "", zip: "" };
  }
  const yr = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 12));
  const isRental = (p) => /DSCR|Portfolio/i.test(p.loan.loanType || "");
  const isGuc = (p) => /Ground Up|Construction/i.test(p.loan.loanType || "");
  const isRtl = (p) => /Fix|Flip/i.test(p.loan.loanType || "");

  // ---------------- RCN Capital (BLN broker portal) ----------------
  // Mapped 2026-10-06 from the "Create New Loan" intake (one long wizard form,
  // #lenderIntakeForm). Field names are stable; rental rows carry a GUID suffix,
  // so those use name^= prefixes. Never touch "Email electronic authorization
  // to guarantor" or the submission-email checkbox -- the person decides.
  const RCN_EXP = (n) => (n == null ? null : n >= 30 ? "30+" : n >= 10 ? "10+" : n >= 5 ? "5+" : n >= 3 ? "3+" : n >= 1 ? "1+" : "0+");
  const RCN_PAGE = {
    name: "RCN application intake",
    match: () => !!document.getElementById("lenderIntakeForm"),
    fields: [
      { radioName: "haveSizer", value: () => "0" },
      { radioName: "havePricingID", value: () => "0" },
      // Broker officer = the file's LO (when RCN has them); processor = Erika.
      { name: "Broker officer", selector: '[name="brokerage[employee_id]"]', value: (p) => { const n = String(p.meta.loanOfficerName || "").toLowerCase(); const el = document.querySelector('[name="brokerage[employee_id]"]'); const o = el && n ? Array.from(el.options).find((x) => x.value && n.split(" ").every((w) => x.text.toLowerCase().includes(w.replace(/[^a-z]/g, "")))) : null; return o ? o.value : null; } },
      { name: "Broker processor", selector: '[name="brokerage[broker_processor_entity_id]"]', value: () => "Erika Trafny" },
      { radioName: "isPortfolio", value: (p) => (/Portfolio/i.test(p.loan.loanType || "") ? "yes" : "no") },
      { radioName: "loanProgram", value: (p) => (/Portfolio/i.test(p.loan.loanType || "") ? "LTRP" : isRental(p) ? "LTR" : /Bridge/i.test(p.loan.loanType || "") ? "STB" : isGuc(p) ? "GUC" : "RTL") },
      { wait: 400 },
      { radioName: "loanType", value: (p) => ({ purchase: "purchase", cashout: "refinance", ratetermrefi: "refinanceRateTerm" })[p.loan.transactionType || "purchase"] || "purchase" },
      { radioName: "exitStrat", value: (p) => { const e = String(p.loan.exitStrategy || "").toLowerCase(); return /sell|flip/.test(e) ? "sell" : /refi/.test(e) ? "refinance" : /hold|rent/.test(e) ? "hold" : (isRental(p) ? "hold" : "unsure"); } },
      // Borrower entity + primary guarantor
      { name: "Company name", selector: '[name="entityCompanyName"]', value: "borrower.entityName" },
      { name: "Entity type", selector: '[name="entityType"]', value: "borrower.entityType" },
      { name: "Guarantor email", selector: '[name="guarantorEmail"]', value: "borrower.guarantor.email" },
      { name: "Guarantor phone", selector: '[name="guarantorPhone"]', value: (p) => String(p.borrower.guarantor.phone || "").replace(/\D/g, "").slice(-10) },
      { name: "Guarantor first name", selector: '[name="guarantorFirstName"]', value: "borrower.guarantor.firstName" },
      { name: "Guarantor middle initial", selector: '[name="guarantorMiddleName"]', value: (p) => String(p.borrower.guarantor.middleName || "").slice(0, 1) },
      { name: "Guarantor last name", selector: '[name="guarantorLastName"]', value: "borrower.guarantor.lastName" },
      { name: "Citizenship", selector: '[name="guarantorCitizenship"]', value: (p) => ({ "US Citizen": "0", "Foreign National": "1", "Permanent Resident": "2" })[p.borrower.guarantor.citizenship] },
      { name: "Estimated FICO", selector: '[name="guarantorFICO"]', value: "borrower.guarantor.creditScore", fmt: "int" },
      { click: "#cantFindAddress", index: 0, when: (p) => !!p.borrower.guarantor.address },
      { name: "Guarantor street", selector: '[name="guarantorAddress"]', value: (p) => splitAddr(p.borrower.guarantor.address).street },
      { name: "Guarantor city", selector: '[name="guarantorCity"]', value: (p) => splitAddr(p.borrower.guarantor.address).city },
      { name: "Guarantor state", selector: '[name="guarantorState"]', value: (p) => stateName(splitAddr(p.borrower.guarantor.address).state) },
      { name: "Guarantor zip", selector: '[name="guarantorZip"]', value: (p) => splitAddr(p.borrower.guarantor.address).zip },
      // Property
      { name: "Property type", selector: '[name="propertyType"]', value: (p) => ({ "SFR": "6", "Duplex": "14", "2-4 Unit": "14", "Multifamily 5+": "9", "Mixed-Use": "8", "Condo": "2", "Townhome": "Townhome" })[p.property.propertyType] || "6" },
      { name: "Units", selector: '[name="howManyUnits"]', value: "property.units", fmt: "int" },
      { click: "#cantFindAddress", index: 1 },
      { name: "Property street", selector: '[name="propertyAddress"]', value: "property.street" },
      { name: "Property city", selector: '[name="propertyCity"]', value: "property.city" },
      { name: "Property state", selector: '[name="propertyState"]', value: (p) => stateName(p.property.state) },
      { name: "Property zip", selector: '[name="propertyZip"]', value: "property.zip" },
      { name: "Purchase price", selector: '[name="purchasePrice"]', value: "loan.purchasePrice", fmt: "money" },
      { name: "Payoff / existing debt", selector: '[name="payoffAmount"]', value: "loan.currentLoanBalance", fmt: "money" },
      { name: "As-is value", selector: '[name="propertyAsIsValue"]', value: (p) => p.loan.currentValue || p.loan.purchasePrice, fmt: "money" },
      { name: "Amount requested", selector: '[name="loanInfoAmountRequested"]', value: "loan.loanAmount", fmt: "money" },
      { name: "Loan term", selector: '[name="loanTerm"]', value: (p) => (isRental(p) ? "9" : ({ 9: "15", 12: "1", 18: "2" })[p.loan.termMonths] || "1") },
      { radioName: "renovationRadio", value: (p) => (isRental(p) ? null : (p.loan.rehabBudget > 0 ? "yes" : "no")) },
      { wait: 300 },
      { radioName: "nearbyExperience", value: (p) => (p.borrower.guarantor.experienceDeals > 0 ? "1" : (p.borrower.guarantor.experienceDeals === 0 ? "0" : null)) },
      { name: "Experience (sold/held)", selector: '[name="borrowerExperience"]', value: (p) => RCN_EXP(p.borrower.guarantor.experienceDeals) },
      { name: "Renovation experience", selector: '[name="borrowerRenovationExperience"]', value: (p) => RCN_EXP(p.borrower.guarantor.experienceDeals) },
      { name: "Target closing date", selector: '[name="targetClosingDate"]', value: "loan.closeDate", fmt: "ymd" },
      // Rental (DSCR) details -- per-property rows carry a GUID suffix
      { radioPrefix: "currentOccupancy_", value: (p) => (isRental(p) ? (/leased|occupied|yes/i.test(String(p.property.leaseStatus || p.property.occupied || "")) ? "leased" : "vacant") : null) },
      { radioPrefix: "leasingStrategy_", value: (p) => (isRental(p) ? "longTerm" : null) },
      { name: "Est. market rent", selector: '[name^="rentInfoEstimatedMonthlyRent_"]', value: (p) => (isRental(p) ? p.property.monthlyRent : null), fmt: "money" },
      { name: "Annual property tax", selector: '[name^="propertyAnnualTax_"]', value: (p) => yr(p.property.monthlyTaxes), fmt: "money" },
      { name: "Annual insurance", selector: '[name^="propertyAnnualInsurancePremium_"]', value: (p) => yr(p.property.monthlyInsurance), fmt: "money" },
      { name: "Annual HOA", selector: '[name^="rentInfoHOAorPUD_"]', value: (p) => (p.property.monthlyHoa ? yr(p.property.monthlyHoa) : null), fmt: "money" },
      // Fix & flip
      { name: "Hard cost", selector: '[name="renovationHardCost"]', value: (p) => (isRtl(p) ? p.loan.rehabBudget : null), fmt: "money" },
      { name: "Renovation budget", selector: '[name="renovationBudget"]', value: (p) => (isRtl(p) ? p.loan.rehabBudget : null), fmt: "money" },
      { name: "Estimated ARV", selector: '[name="estimatedARV"]', value: (p) => (isRtl(p) ? p.loan.arv : null), fmt: "money" },
      // Ground up
      { name: "GUC hard costs", selector: '[name="GUCtotalHardCosts"]', value: (p) => (isGuc(p) ? p.loan.rehabBudget : null), fmt: "money" },
      { name: "GUC total construction cost", selector: '[name="GUCtotalConsCost"]', value: (p) => (isGuc(p) ? p.loan.rehabBudget : null), fmt: "money" },
      { name: "GUC as-built value", selector: '[name="GUCbuiltValue"]', value: (p) => (isGuc(p) ? p.loan.arv : null), fmt: "money" },
    ],
    uploads: [
      { label: "Purchase contract", category: "purchase_contract", slot: { selector: "#documentsFileUpload_purchase_contract_optional" } },
      { label: "Rehab list / scope of work", category: "scope_of_work", when: (p) => !isGuc(p), slot: { selector: "#documentsFileUpload_rehab_list_optional" } },
      { label: "Construction budget", category: "scope_of_work", when: (p) => isGuc(p), slot: { selector: "#documentsFileUpload_construction_budget_optional" } },
      { label: "Lease / rent roll", category: "leases_rent", slot: { selector: "#documentsFileUpload_lease_agreement_optional" } },
      { label: "Plans & permits", category: "construction_plans_permits", slot: { selector: "#documentsFileUpload_plans_optional" } },
      { label: "Borrower experience", category: "track_record", slot: { selector: "#documentsFileUpload_borrower_exp_optional" } },
      { label: "Title agent", categories: ["title_commitment", "cpl"], slot: { selector: "#documentsFileUpload_title_agent_optional" } },
      { label: "Credit authorization", category: "credit_authorization", slot: { selector: "#guarantorFileUpload" } },
      { label: "Additional (entity, ID, funds, insurance)", categories: ["entity_docs", "ein_letter", "good_standing", "entity_ownership", "photo_id", "proof_of_funds", "bank_statements", "insurance", "appraisal"], slot: { selector: "#documentsFileUpload_additional_optional" } },
    ],
  };

  // ---------------- Kiavi (app.kiavi.com broker app) ----------------
  // Mapped 2026-10-06 by walking a TEST draft (6abfaa41e3bf) up to the soft-credit-pull
  // screen. One question per screen; React widgets, so every page uses run().
  // Uses the FILE's own LLC + guarantor (Joe): an existing Kiavi entity profile with
  // the same name is reused, otherwise a new one is created.
  // Left for the person on purpose: the 3 eligibility attestations (citizenship,
  // non-occupancy, broker AML training) and the credit/background consent boxes.
  const kvPath = (re) => () => re.test(location.pathname);
  const KV_ENTITY_TYPE = { LLC: "Limited Liability Company", Corporation: "Corporation", Individual: "Sole Proprietor / Natural Person", "Limited Partnership": "Limited Partnership", Trust: "Statutory Trust" };
  const kvExp = (n) => (n == null ? null : n >= 5 ? "5" : n >= 3 ? "3" : n >= 1 ? "1" : "0");
  const kvFicoBand = (score) => (t) => {
    const m = /(\d{3})\s*-\s*(\d{3})/.exec(t); if (m) return score >= +m[1] && score <= +m[2];
    const p = /(\d{3})\s*\+/.exec(t); if (p) return score >= +p[1];
    const b = /(below|under|<)\s*(\d{3})/i.exec(t); if (b) return score < +b[2];
    return false;
  };
  const kvAddress = async (p, H, res, street, city, state, zip) => {
    const ok = await H.typeaheadPick(document.querySelector('[name="inputLine1"]'), street, city);
    if (!ok) { // fall back to typing each part
      H.setNative(document.querySelector('[name="inputLine1"]'), street);
      H.setNative(document.querySelector('[name="inputCity"]'), city || "");
      H.setNative(document.querySelector('[name="inputZip"]'), zip || "");
      const st = Array.from(document.querySelectorAll('input[id^="bedrock-select-input"]')).pop();
      await H.comboPick(st, stateName(state));
    }
    res.filled.push("address " + street + ", " + city);
  };
  const KIAVI_PAGES = [
    { name: "Kiavi: choose program", match: kvPath(/\/start\/choose-program/), run: async (p, H, res) => {
      const prog = /DSCR|Portfolio/i.test(p.loan.loanType || "") ? "rental" : /Ground Up|Construction/i.test(p.loan.loanType || "") ? "hard_money_infill" : "hard_money";
      const r = document.getElementById("program-" + prog); if (r) { H.realClick(r); r.click(); res.filled.push("program " + prog); } else res.missing.push("program");
    } },
    { name: "Kiavi: entity + guarantor", match: kvPath(/\/new-loan-application/), run: async (p, H, res) => {
      const g = p.borrower.guarantor || {}, ent = p.borrower.entityName || "";
      const sel = document.querySelector('input[id^="bedrock-select-input"]');
      const existing = ent && await H.comboPick(sel, (t) => H.norm(t).startsWith(H.norm(ent + " (Entity)")));
      if (existing) {
        res.filled.push("existing Kiavi entity: " + ent);
        // An existing entity then asks which guarantor: reuse theirs, or create the file's guarantor.
        await H.sleep(800);
        const gsel = Array.from(document.querySelectorAll('input[id^="bedrock-select-input"]')).filter((e) => e.offsetParent !== null)[1];
        const gname = [g.firstName, g.lastName].filter(Boolean).join(" ");
        const gotG = gsel && gname && await H.comboPick(gsel, (t) => H.norm(t).startsWith(H.norm(gname + " (Individual)")));
        if (gotG) res.filled.push("existing guarantor: " + gname);
        else if (gsel) { await H.comboPick(gsel, "-- Create New Guarantor --"); await H.sleep(600); res.filled.push("new guarantor"); }
      }
      else {
        await H.comboPick(sel, "-- Create New Entity --");
        await H.sleep(800);
        H.setNative(document.querySelector('[name="borrower.entityName"]'), ent || [g.firstName, g.lastName].filter(Boolean).join(" "));
        await H.comboPick(H.inputAfterLabel("Entity Type"), KV_ENTITY_TYPE[p.borrower.entityType] || "Limited Liability Company");
        res.filled.push("new entity " + ent);
      }
      const ex = kvExp(g.experienceDeals); const rr = ex && document.querySelector('input[name="exitsLast24"][value="' + ex + '"]'); if (rr) { H.realClick(rr); res.filled.push("experience"); }
      const fn = document.querySelector('[name="borrower.firstName"]'); if (fn && !fn.value) { H.setNative(fn, g.firstName || ""); H.setNative(document.querySelector('[name="borrower.lastName"]'), g.lastName || ""); res.filled.push("guarantor"); }
      if (await H.clickNav("Next")) res.filled.push("→ Next");
    } },
    { name: "Kiavi: property address", match: kvPath(/\/(pre-calc-)?property-address$/), run: async (p, H, res) => {
      const l1 = document.querySelector('[name="inputLine1"]');
      if (!l1 || !l1.value) await kvAddress(p, H, res, p.property.street, p.property.city, p.property.state, p.property.zip);
      if (await H.clickNav("Next")) res.filled.push("→ Next");
    } },
    { name: "Kiavi: rate calculator", match: kvPath(/\/rate-calculator\/[^/]+\/hard-money/), run: async (p, H, res) => {
      const L = p.loan, P = p.property, g = p.borrower.guarantor || {};
      const refi = L.transactionType && L.transactionType !== "purchase";
      const set = (label, v) => { const i = H.inputAfterLabel(label); if (i && v != null && v !== "") { H.setNative(i, String(Math.round(Number(v)))); res.filled.push(label); } else res.missing.push(label); };
      await H.comboPick(H.inputAfterLabel("Property Type"), ({ "SFR": "Single Family", "Condo": "Condo", "Townhome": "Townhome", "2-4 Unit": "2-4", "Duplex": "2-4" })[P.propertyType] || "Single Family");
      if (g.creditScore) await H.comboPick(H.inputAfterLabel("Est. FICO Score"), kvFicoBand(Number(g.creditScore)));
      await H.comboPick(H.inputAfterLabel("Refinance"), refi ? "Yes" : "No");
      if (refi) { res.missing.push("refinance fields — check by hand"); }
      else {
        const rehab = Number(L.rehabBudget || 0);
        set("Purchase Price", L.purchasePrice);
        set("Purchase Loan Amount", L.loanAmount ? Math.max(0, Number(L.loanAmount) - rehab) : null); // day-one amount
        await H.comboPick(H.inputAfterLabel("Property Rehab"), rehab > 0 ? "Yes" : "No");
        if (rehab > 0) { set("Estimated Cost of Rehab", rehab); await H.comboPick(H.inputAfterLabel("Rehab Funds"), "Yes"); }
        set("After Repair Value (ARV)", L.arv || L.purchasePrice);
      }
      const bp = document.querySelector('[name="brokerOriginationPoints"]'); if (bp && L.pointsCharged != null) { H.setNative(bp, String(Math.min(3, Number(L.pointsCharged)))); res.filled.push("broker points"); }
      await H.sleep(2500);
      // Pick the loan row for the file's term (12/18/24 months).
      const term = (L.termMonths && [12, 18, 24].includes(Number(L.termMonths))) ? L.termMonths : 12;
      const btn = Array.from(document.querySelectorAll("button")).filter((b) => b.offsetParent !== null && /^Choose$/i.test(b.innerText.trim())).find((b) => { let c = b; for (let i = 0; i < 6 && c; i++) { c = c.parentElement; if (c && new RegExp("\\b" + term + " Months").test(c.innerText) && (c.innerText.match(/Months/g) || []).length === 1) return true; } return false; });
      if (btn) { H.realClick(btn); res.filled.push("chose " + term + "-month option"); } else res.missing.push("loan option for " + term + " months — pick it by hand");
    } },
    { name: "Kiavi: eligibility confirmations", match: kvPath(/\/eligibility-confirmations$/), run: async (p, H, res) => {
      res.missing.push("Check the 3 confirmations yourself (citizenship, non-occupancy, AML training), then Next");
    } },
    { name: "Kiavi: signing date", match: kvPath(/\/preferred-signing-date$/), run: async (p, H, res) => {
      const d = document.querySelector('[name="borrowerRequestedDateSigning"]');
      const iso = p.loan.closeDate; if (d && iso) { const [y, m, dd] = String(iso).slice(0, 10).split("-"); H.setNative(d, m + "/" + dd + "/" + y); res.filled.push("signing date"); if (await H.clickNav("Next")) res.filled.push("→ Next"); }
      else res.missing.push("signing date (no target close date on the file)");
    } },
    { name: "Kiavi: primary contact", match: kvPath(/\/broker-primary-contact$/), run: async (p, H, res) => {
      const y = document.querySelector('input[name="basic"][value="yes"]'); if (y) { H.realClick(y); res.filled.push("broker is primary contact"); }
      if (await H.clickNav("Next")) res.filled.push("→ Next");
    } },
    { name: "Kiavi: credit pull info", match: kvPath(/\/combined-confirmations$/), run: async (p, H, res) => {
      const g = p.borrower.guarantor || {};
      const em = document.querySelector('[name="inputEmail"]'); if (em && g.email) { H.setNative(em, g.email); res.filled.push("email"); }
      const dob = document.querySelector('[name="inputDateOfBirth"]'); if (dob && g.dateOfBirth) { const [y, m, d] = String(g.dateOfBirth).slice(0, 10).split("-"); H.setNative(dob, m + "/" + d + "/" + y); res.filled.push("date of birth"); }
      const a = splitAddr(g.address); if (a.street) await kvAddress(p, H, res, a.street, a.city, a.state, a.zip);
      res.missing.push("Check the credit + background consent boxes (borrower signed our credit authorization), then Next — this runs Kiavi's soft pull");
    } },
  ];

  window.BP_MAPS = {
    RCN: { host: /commerciallendingservicesllc\.com$/, pages: [RCN_PAGE] },
    Kiavi: { host: /kiavi\.com$/, pages: KIAVI_PAGES },
    "A&D": { host: /admortgage\.com$/, pages: [] },
    Constructive: { host: /bplhub\.com$/, pages: [] }, // portal side panel (copy + attach); full map built on the next real Constructive file
    NextRes: { host: null, pages: [] },
  };
})();
