import { createClient as __guardCreateClient } from "https://esm.sh/@supabase/supabase-js@2";
// Exports a loan file as a MISMO 3.4 Reference Model XML document -- the
// standard mortgage-industry format for exchanging loan data with
// investors, title/settlement systems, and other lenders (e.g. the outside
// lenders -- Kiavi/RELIP/RCN -- Erika coordinates with). Covers every field
// Bridgepoint's system actually captures via standard MISMO containers;
// business-purpose-loan specifics with no clean standard-residential MISMO
// equivalent (ARV, rehab budget, exit strategy, entity name, points
// charged) are carried in MISMO's own EXTENSION/OTHER mechanism, which is
// the correct place for lender-specific data. This is a faithful subset
// covering our data model, not a claim of passing every investor's
// specific MISMO validation profile -- those vary by investor/AUS.
//
// Was previously borrower-data-only. 2026-09-24: added the loan
// originator / loan origination company parties (with NMLS) and the
// borrower's SSN -- consolidating what used to be a second, less secure
// client-side export (which pulled the SSN via get_guarantor_ssn_full
// straight into the browser and was reachable by any LO regardless of
// whether they're assigned to the file). SSN inclusion here does its own
// owner/full-access/assigned-LO check against the caller's real JWT
// identity before ever decrypting anything -- same rule
// get_guarantor_ssn_full already enforces, just re-checked here because
// this function runs under the service-role key, where auth.uid() is
// null and that RPC's own check would always fail.
//
// 2026-09-25: company name/address/NMLS moved out of hardcoded constants
// into the company_settings table (same one the CRM's Settings page
// edits), so Joe can update these himself without needing source code
// changes redeployed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function xesc(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function attr(name: string, value: unknown): string {
  if (value == null || value === "") return "";
  return " " + name + "=\"" + xesc(value) + "\"";
}
function el(tag: string, value: unknown): string {
  if (value == null || value === "") return "";
  return "<" + tag + ">" + xesc(value) + "</" + tag + ">";
}

// Handles "123 Main St, City, ST 12345" and "123 Main St, City, ST, 12345".
function parseAddress(addr: string | null): { line: string; city: string; state: string; zip: string } {
  const out = { line: "", city: "", state: "", zip: "" };
  if (!addr) return out;
  const parts = String(addr).replace(/,\s*(USA|US|United States)\s*$/i, "").split(",").map((s) => s.trim()).filter(Boolean);
  out.line = parts[0] || "";
  out.city = parts[1] || "";
  const rest = parts.slice(2).join(" ").split(/\s+/).filter(Boolean);
  out.state = (rest.find((x) => /^[A-Za-z]{2}$/.test(x)) || "").toUpperCase();
  out.zip = (rest.find((x) => /^\d{5}(-\d{4})?$/.test(x)) || "").slice(0, 5);
  return out;
}

const LOAN_PURPOSE_MAP: Record<string, string> = {
  purchase: "Purchase", "rate/term refinance": "Refinance", "cash-out refinance": "Refinance",
  ratetermrefi: "Refinance", cashout: "Refinance", refinance: "Refinance",
};
const PROPERTY_TYPE_MAP: Record<string, string> = {
  "Single Family": "Detached", "SFR": "Detached", "Condo": "Condominium", "Townhome": "Attached",
  "2-4 Unit": "Detached", "Multifamily 5+": "Detached",
};
const UNITS_BY_TYPE: Record<string, number> = { "Single Family": 1, "SFR": 1, "Condo": 1, "Townhome": 1 };

type LoanOfficer = { name: string | null; email: string | null; phone: string | null; nmls: string | null } | null;
type CompanyInfo = { name: string; address: string; nmls: string };

