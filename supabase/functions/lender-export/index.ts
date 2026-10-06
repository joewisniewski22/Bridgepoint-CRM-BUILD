// "Export to Lender" (Joe 2026-10-06): Joe, Erika or Fiore clicks Export to
// Lender on a file; the Bridgepoint Chrome extension opens the lender's portal,
// the staff member logs in themselves, and the extension fills the lender's
// application and uploads documents from this package. A person always reviews
// and clicks the lender's final Submit.
//
// Actions (POST JSON):
//   create  { leadId, lender }  -- signed-in staff session (Joe/Erika/Fiore). Returns a one-time token.
//   package { token }           -- the extension trades the token for the package (30-minute window).
//   log     { token, events }   -- the extension reports what it filled/uploaded; written to the file's activity.
//
// Deliberately NOT in the package: SSNs, bank account/routing numbers, the ACH
// form. Whoever is submitting types those into the lender's form themselves.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });

// Who may export files to lenders (Joe's rule: himself, Erika, Fiore).
const EXPORTERS = ["owner", "proc-erika", "lo-fiore"];
const LENDERS = ["Constructive", "RCN", "Kiavi", "A&D", "NextRes"];

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Our document names -> stable category keys the lender maps refer to.
const DOC_CATEGORIES: Array<[RegExp, string]> = [
  [/application \(bpl\)|loan application/i, "application"],
  [/photo id|driver|passport/i, "photo_id"],
  [/bank statement/i, "bank_statements"],
  [/proof of funds|liquidity verification/i, "proof_of_funds"],
  [/operating agreement|formation|articles/i, "entity_docs"],
  [/ein letter/i, "ein_letter"],
  [/good standing/i, "good_standing"],
  [/ownership schedule/i, "entity_ownership"],
  [/credit authorization/i, "credit_authorization"],
  [/purchase contract|assignment of contract/i, "purchase_contract"],
  [/mortgage statement|payoff/i, "payoff_or_mortgage_statement"],
  [/scope of work|rehab budget|construction budget/i, "scope_of_work"],
  [/contractor/i, "contractor_docs"],
  [/track record|real estate owned/i, "track_record"],
  [/lease|rent roll|market rent/i, "leases_rent"],
  [/tax bill/i, "tax_bill"],
  [/flood/i, "flood_insurance"],
  [/insurance|builder.s risk|liability/i, "insurance"],
  [/title commitment/i, "title_commitment"],
  [/closing protection|cpl/i, "cpl"],
  [/appraisal invoice/i, "appraisal_invoice"],
  [/appraisal/i, "appraisal"],
  [/plans|permit|feasibility/i, "construction_plans_permits"],
  [/hoa|coa|pud questionnaire/i, "hoa_docs"],
  [/hud-1|settlement statement/i, "prior_settlement_statement"],
  [/letter of explanation|loe/i, "letters_of_explanation"],
  [/voided check|wire instructions/i, "wire_instructions"],
];
function docCategory(name: string): string {
  for (const [re, key] of DOC_CATEGORIES) if (re.test(name || "")) return key;
  return "other";
}
const NEVER_SEND = /ach|automatic payment/i;

function splitAddress(a: string | null) {
  const t = String(a || "").replace(/,\s*(USA|US|United States)\s*$/i, "").trim();
  const m = /^(.*?),\s*([^,]+),\s*([A-Za-z]{2})\s*(\d{5})?(?:-\d{4})?$/.exec(t);
  return m ? { full: t, street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] || null } : { full: t, street: t, city: null, state: null, zip: null };
}

async function staffFrom(req: Request): Promise<{ id: string; name: string } | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await sb.auth.getUser(token).catch(() => ({ data: null as any }));
  const authId = data && data.user && data.user.id;
  if (!authId) return null;
  const { data: u } = await sb.from("users").select("id,name").eq("auth_id", authId).maybeSingle();
  return u && EXPORTERS.includes(u.id) ? u : null;
}

