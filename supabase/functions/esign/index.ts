// In-house e-signature (Joe 2026-10-07: "any signature signing works for now" -- DocuSign isn't
// needed). Takes one of our lender PDF forms, fills it from the loan file, emails each signer a
// personal link (CRM ?sign=<id>&s=<signer>&t=<token>), and stamps each person's drawn signature +
// date onto the form's own signature lines. When everyone has signed, the flattened PDF is filed
// on the loan as a received document and emailed to the LO + Joe.
//
// SSNs and the EIN are never pre-filled from the file: each signer types their own on the signing
// page, and they only ever land in the PDF (private bucket). We keep the last 4 digits for the record.
//
// Actions:
//   create {leadId, template, fromUserId?, cc?}   staff JWT or service key
//   view   {id, signer, token}                    public (token-checked)
//   sign   {id, signer, token, signature, ssn, ein?, typedName, consent}   public (token-checked)
//   list   {leadId}                               staff JWT or service key
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://app.bplending.com/";
const BUCKET = "lead-documents";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });

function tok(): string {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
const money = (n: unknown) => (n === null || n === undefined || n === "" || isNaN(Number(n))) ? "" : "$" + Math.round(Number(n)).toLocaleString("en-US");
const mdy = (d: unknown) => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[2] + "/" + m[3] + "/" + m[1] : ""; };
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const todayET = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "numeric" });

// "1613 COUNTRY LAKES DR APT 106 NAPERVILLE IL 60563" or "18120 Rockwell Ave, Homewood, IL 60430, USA"
const STREET_END = /^(\d+[A-Z]?|#\d+|DR|DRIVE|ST|STREET|AVE|AVENUE|RD|ROAD|LN|LANE|CT|COURT|BLVD|WAY|PL|PLACE|CIR|CIRCLE|TER|TERRACE|PKWY|HWY|TRL|APT|UNIT|STE|SUITE)$/i;
function splitAddress(a: unknown): { street: string; city: string; state: string; zip: string } {
  let s = clean(a).replace(/,?\s*(USA|United States)$/i, "");
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const m = parts[parts.length - 1].match(/^([A-Za-z]{2})\s*(\d{5})?/);
    return { street: parts.slice(0, parts.length - 2).join(", "), city: parts[parts.length - 2], state: m ? m[1].toUpperCase() : parts[parts.length - 1], zip: m && m[2] ? m[2] : "" };
  }
  const m = s.match(/^(.*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5})(-\d{4})?$/);
  if (!m) return { street: s, city: "", state: "", zip: "" };
  const toks = m[1].replace(/,/g, " ").split(/\s+/);
  let cut = -1;
  for (let i = 0; i < toks.length - 1; i++) if (STREET_END.test(toks[i])) cut = i;
  return { street: toks.slice(0, cut + 1).join(" "), city: toks.slice(cut + 1).join(" "), state: m[2].toUpperCase(), zip: m[3] };
}
const MARITAL: Record<string, string> = { "Married": "Married", "Unmarried": "Un-Married", "Un-Married": "Un-Married", "Single": "Un-Married", "Divorced": "Divorced" };
const CITIZEN: Record<string, string> = { "US Citizen": "US Citizen", "Permanent Resident": "Permanent Resident Alien", "Non-Permanent Resident": "Visa Holder", "Foreign National": "Foreign National" };

// ---------------------------------------------------------------------------------------------
// Templates. Field names read straight out of the PDF's own form (pdf.js, 10/7/26).
// ---------------------------------------------------------------------------------------------
type Signer = { key: string; role: string; name: string; email: string; phone?: string; token: string; signedAt?: string | null; ssnLast4?: string | null; ip?: string | null; ua?: string | null; typedName?: string | null };
type Template = {
  title: string; path: string;
  fill: (lead: any) => Record<string, string | boolean>;
  signers: (lead: any) => Array<Omit<Signer, "token">>;
  // where each signer's signature/date go, plus the fields their typed SSN fills
  sigs: Record<string, { page: number; sig: string; date: string; ssnFields: string[]; einField?: string }>;
  authDateField?: string;
};