// 2026-10-07: rewritten to standard MISMO 3.4 element form (data in child elements,
// PARTY/ROLE SequenceNumber + xlink:label). The earlier attribute style was not read by
// lenders' importers -- A&D's AIM ignored the borrower entirely until parties carried
// SequenceNumber/xlink labels (tested live on AIM's "Upload MISMO" screen).
function buildMismoXml(lead: Record<string, unknown>, lo: LoanOfficer, ssnFull: string | null, company: CompanyInfo): string {
  const addr = parseAddress(lead.property_address as string);
  const gAddr = parseAddress(lead.guarantor_address as string);
  const [firstName, ...restName] = ((lead.guarantor_first_name as string) ? [lead.guarantor_first_name as string, lead.guarantor_last_name as string] : String(lead.name || "").trim().split(/\s+/));
  const lastName = (lead.guarantor_last_name as string) || restName.join(" ");
  const loanPurpose = LOAN_PURPOSE_MAP[String(lead.transaction_type || "purchase").toLowerCase()] || "Purchase";
  const isCashOut = /cash/i.test(String(lead.transaction_type || ""));
  const propertyType = PROPERTY_TYPE_MAP[lead.property_type as string] || "";
  const units = (lead.num_units as number) || UNITS_BY_TYPE[lead.property_type as string] || null;
  const ssnDigits = ssnFull ? String(ssnFull).replace(/\D/g, "") : "";
  const [loFirst, ...loRest] = String(lo?.name || "").split(" ");
  const email = (lead.guarantor_email || lead.email) as string;
  const phone = String((lead.guarantor_phone || lead.phone || "") as string).replace(/\D/g, "").slice(-10);
  const citizenship: Record<string, string> = { "US Citizen": "USCitizen", "Permanent Resident": "PermanentResidentAlien", "Foreign National": "NonPermanentResidentAlien" };

  const ext = [
    ["ARVAmount", lead.arv], ["RehabBudgetAmount", lead.rehab_budget], ["ExitStrategyType", lead.exit_strategy],
    ["BorrowingEntityLegalName", lead.entity_legal_name], ["BorrowingEntityType", lead.entity_type],
    ["OriginationPointsPercent", lead.points_charged], ["LoanProgramName", lead.loan_type],
    ["MonthlyRentAmount", lead.rent_estimate], ["PrepaymentPenaltyTerm", lead.prepay_term],
    ["ExperienceDealsCount", lead.experience_deals],
  ].filter(([, v]) => v != null && v !== "");
  const extensionXml = ext.length ? "<EXTENSION><OTHER>" + ext.map(([n, v]) => "<BRIDGEPOINT_" + n + ">" + xesc(v) + "</BRIDGEPOINT_" + n + ">").join("") + "</OTHER></EXTENSION>" : "";

  const valuations = [
    lead.purchase_price != null ? ["PurchasePrice", lead.purchase_price] : null,
    lead.current_value != null ? ["Other", lead.current_value] : null,
  ].filter(Boolean) as Array<[string, unknown]>;

  const addressXml = (a: { line: string; city: string; state: string; zip: string }) =>
    "<ADDRESS>" + el("AddressLineText", a.line) + el("CityName", a.city) + el("StateCode", a.state) + el("PostalCode", a.zip) + el("CountryCode", "US") + "</ADDRESS>";

  const borrowerParty =
    '<PARTY SequenceNumber="1" xlink:label="PARTY1_1">' +
      "<INDIVIDUAL>" +
        "<CONTACT_POINTS>" +
          (email ? '<CONTACT_POINT SequenceNumber="1"><CONTACT_POINT_EMAIL>' + el("ContactPointEmailValue", email) + "</CONTACT_POINT_EMAIL></CONTACT_POINT>" : "") +
          (phone ? '<CONTACT_POINT SequenceNumber="2"><CONTACT_POINT_TELEPHONE>' + el("ContactPointTelephoneValue", phone) + "</CONTACT_POINT_TELEPHONE><CONTACT_POINT_DETAIL>" + el("ContactPointRoleType", "Mobile") + "</CONTACT_POINT_DETAIL></CONTACT_POINT>" : "") +
        "</CONTACT_POINTS>" +
        "<NAME>" + el("FirstName", firstName) + el("MiddleName", lead.guarantor_middle_name) + el("LastName", lastName) + "</NAME>" +
      "</INDIVIDUAL>" +
      (gAddr.line ? '<ADDRESSES><ADDRESS SequenceNumber="1">' + el("AddressLineText", gAddr.line) + el("AddressType", "Mailing") + el("CityName", gAddr.city) + el("PostalCode", gAddr.zip) + el("StateCode", gAddr.state) + "</ADDRESS></ADDRESSES>" : "") +
      "<ROLES>" +
        '<ROLE SequenceNumber="1" xlink:label="BORROWER_1">' +
          "<BORROWER>" +
            "<BORROWER_DETAIL>" + el("BorrowerBirthDate", lead.birthday ? String(lead.birthday).slice(0, 10) : null) + el("BorrowerClassificationType", "Primary") + "</BORROWER_DETAIL>" +
            (lead.citizenship_status && citizenship[lead.citizenship_status as string] ? "<DECLARATION><DECLARATION_DETAIL>" + el("CitizenshipResidencyType", citizenship[lead.citizenship_status as string]) + "</DECLARATION_DETAIL></DECLARATION>" : "") +
          "</BORROWER>" +
          "<ROLE_DETAIL>" + el("PartyRoleType", "Borrower") + "</ROLE_DETAIL>" +
        "</ROLE>" +
      "</ROLES>" +
      (ssnDigits ? '<TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER SequenceNumber="1">' + el("TaxpayerIdentifierType", "SocialSecurityNumber") + el("TaxpayerIdentifierValue", ssnDigits) + "</TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>" : "") +
    "</PARTY>";

  const companyParty =
    '<PARTY SequenceNumber="2" xlink:label="PARTY2_1">' +
      "<LEGAL_ENTITY><LEGAL_ENTITY_DETAIL>" + el("FullName", company.name) + "</LEGAL_ENTITY_DETAIL></LEGAL_ENTITY>" +
      (company.address ? (() => { const c = parseAddress(company.address); return '<ADDRESSES><ADDRESS SequenceNumber="1">' + el("AddressLineText", c.line) + el("CityName", c.city) + el("PostalCode", c.zip) + el("StateCode", c.state) + "</ADDRESS></ADDRESSES>"; })() : "") +
      '<ROLES><ROLE SequenceNumber="1" xlink:label="LOAN_ORIGINATION_COMPANY_1">' +
        (company.nmls ? '<LICENSES><LICENSE SequenceNumber="1"><LICENSE_DETAIL>' + el("LicenseIdentifier", company.nmls) + "</LICENSE_DETAIL></LICENSE></LICENSES>" : "") +
        "<ROLE_DETAIL>" + el("PartyRoleType", "LoanOriginationCompany") + "</ROLE_DETAIL>" +
      "</ROLE></ROLES>" +
    "</PARTY>";

  const originatorParty = lo?.name ? (
    '<PARTY SequenceNumber="3" xlink:label="PARTY3_1">' +
      "<INDIVIDUAL>" +
        "<CONTACT_POINTS>" +
          (lo.email ? '<CONTACT_POINT SequenceNumber="1"><CONTACT_POINT_EMAIL>' + el("ContactPointEmailValue", lo.email) + "</CONTACT_POINT_EMAIL></CONTACT_POINT>" : "") +
          (lo.phone ? '<CONTACT_POINT SequenceNumber="2"><CONTACT_POINT_TELEPHONE>' + el("ContactPointTelephoneValue", String(lo.phone).replace(/\D/g, "").slice(-10)) + "</CONTACT_POINT_TELEPHONE></CONTACT_POINT>" : "") +
        "</CONTACT_POINTS>" +
        "<NAME>" + el("FirstName", loFirst) + el("LastName", loRest.join(" ")) + "</NAME>" +
      "</INDIVIDUAL>" +
      '<ROLES><ROLE SequenceNumber="1" xlink:label="LOAN_ORIGINATOR_1">' +
        (lo.nmls ? '<LICENSES><LICENSE SequenceNumber="1"><LICENSE_DETAIL>' + el("LicenseIdentifier", lo.nmls) + "</LICENSE_DETAIL></LICENSE></LICENSES>" : "") +
        "<ROLE_DETAIL>" + el("PartyRoleType", "LoanOriginator") + "</ROLE_DETAIL>" +
      "</ROLE></ROLES>" +
    "</PARTY>") : "";

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas" xmlns:xlink="http://www.w3.org/1999/xlink" MISMOReferenceModelIdentifier="3.4.0">\n' +
    "<ABOUT_VERSIONS><ABOUT_VERSION>" + el("CreatedDatetime", new Date().toISOString()) + el("DataVersionIdentifier", "1") + "</ABOUT_VERSION></ABOUT_VERSIONS>\n" +
    "<DEAL_SETS><DEAL_SET><DEALS><DEAL>\n" +
    '<COLLATERALS><COLLATERAL SequenceNumber="1"><SUBJECT_PROPERTY>' +
      addressXml(addr) +
      "<PROPERTY_DETAIL>" + el("FinancedUnitCount", units) + el("PropertyEstateType", "FeeSimple") + el("PropertyUsageType", "Investment") + el("AttachmentType", propertyType === "Attached" ? "Attached" : (propertyType ? "Detached" : null)) + "</PROPERTY_DETAIL>" +
      (valuations.length ? "<PROPERTY_VALUATIONS>" + valuations.map(([m, v], i) => '<PROPERTY_VALUATION SequenceNumber="' + (i + 1) + '"><PROPERTY_VALUATION_DETAIL>' + el("PropertyValuationAmount", v) + el("PropertyValuationMethodType", m) + "</PROPERTY_VALUATION_DETAIL></PROPERTY_VALUATION>").join("") + "</PROPERTY_VALUATIONS>" : "") +
      (lead.purchase_price != null ? "<SALES_CONTRACTS><SALES_CONTRACT><SALES_CONTRACT_DETAIL>" + el("SalesContractAmount", lead.purchase_price) + "</SALES_CONTRACT_DETAIL></SALES_CONTRACT></SALES_CONTRACTS>" : "") +
    "</SUBJECT_PROPERTY></COLLATERAL></COLLATERALS>\n" +
    '<LOANS><LOAN LoanRoleType="SubjectLoan" SequenceNumber="1" xlink:label="LOAN_1">' +
      "<LOAN_DETAIL>" + el("BalloonIndicator", "false") + el("InterestOnlyIndicator", null) + "</LOAN_DETAIL>" +
      '<LOAN_IDENTIFIERS><LOAN_IDENTIFIER SequenceNumber="1">' + el("LoanIdentifier", lead.id) + el("LoanIdentifierType", "LenderLoan") + "</LOAN_IDENTIFIER></LOAN_IDENTIFIERS>" +
      (loanPurpose === "Refinance" ? "<REFINANCE>" + el("RefinanceCashOutDeterminationType", isCashOut ? "CashOut" : "NoCashOut") + "</REFINANCE>" : "") +
      "<TERMS_OF_LOAN>" + el("BaseLoanAmount", lead.loan_amount) + el("LienPriorityType", "FirstLien") + el("LoanPurposeType", loanPurpose) + el("MortgageType", "Other") + el("NoteAmount", lead.loan_amount) + el("NoteRatePercent", lead.rate) + "</TERMS_OF_LOAN>" +
      (lead.term_months != null ? "<MATURITY><MATURITY_RULE>" + el("LoanMaturityPeriodCount", lead.term_months) + el("LoanMaturityPeriodType", "Month") + "</MATURITY_RULE></MATURITY>" : "") +
      extensionXml +
    "</LOAN></LOANS>\n" +
    "<PARTIES>" + borrowerParty + companyParty + originatorParty + "</PARTIES>\n" +
    "</DEAL></DEALS></DEAL_SET></DEAL_SETS>\n</MESSAGE>\n";
}