async function buildPackage(leadId: string, lender: string) {
  const { data: l, error } = await sb.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (error || !l) throw new Error("file not found");
  const docs: any[] = [];
  const received = (Array.isArray(l.documents) ? l.documents : []).filter((d: any) => d && d.status === "received" && !d.isTermSheetOption && !NEVER_SEND.test(d.name || ""));
  for (const d of received) {
    const files = [d.storagePath ? { storagePath: d.storagePath, fileName: d.fileName } : null].concat((d.files || []).map((f: any) => ({ storagePath: f.storagePath, fileName: f.fileName }))).filter((f: any) => f && f.storagePath);
    for (const f of files) {
      const { data: s } = await sb.storage.from("lead-documents").createSignedUrl(f.storagePath, 1800);
      if (s && s.signedUrl) docs.push({ name: d.name, category: docCategory(d.name), fileName: f.fileName || (d.name + ".pdf"), url: s.signedUrl });
    }
  }
  // A&D starts a loan from a MISMO 3.4 upload ("just upload your 3.4!" -- A&D wholesale
  // checklist). Generated server-side with the service key, which never includes the SSN.
  let mismo: { fileName: string; xml: string } | null = null;
  if (lender === "A&D") {
    const r = await fetch(SUPABASE_URL + "/functions/v1/generate-mismo-export", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_ROLE_KEY }, body: JSON.stringify({ leadId }) }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (j && j.ok && j.xml) mismo = { fileName: "Bridgepoint-" + leadId + "-MISMO34.xml", xml: j.xml };
  }
  const tr = Array.isArray(l.track_record) ? l.track_record : [];
  // The file's loan officer: lender portals ask which broker officer owns the loan.
  const { data: lo } = l.assigned_to ? await sb.from("users").select("name,email").eq("id", l.assigned_to).maybeSingle() : { data: null as any };
  const prop = splitAddress(l.property_address);
  return {
    meta: { leadId: l.id, lender, generatedAt: new Date().toISOString(), note: "SSNs and bank account numbers are intentionally not included.", loanOfficerName: lo ? lo.name : null, loanOfficerEmail: lo ? lo.email : null },
    loan: {
      loanType: l.loan_type, transactionType: l.transaction_type || "purchase", loanAmount: l.loan_amount, rate: l.rate, termMonths: l.term_months,
      ltv: l.ltv, purchasePrice: l.purchase_price, currentValue: l.current_value, arv: l.arv, rehabBudget: l.rehab_budget,
      currentLoanBalance: l.current_loan_balance, closeDate: l.close_date, exitStrategy: l.exit_strategy, prepayTerm: l.prepay_term,
      pointsCharged: l.points_charged,
    },
    property: {
      ...prop, propertyType: l.property_type, units: l.num_units, yearBuilt: l.built_year, occupied: l.property_occupied, leaseStatus: l.property_lease_status,
      monthlyRent: l.rent_estimate, monthlyTaxes: l.monthly_taxes, monthlyInsurance: l.monthly_insurance, monthlyHoa: l.monthly_hoa, rural: l.rural_status,
    },
    borrower: {
      entityName: l.entity_legal_name, entityType: l.entity_type,
      guarantor: {
        firstName: l.guarantor_first_name, middleName: l.guarantor_middle_name, lastName: l.guarantor_last_name, fullName: l.guarantor_name || l.name,
        email: l.guarantor_email || l.email, phone: l.guarantor_phone || l.phone, dateOfBirth: l.birthday, address: l.guarantor_address,
        citizenship: l.citizenship_status, countryOfDomicile: l.country_of_domicile, maritalStatus: l.marital_status, ownershipPct: l.guarantor_ownership_pct,
        creditScore: l.credit_score, experienceDeals: l.experience_deals, liquidity: l.liquidity, ssnLast4: l.guarantor_ssn_last4,
      },
      coGuarantor: l.co_first_name ? {
        firstName: l.co_first_name, middleName: l.co_middle_name, lastName: l.co_last_name, email: l.co_email, phone: l.co_phone, dateOfBirth: l.co_birthday,
        address: l.co_address, citizenship: l.co_citizenship_status, maritalStatus: l.co_marital_status, ownershipPct: l.co_ownership_pct,
        creditScore: l.co_credit_score, experienceDeals: l.co_experience_deals, liquidity: l.co_liquidity, ssnLast4: l.co_ssn_last4,
      } : null,
    },
    trackRecord: tr.map((t: any) => ({ address: t.address, purchaseDate: t.purchaseDate, purchasePrice: t.purchasePrice, rehabBudget: t.rehabBudget, exitDate: t.exitDate, exitValue: t.exitValue, exitType: t.exitType })),
    documents: docs,
    mismo,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "create") {
      const staff = await staffFrom(req);
      if (!staff) return json({ error: "not_allowed", detail: "Only Joe, Erika and Fiore can export files to lenders." }, 403);
      if (!body.leadId || !LENDERS.includes(body.lender)) return json({ error: "bad_request" }, 400);
      const token = randomToken();
      const { error } = await sb.from("lender_exports").insert({ token, lead_id: body.leadId, lender: body.lender, created_by: staff.id });
      if (error) return json({ error: "server_error", detail: error.message }, 500);
      return json({ ok: true, token, expiresInMinutes: 30 });
    }
    if (body.action === "package" || body.action === "log") {
      const token = String(body.token || "");
      if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "bad_token" }, 400);
      const { data: ex } = await sb.from("lender_exports").select("*").eq("token", token).maybeSingle();
      if (!ex || new Date(ex.expires_at).getTime() < Date.now()) return json({ error: "expired", detail: "This export link expired — click Export to Lender again in the CRM." }, 410);
      if (body.action === "package") {
        const pkg = await buildPackage(ex.lead_id, ex.lender);
        await sb.from("lender_exports").update({ fetched_at: new Date().toISOString() }).eq("id", ex.id);
        return json({ ok: true, package: pkg });
      }
      // log: append to the export record and to the file's activity
      const events = Array.isArray(body.events) ? body.events.slice(0, 50).map((e: any) => String(e).slice(0, 300)) : [];
      if (!events.length) return json({ ok: true });
      await sb.from("lender_exports").update({ log: (ex.log || []).concat(events.map((e: string) => ({ at: new Date().toISOString(), e }))) }).eq("id", ex.id);
      const { data: lead } = await sb.from("leads").select("activity").eq("id", ex.lead_id).maybeSingle();
      const activity = (lead && Array.isArray(lead.activity) ? lead.activity : []).concat([{ date: new Date().toISOString().slice(0, 10), type: "note", author: "Lender Export", text: "Export to " + ex.lender + ": " + events.join("; ").slice(0, 900) }]);
      await sb.from("leads").update({ activity }).eq("id", ex.lead_id);
      return json({ ok: true });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: "server_error", detail: String(err) }, 500);
  }
});