const TEMPLATES: Record<string, Template> = {
  // Constructive / BPL Mortgage "RTL Business Purpose Loan Application 4.26" (3 pages; credit
  // authorization + signature lines on page 3).
  bpl_rtl_app: {
    title: "RTL Business Purpose Loan Application & Credit Authorization",
    path: "esign-templates/bpl_rtl_app_4_26.pdf",
    authDateField: "Authorization Date",
    sigs: {
      applicant: { page: 2, sig: "Applicant", date: "Date", ssnFields: ["Social Security NumberRow1", "SSN  Tax IDRow1"], einField: "EINRow1" },
      coapplicant: { page: 2, sig: "CoApplicant", date: "Date_2", ssnFields: ["Social Security NumberRow1_2", "SSN  Tax IDRow2"] },
    },
    signers(lead) {
      const out: Array<Omit<Signer, "token">> = [];
      const gName = clean([lead.guarantor_first_name, lead.guarantor_middle_name, lead.guarantor_last_name].filter(Boolean).join(" ")) || clean(lead.name);
      out.push({ key: "applicant", role: "Applicant", name: gName, email: clean(lead.guarantor_email || lead.email).toLowerCase(), phone: lead.guarantor_phone || lead.phone });
      if (lead.co_first_name || lead.co_last_name) {
        out.push({ key: "coapplicant", role: "Co-Applicant", name: clean([lead.co_first_name, lead.co_middle_name, lead.co_last_name].filter(Boolean).join(" ")), email: clean(lead.co_email).toLowerCase(), phone: lead.co_phone });
      }
      return out;
    },
    fill(lead) {
      const r = lead.rtl_app || {};
      const f: Record<string, string | boolean> = {};
      const home = splitAddress(lead.guarantor_address || r.homeAddress);
      // 1) Applicant
      f["First NameRow1"] = clean([lead.guarantor_first_name, lead.guarantor_middle_name].filter(Boolean).join(" "));
      f["Last NameRow1"] = clean(lead.guarantor_last_name);
      if (MARITAL[r.maritalStatus]) f["Dropdown33"] = MARITAL[r.maritalStatus];
      if (CITIZEN[lead.citizenship_status]) f["Dropdown34"] = CITIZEN[lead.citizenship_status];
      if (["Own", "Rent", "Other"].includes(r.ownRent)) f["Dropdown35"] = r.ownRent;
      f["Current Street AddressRow1"] = home.street; f["CityRow1"] = home.city; f["StateRow1"] = home.state; f["ZipRow1"] = home.zip;
      f["How Many YearsMoRow1"] = clean(r.yearsAtAddress);
      f["Phone NumberRow1"] = clean(lead.guarantor_phone || lead.phone);
      f["Email AddressRow1"] = clean(lead.guarantor_email || lead.email);
      f["Date of BirthRow1"] = mdy(lead.birthday);
      // 2) Co-Applicant
      if (lead.co_first_name || lead.co_last_name) {
        const co = splitAddress(lead.co_address);
        const sameHome = clean(lead.co_address).toUpperCase() === clean(lead.guarantor_address || r.homeAddress).toUpperCase();
        f["First NameRow1_2"] = clean([lead.co_first_name, lead.co_middle_name].filter(Boolean).join(" "));
        f["Last NameRow1_2"] = clean(lead.co_last_name);
        if (MARITAL[lead.co_marital_status]) f["Dropdown36"] = MARITAL[lead.co_marital_status];
        if (CITIZEN[lead.co_citizenship_status]) f["Dropdown37"] = CITIZEN[lead.co_citizenship_status];
        if (sameHome && ["Own", "Rent", "Other"].includes(r.ownRent)) f["Dropdown38"] = r.ownRent;
        f["Current Street AddressRow1_2"] = co.street; f["CityRow1_2"] = co.city; f["StateRow1_2"] = co.state; f["ZipRow1_2"] = co.zip;
        if (sameHome) f["How Many YearsMoRow1_2"] = clean(r.yearsAtAddress);
        f["Phone NumberRow1_2"] = clean(lead.co_phone);
        f["Email AddressRow1_2"] = clean(lead.co_email);
        f["Date of BirthRow1_2"] = mdy(lead.co_birthday);
      }
      // 3) Entity
      const ent = splitAddress(r.entityAddress);
      f["Entity NameRow1"] = clean(lead.entity_legal_name);
      const et = String(lead.entity_type || "");
      f["Dropdown39"] = et === "LLC" ? "LLC" : /S ?Corp/i.test(et) ? "S Corp" : /Partnership/i.test(et) ? "Partnership" : et ? "Other" : "";
      f["Date EstRow1"] = mdy(r.entityDateEst);
      f["Bank NameRow1"] = clean(r.entityBankName);
      f["Bank BalanceRow1"] = money(r.entityBankBalance);
      f["AddressRow1"] = ent.street; f["CityRow1_3"] = ent.city; f["StateRow1_3"] = ent.state; f["ZipRow1_3"] = ent.zip;
      f["Phone NumberRow1_3"] = clean(lead.phone);
      // Schedule A (up to 4 owners): name, title, address, own %, guarantor?, US citizen?
      (r.scheduleA || []).slice(0, 4).forEach((o: any, i: number) => {
        const n = i + 1, cb = i * 4;
        f["NameRow" + n] = clean(o.name); f["TitleRow" + n] = clean(o.title);
        f["Primary AddressRow" + n] = clean(o.address); f["Own Row" + n] = o.ownPct != null && o.ownPct !== "" ? o.ownPct + "%" : "";
        if (o.guarantor === "Yes") f["Check Box" + (cb + 1)] = true; else if (o.guarantor === "No") f["Check Box" + (cb + 2)] = true;
        if (o.citizen === "Yes") f["Check Box" + (cb + 3)] = true; else if (o.citizen === "No") f["Check Box" + (cb + 4)] = true;
      });
      // 4) Experience
      const exp = [lead.experience_deals != null ? "Guarantor: " + lead.experience_deals : "", (lead.co_first_name && lead.co_experience_deals != null) ? "Co-Guarantor: " + lead.co_experience_deals : ""].filter(Boolean).join(" / ");
      f["How many completed and exited investment projects have you participated in over the past three 3 years OR Experience to include but not limited to AgentBroker Appraiser Property Manager Real Estate Investor Inspector Development andor Construction"] = exp;
      // 5) Line of credit
      f["Existing LOC in place if Yes answer 5a if No answer 5d5e5f  5gRow1"] = clean(r.existingLoc);
      f["5a LOC Increase Requested if Yes answer 5b  5c if no answer 5gRow1"] = clean(r.locIncreaseRequested);
      f["5d Estimated Net WorthRow1"] = money(r.netWorth);
      f["5e Estimated LiquidityRow1"] = money(r.liquidity ?? lead.liquidity);
      f["5f Line of Credit RequestedRow1"] = money(r.locRequested);
      f["5g New Property Selected if yes complete Section 6  8Row1"] = lead.property_address ? "Yes" : "";
      // 6) Subject property & loan
      const p = splitAddress(lead.property_address);
      f["Dropdown40"] = lead.property_lease_status === "Vacant" ? "Vacant" : /Leased/i.test(lead.property_lease_status || "") ? "Leased" : "";
      f["Subject Street AddressRow1"] = p.street; f["CityRow1_4"] = p.city; f["StateRow1_4"] = p.state; f["ZipRow1_4"] = p.zip;
      const PT: Record<string, string> = { "SFR": " SFR", "Single Family": " SFR", "Condo": "Condo (Warrantable)-No GUC", "2-4 Unit": "2-4 Units (Residential Only)", "Duplex": "2-4 Units (Residential Only)" };
      if (PT[lead.property_type]) f["Dropdown1"] = PT[lead.property_type];
      f["Purchase Price if appRow1"] = money(lead.purchase_price);
      f["AsIs ValueRow1"] = money(lead.current_value);
      f["After Repaired ValueRow1"] = money(lead.arv);
      f["Name or Lock Box NumberRow1"] = clean(r.accessName); f["RelationshipRow1"] = clean(r.accessRelationship);
      f["PhoneRow1"] = clean(r.accessPhone); f["EmailRow1"] = clean(r.accessEmail);
      const tx = lead.transaction_type || (lead.delayed_purchase === "Yes" ? "delayed" : "purchase");
      f["Dropdown41"] = tx === "cashout" ? "Refinance - Cash-Out" : tx === "ratetermrefi" ? "Refinance - Rate & Term" : lead.delayed_purchase === "Yes" ? "Delayed Purchase" : "Purchase";
      f["Dropdown42"] = lead.exit_strategy === "Sell" ? "Sell" : lead.exit_strategy ? "Hold" : "";
      const tm = Number(lead.term_months || 0);
      f["Dropdown43"] = [12, 15, 18].includes(tm) ? tm + " Months" : "";
      const total = Number(lead.loan_amount || 0), rehab = Number(lead.rehab_budget || 0);
      f["Initial Loan AmountRow1"] = total ? money(Math.max(0, total - rehab)) : "";
      f["Financing for BudgetRow1"] = money(lead.rehab_budget);
      f["Total Loan Amount RequestedRow1"] = money(lead.loan_amount);
      const env = ((r.declarations || {}).environmental || {}).guarantor;
      f["Environmental Insp CompletedRow1"] = env === "Yes" ? "Yes" : env === "No" ? "No" : "";
      // 7) Current debt (refinance only)
      f["Balance owedRow1"] = money(r.balanceOwed); f["Current LenderRow1"] = clean(lead.current_lender_name || r.currentLender);
      f["Original CostRow1"] = money(r.originalCost); f["Year Acquired RefiRow1"] = clean(r.yearAcquired); f["Cost of Rehab CompletedRow1"] = money(r.improvementsCost);
      // 8) Contacts
      f["Title CompanyRow1"] = clean(r.titleCompany); f["ContactRow1"] = clean(r.titleContact);
      f["Insurance CarrierRow1"] = clean(r.insuranceCarrier); f["ContactRow1_2"] = clean(r.insuranceContact);
      f["Closing Agent CompanyRow1"] = clean(r.closingAgent); f["ContactRow1_3"] = clean(r.closingAgentContact);
      // 9) Declarations: [G-Yes, G-No, CG-Yes, CG-No] per question
      const D = r.declarations || {};
      const hasCo = !!(lead.co_first_name || lead.co_last_name);
      ([["lawsuit", 17], ["bankruptcy", 21], ["felony", 25], ["licensed", 29]] as Array<[string, number]>).forEach(([k, base]) => {
        const d = D[k] || {};
        if (d.guarantor === "Yes") f["Check Box" + base] = true; else if (d.guarantor === "No") f["Check Box" + (base + 1)] = true;
        if (hasCo) { if (d.coGuarantor === "Yes") f["Check Box" + (base + 2)] = true; else if (d.coGuarantor === "No") f["Check Box" + (base + 3)] = true; }
      });
      if ((D.bankruptcy || {}).explain) f["Have you been involved in bankruptcy or insolvency proceedings in the last 3 years"] = clean(D.bankruptcy.explain);
      if ((D.felony || {}).explain) f["Have you been charged or convicted of a felony_2"] = clean(D.felony.explain);
      // Comments: the form asks for an explanation for every owner who isn't a US citizen.
      const notes: string[] = [];
      const nonUs = [[f["First NameRow1"] + " " + f["Last NameRow1"], lead.citizenship_status], [hasCo ? f["First NameRow1_2"] + " " + f["Last NameRow1_2"] : "", lead.co_citizenship_status]]
        .filter(([n, c]) => n && c && c !== "US Citizen");
      nonUs.forEach(([n, c]) => notes.push(clean(n) + ": " + (c === "Permanent Resident" ? "Permanent Resident Alien (green card holder)." : c + ".")));
      f["Comments Section please use this section for any additional information regarding your applicationRow1"] = notes.join("\n");
      // Page 3 header
      const names = [clean([lead.guarantor_first_name, lead.guarantor_middle_name, lead.guarantor_last_name].filter(Boolean).join(" ")), hasCo ? clean([lead.co_first_name, lead.co_middle_name, lead.co_last_name].filter(Boolean).join(" ")) : ""].filter(Boolean);
      f["Applicants"] = names.join(" & ");
      f["Loan Number"] = lead.id;
      f["Property Address"] = clean(lead.property_address).replace(/,?\s*USA$/i, "");
      return f;
    },
  },
};

