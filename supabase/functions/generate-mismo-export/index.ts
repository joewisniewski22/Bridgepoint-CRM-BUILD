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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const COMPANY_NAME = "Bridgepoint Lending";
const COMPANY_ADDRESS = "1898 Merchants Row Blvd, Tallahassee, FL 32311";
// Blank until someone sets the real number -- same placeholder convention
// as index.html's own COMPANY_NMLS constant.
const COMPANY_NMLS = Deno.env.get("COMPANY_NMLS") || "";

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

function parseAddress(addr: string | null): { line: string; city: string; state: string; zip: string } {
  const out = { line: "", city: "", state: "", zip: "" };
  if (!addr) return out;
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  out.line = parts[0] || "";
  out.city = parts[1] || "";
  const stateZip = (parts[2] || "").split(" ").filter(Boolean);
  out.state = stateZip[0] || "";
  out.zip = stateZip[1] || "";
  return out;
}

const LOAN_PURPOSE_MAP: Record<string, string> = {
  purchase: "Purchase", "rate/term refinance": "NoCashOutRefinance", "cash-out refinance": "CashOutRefinance",
};
const PROPERTY_TYPE_MAP: Record<string, string> = {
  "Single Family": "Detached", "Condo": "Condominium", "Townhome": "Attached",
  "2-4 Unit": "TwoToFourUnitProperty", "Multifamily 5+": "FiveOrMoreUnitProperty",
};

type LoanOfficer = { name: string | null; email: string | null; phone: string | null; nmls: string | null } | null;