// Mirrors get_guarantor_ssn_full's own owner/full-access/assigned-LO rule
// -- re-checked here (not just relied on from the RPC) because this
// function runs as service_role, where auth.uid() is null and that RPC's
// internal check would always fail regardless of who actually called us.
async function callerCanSeeSsn(req: Request, leadAssignedTo: string | null): Promise<boolean> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return false;
  const sbAsCaller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authErr } = await sbAsCaller.auth.getUser(token);
  if (authErr || !authData?.user) return false;
  const { data: userRow } = await sb.from("users").select("id,role,full_access").eq("auth_id", authData.user.id).single();
  if (!userRow) return false;
  return userRow.role === "owner" || userRow.full_access === true || userRow.id === leadAssignedTo;
}

Deno.serve(async (req: Request) => {
  // Staff-or-server only. This function is reachable from the public internet
  // (the anon key ships in the page), so without this check anyone could call it.
  {
    const guardToken = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    let guardOk = guardToken === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!guardOk && guardToken && req.method !== "OPTIONS") {
      const { data: guardUser } = await __guardCreateClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!).auth.getUser(guardToken).catch(() => ({ data: null }));
      guardOk = !!(guardUser && guardUser.user);
    }
    if (!guardOk && req.method !== "OPTIONS") {
      return new Response(JSON.stringify({ error: "not_authorized" }), { status: 403, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
    }
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const leadId: string = body.leadId;
    if (!leadId) return new Response(JSON.stringify({ error: "missing_lead_id" }), { status: 400, headers: CORS_HEADERS });

    const { data: lead, error } = await sb.from("leads").select("*").eq("id", leadId).single();
    if (error || !lead) return new Response(JSON.stringify({ error: "lead_not_found" }), { status: 404, headers: CORS_HEADERS });

    let lo: LoanOfficer = null;
    if (lead.assigned_to) {
      const { data: loRow } = await sb.from("users").select("name,email,phone,nmls_number").eq("id", lead.assigned_to).single();
      if (loRow) lo = { name: loRow.name, email: loRow.email, phone: loRow.phone, nmls: loRow.nmls_number };
    }

    const { data: settingsRow } = await sb.from("company_settings").select("*").eq("id", "default").maybeSingle();
    const company: CompanyInfo = {
      name: settingsRow?.company_name || "Bridgepoint Lending",
      address: settingsRow?.company_address || "",
      nmls: settingsRow?.company_nmls || "",
    };

    let ssnFull: string | null = null;
    if (lead.guarantor_ssn_encrypted && (await callerCanSeeSsn(req, lead.assigned_to))) {
      const { data: ssnData } = await sb.rpc("get_guarantor_ssn_full_unchecked", { p_lead_id: leadId });
      ssnFull = (ssnData as string) || null;
    }

    const xml = buildMismoXml(lead, lo, ssnFull, company);
    const missing: string[] = [];
    if (!lead.phone && !lead.guarantor_phone) missing.push("borrower phone");
    if (!lead.guarantor_address) missing.push("borrower mailing address");
    if (lead.guarantor_ssn_encrypted && !ssnFull) missing.push("SSN (not authorized to view, or not yet on file)");
    // NMLS doesn't apply to Bridgepoint at all -- business-purpose lending
    // isn't subject to individual SAFE Act/NMLS licensing, and Bridgepoint
    // itself carries no company NMLS either (that only applies to Anchor,
    // the separate future consumer-lending entity, which isn't this
    // system). Per Joe, 2026-09-25 -- not flagged as missing.

    return new Response(JSON.stringify({ ok: true, xml, missing }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