function applyFields(pdf: PDFDocument, fields: Record<string, string | boolean>) {
  const form = pdf.getForm();
  const missed: string[] = [];
  for (const [name, val] of Object.entries(fields)) {
    if (val === "" || val === false || val === null || val === undefined) continue;
    try {
      const fld: any = form.getField(name);
      const kind = fld.constructor.name;
      if (kind === "PDFCheckBox") fld.check();
      else if (kind === "PDFDropdown") fld.select(String(val));
      else {
        // Long / multi-line text (the comments box) auto-sizes to a huge font -- pin it.
        if (String(val).length > 60 || String(val).includes("\n")) { try { fld.enableMultiline(); fld.setFontSize(10); } catch (_e) { /* fixed-size field */ } }
        fld.setText(String(val));
      }
    } catch (_e) { missed.push(name); }
  }
  return missed;
}

async function download(path: string): Promise<Uint8Array> {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error("download_failed:" + path);
  return new Uint8Array(await data.arrayBuffer());
}
async function upload(path: string, bytes: Uint8Array) {
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error("upload_failed:" + error.message);
}

async function callerUserId(req: Request): Promise<string | null> {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  if (t === SERVICE_ROLE_KEY) return "service";
  const { data } = await sb.auth.getUser(t).catch(() => ({ data: null as any }));
  if (!data || !data.user) return null;
  const email = (data.user.email || "").toLowerCase();
  const { data: u } = await sb.from("users").select("id").ilike("email", email).maybeSingle();
  return u ? u.id : null;
}