function buildMismoXml(lead: Record<string, unknown>, lo: LoanOfficer, ssnFull: string | null): string {
  const addr = parseAddress(lead.property_address as string);
  const [firstName, ...restName] = ((lead.guarantor_first_name as string) ? [lead.guarantor_first_name, lead.guarantor_last_name] : String(lead.name || "").split(" "));
  const lastName = (lead.guarantor_last_name as string) || restName.join(" ");
  const loanPurpose = LOAN_PURPOSE_MAP[(lead.transaction_type as string) || "purchase"] || "Purchase";
  const propertyType = PROPERTY_TYPE_MAP[lead.property_type as string] || "";
  const createdDatetime = new Date().toISOString();
  const ssnDigits = ssnFull ? String(ssnFull).replace(/\D/g, "") : "";
  const loName = lo?.name || "";
  const [loFirst, ...loRest] = loName.split(" ");
  const loLast = loRest.join(" ");

  const extensions = [
    { name: "ARVAmount", value: lead.arv },
    { name: "RehabBudgetAmount", value: lead.rehab_budget },
    { name: "ExitStrategyType", value: lead.exit_strategy },
    { name: "BorrowingEntityLegalName", value: lead.entity_legal_name },
    { name: "OriginationPointsPercent", value: lead.points_charged },
    { name: "LoanProgramName", value: lead.loan_type },
    { name: "LeadSourceName", value: lead.source },
  ].filter((e) => e.value != null && e.value !== "");

  const extensionXml = extensions.length
    ? "<EXTENSION><OTHER>" + extensions.map((e) => "<BRIDGEPOINT_" + e.name + ">" + xesc(e.value) + "</BRIDGEPOINT_" + e.name + ">").join("") + "</OTHER></EXTENSION>"
    : "";

  const taxpayerXml = ssnDigits
    ? ("              <TAXPAYER_IDENTIFIERS>\n" +
       '                <TAXPAYER_IDENTIFIER SequenceNumber="1">\n' +
       '                  <TAXPAYER_IDENTIFIER_DETAIL TaxpayerIdentifierType="SocialSecurityNumber" TaxpayerIdentifierValue="' + xesc(ssnDigits) + '"/>\n' +
       "                </TAXPAYER_IDENTIFIER>\n" +
       "              </TAXPAYER_IDENTIFIERS>\n")
    : "";

  const originationCompanyParty =
    "            <PARTY SequenceNumber=\"2\">\n" +
    "              <LEGAL_ENTITY>\n" +
    '                <LEGAL_ENTITY_DETAIL FullName="' + xesc(COMPANY_NAME) + '"/>\n' +
    "              </LEGAL_ENTITY>\n" +
    "              <ADDRESSES>\n" +
    '                <ADDRESS SequenceNumber="1" AddressLineText="' + xesc(COMPANY_ADDRESS) + '"/>\n' +
    "              </ADDRESSES>\n" +
    "              <ROLES>\n" +
    "                <ROLE>\n" +
    "                  <LICENSES>\n" +
    '                    <LICENSE SequenceNumber="1">\n' +
    '                      <LICENSE_DETAIL LicenseIdentifier="' + xesc(COMPANY_NMLS) + '"/>\n' +
    "                    </LICENSE>\n" +
    "                  </LICENSES>\n" +
    "                  <ROLE_DETAIL PartyRoleType=\"LoanOriginationCompany\"/>\n" +
    "                </ROLE>\n" +
    "              </ROLES>\n" +
    "            </PARTY>\n";

  const originatorParty =
    "            <PARTY SequenceNumber=\"3\">\n" +
    "              <INDIVIDUAL>\n" +
    "                <NAME" + attr("FirstName", loFirst) + attr("LastName", loLast) + "/>\n" +
    "                <CONTACT_POINTS>\n" +
    (lo?.email ? ('                  <CONTACT_POINT SequenceNumber="1"><CONTACT_POINT_EMAIL ContactPointEmailValue="' + xesc(lo.email) + '"/></CONTACT_POINT>\n') : "") +
    (lo?.phone ? ('                  <CONTACT_POINT SequenceNumber="2"><CONTACT_POINT_TELEPHONE ContactPointTelephoneValue="' + xesc(lo.phone) + '"/></CONTACT_POINT>\n') : "") +
    "                </CONTACT_POINTS>\n" +
    "              </INDIVIDUAL>\n" +
    "              <ROLES>\n" +
    "                <ROLE>\n" +
    "                  <LICENSES>\n" +
    '                    <LICENSE SequenceNumber="1">\n' +
    '                      <LICENSE_DETAIL LicenseIdentifier="' + xesc(lo?.nmls || "") + '"/>\n' +
    "                    </LICENSE>\n" +
    "                  </LICENSES>\n" +
    "                  <ROLE_DETAIL PartyRoleType=\"LoanOriginator\"/>\n" +
    "                </ROLE>\n" +
    "              </ROLES>\n" +
    "            </PARTY>\n";

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas" MISMOReferenceModelIdentifier="3.4.0">\n' +
    "  <ABOUT_VERSIONS>\n" +
    '    <ABOUT_VERSION CreatedDatetime="' + xesc(createdDatetime) + '" DataVersionIdentifier="1" MISMOReferenceModelIdentifier="3.4.0" SchemaVersionIdentifier="3.4"/>\n' +
    "  </ABOUT_VERSIONS>\n" +
    "  <DEAL_SETS>\n" +
    "    <DEAL_SET>\n" +
    "      <DEALS>\n" +
    '        <DEAL SequenceNumber="1">\n' +
    "          <COLLATERALS>\n" +
    '            <COLLATERAL SequenceNumber="1">\n' +
    "              <SUBJECT_PROPERTY_INDICATOR>true</SUBJECT_PROPERTY_INDICATOR>\n" +
    "              <SUBJECT_PROPERTY>\n" +
    "                <ADDRESS" + attr("AddressLineText", addr.line) + attr("CityName", addr.city) + attr("StateCode", addr.state) + attr("PostalCode", addr.zip) + "/>\n" +
    (propertyType ? ('                <PROPERTY_DETAIL PropertyEstateTypeType="FeeSimple" PropertyUsageType="Investment" PropertyTypeType="' + xesc(propertyType) + '"/>\n') : "") +
    (lead.purchase_price != null ? (
      "                <PROPERTY_VALUATIONS>\n" +
      '                  <PROPERTY_VALUATION SequenceNumber="1">\n' +
      '                    <PROPERTY_VALUATION_DETAIL PropertyValuationAmount="' + xesc(lead.purchase_price) + '" PropertyValuationMethodType="PurchasePrice"/>\n' +
      "                  </PROPERTY_VALUATION>\n" +
      "                </PROPERTY_VALUATIONS>\n"
    ) : "") +
    "              </SUBJECT_PROPERTY>\n" +
    "            </COLLATERAL>\n" +
    "          </COLLATERALS>\n" +
    "          <LOANS>\n" +
    '            <LOAN LoanRoleType="SubjectLoan" SequenceNumber="1">\n' +
    "              <LOAN_IDENTIFIERS>\n" +
    '                <LOAN_IDENTIFIER LoanIdentifier="' + xesc(lead.id) + '" LoanIdentifierType="LenderLoan"/>\n' +
    "              </LOAN_IDENTIFIERS>\n" +
    "              <TERMS_OF_LOAN>\n" +
    el("BaseLoanAmount", lead.loan_amount) +
    "\n                <LoanPurposeType>" + xesc(loanPurpose) + "</LoanPurposeType>\n" +
    (lead.rate != null ? ("                <NoteRatePercent>" + xesc(lead.rate) + "</NoteRatePercent>\n") : "") +
    (lead.term_months != null ? (
      "                <LoanMaturityPeriodCount>" + xesc(lead.term_months) + "</LoanMaturityPeriodCount>\n" +
      "                <LoanMaturityPeriodType>Month</LoanMaturityPeriodType>\n"
    ) : "") +
    (lead.ltv != null ? ("                <LTVRatioPercent>" + xesc(lead.ltv) + "</LTVRatioPercent>\n") : "") +
    "              </TERMS_OF_LOAN>\n" +
    extensionXml + "\n" +
    "            </LOAN>\n" +
    "          </LOANS>\n" +
    "          <PARTIES>\n" +
    '            <PARTY SequenceNumber="1">\n' +
    "              <INDIVIDUAL>\n" +
    "                <NAME" + attr("FirstName", firstName) + attr("LastName", lastName) + "/>\n" +
    "                <CONTACT_POINTS>\n" +
    (lead.guarantor_email || lead.email ? (
      '                  <CONTACT_POINT SequenceNumber="1">\n' +
      '                    <CONTACT_POINT_EMAIL ContactPointEmailValue="' + xesc(lead.guarantor_email || lead.email) + '"/>\n' +
      "                  </CONTACT_POINT>\n"
    ) : "") +
    (lead.guarantor_phone || lead.phone ? (
      '                  <CONTACT_POINT SequenceNumber="2">\n' +
      '                    <CONTACT_POINT_TELEPHONE ContactPointTelephoneValue="' + xesc(lead.guarantor_phone || lead.phone) + '"/>\n' +
      "                  </CONTACT_POINT>\n"
    ) : "") +
    "                </CONTACT_POINTS>\n" +
    "              </INDIVIDUAL>\n" +
    "              <ROLES>\n" +
    "                <ROLE>\n" +
    "                  <BORROWER>\n" +
    '                    <BORROWER_DETAIL BorrowerClassificationType="Primary"' + attr("CitizenshipResidencyType", lead.citizenship_status) + attr("BorrowerBirthDate", lead.birthday) + "/>\n" +
    (lead.credit_score != null ? (
      "                    <CREDIT_SCORES>\n" +
      '                      <CREDIT_SCORE SequenceNumber="1">\n' +
      "                        <CREDIT_REPOSITORY_SOURCE_TYPE>Other</CREDIT_REPOSITORY_SOURCE_TYPE>\n" +
      "                        <CreditScoreValue>" + xesc(lead.credit_score) + "</CreditScoreValue>\n" +
      "                      </CREDIT_SCORE>\n" +
      "                    </CREDIT_SCORES>\n"
    ) : "") +
    "                  </BORROWER>\n" +
    "                </ROLE>\n" +
    "              </ROLES>\n" +
    taxpayerXml +
    "            </PARTY>\n" +
    originationCompanyParty +
    originatorParty +
    "          </PARTIES>\n" +
    "        </DEAL>\n" +
    "      </DEALS>\n" +
    "    </DEAL_SET>\n" +
    "  </DEAL_SETS>\n" +
    "</MESSAGE>\n";
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

    let ssnFull: string | null = null;
    if (lead.guarantor_ssn_encrypted && (await callerCanSeeSsn(req, lead.assigned_to))) {
      const { data: ssnData } = await sb.rpc("get_guarantor_ssn_full_unchecked", { p_lead_id: leadId });
      ssnFull = (ssnData as string) || null;
    }

    const xml = buildMismoXml(lead, lo, ssnFull);
    const missing: string[] = [];
    if (!lead.phone && !lead.guarantor_phone) missing.push("borrower phone");
    if (!lead.guarantor_address) missing.push("borrower mailing address");
    if (lead.guarantor_ssn_encrypted && !ssnFull) missing.push("SSN (not authorized to view, or not yet on file)");
    if (!lo?.nmls) missing.push((lo?.name || "assigned LO") + "'s NMLS #");
    if (!COMPANY_NMLS) missing.push("company NMLS #");

    return new Response(JSON.stringify({ ok: true, xml, missing }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