async function sendEmail(o: { leadId: string; to: string; cc?: string; subject: string; text: string; fromUserId?: string | null; attachmentBase64?: string; attachmentName?: string; ctaUrl?: string; ctaLabel?: string }) {
  let from: any = null;
  if (o.fromUserId) { const { data } = await sb.from("users").select("id,name,email,photo_url").eq("id", o.fromUserId).maybeSingle(); from = data; }
  const r = await fetch(SUPABASE_URL + "/functions/v1/send-email", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_ROLE_KEY, apikey: SERVICE_ROLE_KEY },
    body: JSON.stringify({ leadId: o.leadId, to: o.to, cc: o.cc, subject: o.subject, text: o.text, fromName: from?.name, fromAddress: from?.email, fromUserId: from?.id, fromPhotoUrl: from?.photo_url || null, attachmentBase64: o.attachmentBase64, attachmentName: o.attachmentName, ctaUrl: o.ctaUrl, ctaLabel: o.ctaLabel }),
  }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  return !!(d && d.ok);
}

async function addToLead(leadId: string, activityText: string, doc?: any) {
  const { data: lead } = await sb.from("leads").select("activity,documents").eq("id", leadId).maybeSingle();
  if (!lead) return;
  const activity = Array.isArray(lead.activity) ? lead.activity : [];
  activity.push({ date: new Date().toISOString().slice(0, 10), type: "system", text: activityText, author: "E-Signature" });
  const upd: any = { activity };
  if (doc) { const docs = Array.isArray(lead.documents) ? lead.documents : []; docs.push(doc); upd.documents = docs; }
  await sb.from("leads").update(upd).eq("id", leadId);
}

function signLink(id: string, s: Signer) {
  return CRM_URL + "?sign=" + encodeURIComponent(id) + "&s=" + encodeURIComponent(s.key) + "&t=" + encodeURIComponent(s.token);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch (_e) { return json({ error: "bad_json" }, 400); }
  const action = body.action;
  try {
    // ------------------------------------------------------------------ create
    if (action === "create" || action === "list") {
      const uid = await callerUserId(req);
      if (!uid) return json({ error: "not_authorized" }, 401);
      if (action === "list") {
        const { data } = await sb.from("esign_requests").select("id,template,title,signers,status,created_at,completed_at,signed_path").eq("lead_id", body.leadId).order("created_at", { ascending: false });
        return json({ ok: true, requests: (data || []).map((r: any) => ({ ...r, signers: (r.signers || []).map((s: Signer) => ({ key: s.key, role: s.role, name: s.name, email: s.email, signedAt: s.signedAt || null, link: signLink(r.id, s) })) })) });
      }
      const tpl = TEMPLATES[body.template];
      if (!tpl) return json({ error: "unknown_template" }, 400);
      const { data: lead } = await sb.from("leads").select("*").eq("id", body.leadId).maybeSingle();
      if (!lead) return json({ error: "lead_not_found" }, 404);
      const signers: Signer[] = tpl.signers(lead).map((s) => ({ ...s, token: tok(), signedAt: null }));
      const bad = signers.filter((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email));
      if (bad.length) return json({ error: "missing_email", who: bad.map((s) => s.role) }, 400);
      const pdf = await PDFDocument.load(await download(tpl.path));
      const missed = applyFields(pdf, tpl.fill(lead));
      const id = "ES" + tok().slice(0, 10).toUpperCase();
      if (body.dryRun) {
        const preview = lead.id + "/esign/preview-" + id + ".pdf";
        await upload(preview, await pdf.save());
        const { data: su } = await sb.storage.from(BUCKET).createSignedUrl(preview, 1800);
        return json({ ok: true, dryRun: true, previewUrl: su?.signedUrl, missedFields: missed, signers: signers.map((s) => ({ role: s.role, name: s.name, email: s.email })) });
      }
      const current = lead.id + "/esign/" + id + "-current.pdf";
      await upload(current, await pdf.save());
      const fromUserId = uid === "service" ? (body.fromUserId || "owner") : uid;
      await sb.from("esign_requests").insert({ id, lead_id: lead.id, template: body.template, title: tpl.title, signers, current_path: current, status: "sent", created_by: fromUserId });
      const prop = clean(lead.property_address).replace(/,?\s*USA$/i, "");
      const sent: string[] = [];
      for (const s of signers) {
        const first = s.name.split(" ")[0];
        const text =
          "Hi " + first + ",\n\n" +
          "Your loan application for " + prop + " is ready for your signature. Everything is already filled in from your file — please review it, add your Social Security number, and sign the credit authorization so we can pull credit and keep your loan moving.\n\n" +
          "This link is just for you (" + s.name + ", " + s.role + "). It takes about 2 minutes. Click @@CTA_LINK@@ to review and sign.\n\n" +
          "—\n\nHola " + first + ":\n\n" +
          "Su solicitud de préstamo para " + prop + " está lista para su firma. Ya está llenada con la información de su expediente. Por favor revísela, agregue su número de Seguro Social y firme la autorización de crédito para que podamos revisar su crédito y avanzar con su préstamo.\n\n" +
          "Este enlace es solo para usted (" + s.name + "). Haga clic @@CTA_LINK@@ para revisar y firmar.\n\n" +
          "Bridgepoint Lending";
        const ok = await sendEmail({ leadId: lead.id, to: s.email, cc: body.cc || undefined, subject: "Please sign: loan application & credit authorization — " + s.name, text, fromUserId, ctaUrl: signLink(id, s) });
        if (ok) sent.push(s.name + " (" + s.email + ")");
      }
      await addToLead(lead.id, "Sent the " + tpl.title + " for e-signature to " + (sent.join(" and ") || "nobody — email failed") + (body.cc ? " (cc " + body.cc + ")" : "") + ".");
      return json({ ok: true, id, sent, missedFields: missed, links: signers.map((s) => ({ role: s.role, name: s.name, link: signLink(id, s) })) });
    }

    // ------------------------------------------------------------------ public: view / sign
    const { data: reqRow } = await sb.from("esign_requests").select("*").eq("id", body.id).maybeSingle();
    if (!reqRow) return json({ ok: false, error: "invalid" });
    const signers: Signer[] = reqRow.signers || [];
    const me = signers.find((s) => s.key === body.signer && s.token === body.token);
    if (!me) return json({ ok: false, error: "invalid" });
    const tpl = TEMPLATES[reqRow.template];
    const { data: lead } = await sb.from("leads").select("id,property_address,assigned_to").eq("id", reqRow.lead_id).maybeSingle();
    const { data: lo } = lead?.assigned_to ? await sb.from("users").select("name,phone").eq("id", lead.assigned_to).maybeSingle() : { data: null };

    if (action === "view") {
      const path = reqRow.signed_path || reqRow.current_path;
      const { data: su } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      return json({ ok: true, title: reqRow.title, name: me.name, role: me.role, signedAt: me.signedAt || null, complete: reqRow.status === "complete",
        property: clean(lead?.property_address).replace(/,?\s*USA$/i, ""), pdfUrl: su?.signedUrl || null, needsEin: !!(tpl.sigs[me.key] && tpl.sigs[me.key].einField),
        loName: lo?.name || null, loPhone: lo?.phone || null });
    }

    if (action === "sign") {
      if (me.signedAt) return json({ ok: true, already: true });
      if (!body.consent) return json({ ok: false, error: "consent_required" });
      const ssn = String(body.ssn || "").replace(/\D/g, "");
      if (ssn.length !== 9) return json({ ok: false, error: "ssn_required" });
      const ein = String(body.ein || "").replace(/\D/g, "");
      const m = String(body.signature || "").match(/^data:image\/png;base64,(.+)$/);
      if (!m) return json({ ok: false, error: "signature_required" });
      const typed = clean(body.typedName);
      if (typed.length < 3) return json({ ok: false, error: "name_required" });
      const spot = tpl.sigs[me.key];
      const pdf = await PDFDocument.load(await download(reqRow.current_path));
      const form = pdf.getForm();
      const today = todayET();
      const ssnFmt = ssn.slice(0, 3) + "-" + ssn.slice(3, 5) + "-" + ssn.slice(5);
      const vals: Record<string, string> = {};
      spot.ssnFields.forEach((f) => { vals[f] = ssnFmt; });
      if (spot.einField && ein.length === 9) vals[spot.einField] = ein.slice(0, 2) + "-" + ein.slice(2);
      vals[spot.date] = today;
      if (tpl.authDateField) { try { if (!form.getTextField(tpl.authDateField).getText()) vals[tpl.authDateField] = today; } catch (_e) { /* no field */ } }
      applyFields(pdf, vals);
      // Stamp the drawn signature inside the signature field's box, with a small audit line under it.
      const sigField = form.getTextField(spot.sig);
      const rect = sigField.acroField.getWidgets()[0].getRectangle();
      const page = pdf.getPages()[spot.page];
      const png = await pdf.embedPng(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
      const scale = Math.min((rect.width - 4) / png.width, (rect.height + 10) / png.height);
      page.drawImage(png, { x: rect.x + 2, y: rect.y + 1, width: png.width * scale, height: png.height * scale });
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
      page.drawText("e-signed by " + typed + " on " + today + " (" + reqRow.id + ")", { x: rect.x + 2, y: rect.y - 7, size: 5.5, font, color: rgb(0.35, 0.35, 0.35) });
      me.signedAt = new Date().toISOString(); me.ssnLast4 = ssn.slice(-4); me.ip = ip; me.ua = (req.headers.get("user-agent") || "").slice(0, 200); me.typedName = typed;
      const allDone = signers.every((s) => s.signedAt);
      let finalPath: string | null = null;
      if (allDone) { form.flatten(); finalPath = reqRow.lead_id + "/esign/" + reqRow.id + "-signed.pdf"; }
      const bytes = await pdf.save();
      await upload(allDone ? finalPath! : reqRow.current_path, bytes);
      await sb.from("esign_requests").update({ signers, status: allDone ? "complete" : "partial", signed_path: finalPath, completed_at: allDone ? new Date().toISOString() : null }).eq("id", reqRow.id);
      const label = tpl.title;
      // Per-request alerts (esign_requests.notify): {textTo:"631...", emailCompleteTo:["x@y.com"], emailCompleteNote:"..."}
      const notify = reqRow.notify || {};
      const externalSent: string[] = [], externalFailed: string[] = [];
      if (allDone) {
        const fileName = "Signed - " + label.replace(/[^A-Za-z0-9 &-]/g, "") + ".pdf";
        await addToLead(reqRow.lead_id, me.name + " (" + me.role + ") e-signed the " + label + ". All signatures are in — the signed PDF is filed under Documents.",
          { name: "Signed Loan Application & Credit Authorization", status: "received", fileName, storagePath: finalPath, receivedAt: new Date().toISOString().slice(0, 10), requestedAt: reqRow.created_at.slice(0, 10), esignId: reqRow.id });
        let b64 = ""; const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
        b64 = btoa(b64);
        const { data: staff } = await sb.from("users").select("id,email").in("id", [lead?.assigned_to || "", reqRow.created_by || "", "owner"].filter(Boolean));
        const to = Array.from(new Set((staff || []).map((u: any) => u.email).filter(Boolean)));
        for (const addr of to) {
          await sendEmail({ leadId: reqRow.lead_id, to: addr as string, subject: "Signed: " + label + " — " + (lead?.property_address || reqRow.lead_id), text: "All signers have e-signed the " + label + " for loan " + reqRow.lead_id + " (" + signers.map((s) => s.name).join(", ") + "). The signed PDF is attached and filed on the loan under Documents.", attachmentBase64: b64, attachmentName: fileName });
        }
        // Outside recipients chosen by staff for this request (e.g. the lender's processor).
        const prop = clean(lead?.property_address).replace(/,?\s*USA$/i, "");
        for (const addr of (Array.isArray(notify.emailCompleteTo) ? notify.emailCompleteTo : [])) {
          const ok = await sendEmail({ leadId: reqRow.lead_id, to: addr, cc: notify.emailCompleteCc || undefined, fromUserId: reqRow.created_by,
            subject: "Signed application & credit authorization — " + signers.map((s) => s.name).join(" & ") + " — " + prop,
            text: (notify.emailCompleteNote ? notify.emailCompleteNote + "\n\n" : "") + "Attached is the signed loan application and credit authorization for " + signers.map((s) => s.name).join(" and ") + " (" + prop + ").\n\nThank you,",
            attachmentBase64: b64, attachmentName: fileName });
          (ok ? externalSent : externalFailed).push(addr);
        }
        if (externalSent.length) await addToLead(reqRow.lead_id, "Emailed the signed application & credit authorization to " + externalSent.join(", ") + ".");
      } else {
        await addToLead(reqRow.lead_id, me.name + " (" + me.role + ") e-signed the " + label + ". Waiting on: " + signers.filter((s) => !s.signedAt).map((s) => s.name).join(", ") + ".");
      }
      if (notify.textTo) {
        const waiting = signers.filter((s) => !s.signedAt).map((s) => s.name);
        const msg = me.name + " (" + me.role + ") just e-signed the application for " + clean(lead?.property_address).replace(/,?\s*USA$/i, "") + ". " +
          (allDone ? "All signatures are in. Signed copy filed on the loan" + (externalSent.length ? " and emailed to " + externalSent.join(", ") : "") + "." + (externalFailed.length ? " EMAIL FAILED to " + externalFailed.join(", ") + "." : "")
                   : "Still waiting on " + waiting.join(", ") + ".");
        await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_ROLE_KEY, apikey: SERVICE_ROLE_KEY }, body: JSON.stringify({ to: notify.textTo, text: msg, fromName: "Bridgepoint E-Sign" }) }).catch(() => null);
      }
      return json({ ok: true, complete: allDone });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 200) }, 500);
  }
});
