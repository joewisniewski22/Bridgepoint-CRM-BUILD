// Referral partner portal + borrower referral link (Joe 2026-10-14). Public edge function (no JWT): partners never touch the CRM or its tables.
//   Borrower side (no login):  ref_info, submit_lead            -- bplending.com/ref/?p=<code>
//   Partner side (login):      request_login, verify, me, referrals, price, submit_deal, logout  -- bplending.com/partner/
// Rules baked in: a borrower is always assigned to a Bridgepoint loan officer (the partner never owns the file); partners see plain
// status only -- never lender names, fees, YSP, internal notes or other partners' files; pricing shows Option A/B (rate + amount) only.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const CLIENT_URL = "https://app.bplending.com/";
const SITE_URL = "https://bplending.com";
const COMPANY_PHONE = "(850) 279-8588";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const LOAN_TYPES = ["DSCR", "Fix & Flip", "Bridge", "Ground Up Construction", "Mixed-Use", "Portfolio/Blanket"];
const RTL = ["Fix & Flip", "Bridge", "Ground Up Construction"];

const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max) : "");
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.]/g, "")); return isFinite(n) && n > 0 && n < 1e10 ? n : null; };
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randHex(bytes: number): string { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join(""); }
const post = (fn: string, payload: Record<string, unknown>) => fetch(SUPABASE_URL + "/functions/v1/" + fn, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY }, body: JSON.stringify(payload),
}).catch(() => null);

// What a partner is allowed to see about a referral's progress (no internal stage names).
function plainStatus(stage: string, status: string): string {
  if (status === "lost" || status === "dead" || stage === "lost") return "Not moving forward";
  if (status === "spam") return "Not moving forward";
  switch (stage) {
    case "new": case "attempting": return "Received — we're reaching out to the borrower";
    case "qualifying": return "In conversation with the borrower";
    case "app_sent": return "Application sent to the borrower";
    case "app_completed": return "Application received";
    case "docs": return "Collecting documents";
    case "processing": return "In processing";
    case "underwriting": return "In underwriting";
    case "approved": return "Conditionally approved";
    case "ctc": return "Clear to close";
    case "closed": case "postclosing": return "Funded";
    default: return "In progress";
  }
}
const partnerLabel = (p: Record<string, unknown>) => String(p.company || p.name || "Partner");

async function partnerByCode(code: string) {
  const c = clean(code, 20).toLowerCase();
  if (!/^[a-z0-9]{6,12}$/.test(c)) return null;
  const { data } = await sb.from("referral_partners").select("*").eq("ref_code", c).maybeSingle();
  return data && data.status === "approved" ? data : null;
}
async function partnerBySession(token: unknown) {
  const t = clean(token, 80);
  if (!/^[a-f0-9]{48,64}$/.test(t)) return null;
  const { data: s } = await sb.from("partner_sessions").select("partner_id,expires_at").eq("token_hash", await sha(t)).maybeSingle();
  if (!s || new Date(s.expires_at as string).getTime() < Date.now()) return null;
  const { data: p } = await sb.from("referral_partners").select("*").eq("id", s.partner_id).maybeSingle();
  return p && p.status === "approved" ? p : null;
}
async function partnerByEmail(email: string) {
  const esc = email.replace(/[\\%_]/g, "\\$&");
  for (const col of ["email", "portal_email"]) {
    const { data } = await sb.from("referral_partners").select("*").ilike(col, esc).eq("status", "approved").limit(1);
    if (data && data[0]) return data[0];
  }
  return null;
}
async function pickLO(partner: Record<string, unknown>): Promise<string> {
  if (partner.assigned_lo) return String(partner.assigned_lo);
  const { data, error } = await sb.rpc("pick_rotation_lo", { p_pool: "english" });
  return !error && data ? (data as string) : "owner";
}

// Sends a referred borrower their application link (from their assigned loan officer, by text + email). Bridgepoint copy only.
async function sendApplication(partner: Record<string, unknown>, leadId: string) {
  const { data: l } = await sb.from("leads").select("*").eq("id", leadId).eq("referral_partner_id", partner.id).maybeSingle();
  if (!l) return { error: "We couldn't find that referral." };
  if (["closed", "postclosing"].includes(String(l.stage)) || ["lost", "spam", "closed"].includes(String(l.status))) return { error: "This file is already closed out — call us if you need anything." };
  const acts = (Array.isArray(l.activity) ? l.activity : []) as Record<string, unknown>[];
  const recent = acts.filter((a) => a.kind === "partner-app-sent" && a.at && Date.now() - new Date(String(a.at)).getTime() < 12 * 3600000);
  if (recent.length) return { error: "The application was already sent in the last few hours. Give them a bit, or call us." };
  let token = l.application_token as string | null;
  if (!token) { token = crypto.randomUUID(); await sb.from("leads").update({ application_token: token }).eq("id", leadId); }
  const url = CLIENT_URL + "?apply=" + leadId + "&t=" + token;
  const { data: lo } = await sb.from("users").select("id,name,email,phone,photo_url").eq("id", l.assigned_to).single();
  const first = String(l.name || "there").split(/\s+/)[0], label = partnerLabel(partner), today = new Date().toISOString().slice(0, 10);
  const loName = (lo && lo.name) || "your loan officer";
  const msg = "Hi " + first + ", it's " + loName + " with Bridgepoint Lending. " + label + " asked me to get your application started. It takes about 10 minutes, and your information is kept secure. Here's your link: " + url + " — reply here or call (850) 279-8588 with any questions. (Reply STOP to opt out)";
  let texted = false;
  if (l.email) await post("send-email", { leadId, to: l.email, subject: "Your Bridgepoint Lending application", text: msg, fromName: loName, fromAddress: lo?.email, fromUserId: lo?.id, fromPhotoUrl: lo?.photo_url || null, initiatedBy: "ai" });
  if (l.phone && !l.sms_opt_out) { await post("send-text", { leadId, to: l.phone, text: msg, fromName: loName, initiatedBy: "ai" }); texted = true; }
  acts.push({ date: today, type: "system", kind: "partner-app-sent", at: new Date().toISOString(), text: "Application link sent to the borrower by " + label + " from the partner portal.", author: "System" });
  const patch: Record<string, unknown> = { activity: acts };
  if (["new", "attempting", "qualifying"].includes(String(l.stage))) { patch.stage = "app_sent"; patch.application_sent_at = today; }
  await sb.from("leads").update(patch).eq("id", leadId);
  if (lo) await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: lo.id, lead_id: leadId, kind: "hot-lead", text: (label + " just sent " + l.name + " their application link. Watch for it and follow up: " + CRM_URL + "?lead=" + leadId).slice(0, 400), date: today, read: false });
  return { ok: true, emailed: !!l.email, texted };
}

// Creates the borrower's file under a loan officer, tagged to the partner. `consented` = the borrower checked the box themselves, or the partner attested.
async function createReferralLead(partner: Record<string, unknown>, b: Record<string, unknown>, via: "link" | "partner", opts: { skipWelcome?: boolean } = {}) {
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase();
  const phoneDigits = clean(b.phone, 30).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const loanTypeRaw = clean(b.loanType, 40);
  const unsure = !LOAN_TYPES.includes(loanTypeRaw);
  const loanType = unsure ? "DSCR" : loanTypeRaw;
  const property = clean(b.propertyAddress, 160), notes = clean(b.notes, 500);
  // Optional deal details the partner can fill in (same file a borrower's own application would create). No SSN/DOB here: the borrower adds those in their own application.
  const deal: Record<string, unknown> = {};
  const refi = clean(b.transactionType, 20) === "refi";
  const pType = clean(b.propertyType, 40);
  if (pType) deal.property_type = pType;
  if (clean(b.transactionType, 20)) deal.transaction_type = refi ? "ratetermrefi" : "purchase";
  const price = num(b.purchasePrice); if (price) { if (refi) deal.current_value = price; else deal.purchase_price = price; }
  const rehab = num(b.rehabBudget); if (rehab) deal.rehab_budget = rehab;
  const arvN = num(b.arv); if (arvN) deal.arv = arvN;
  const rentN = num(b.rentEstimate); if (rentN) deal.rent_estimate = rentN;
  const loanAmt = num(b.loanAmount); if (loanAmt) deal.loan_amount = loanAmt;
  const credit = num(b.creditScore); if (credit && credit >= 300 && credit <= 850) deal.credit_score = Math.round(credit);
  const expN = b.experienceDeals === "" || b.experienceDeals == null ? null : Number(b.experienceDeals); if (expN != null && isFinite(expN) && expN >= 0 && expN < 1000) deal.experience_deals = Math.round(expN);
  const entName = clean(b.entityName, 120); if (entName) deal.entity_legal_name = entName;
  const dealBits = [price ? ((refi ? "value " : "price ") + "$" + Math.round(price).toLocaleString("en-US")) : "", rehab ? "rehab $" + Math.round(rehab).toLocaleString("en-US") : "", arvN ? "ARV $" + Math.round(arvN).toLocaleString("en-US") : "",
    rentN ? "rent $" + Math.round(rentN).toLocaleString("en-US") + "/mo" : "", loanAmt ? "wants $" + Math.round(loanAmt).toLocaleString("en-US") : "", credit ? "credit ~" + Math.round(credit) + " (partner's estimate — verify)" : "",
    expN != null && isFinite(expN) ? expN + " prior deals" : "", entName ? "entity " + entName : ""].filter(Boolean);
  if (name.length < 2) return { error: "Please enter the borrower's name." };
  if (phoneDigits.length !== 10) return { error: "Please enter a 10-digit phone number." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Please enter a valid email." };
  if (b.consent !== true) return { error: via === "link" ? "Please check the box so we can contact you." : "Please confirm the borrower agreed to be contacted." };
  const phone = "(" + phoneDigits.slice(0, 3) + ") " + phoneDigits.slice(3, 6) + "-" + phoneDigits.slice(6);
  const today = new Date().toISOString().slice(0, 10), stamp = new Date().toISOString();
  const label = partnerLabel(partner);

  // Already on file? Never duplicate and never take the file from whoever has it -- just note who else referred them.
  const { data: recent } = await sb.from("leads").select("id,name,phone,email,activity,assigned_to,status,referral_partner_id").neq("status", "spam");
  const dupe = (recent || []).find((l: Record<string, unknown>) =>
    (((l.phone as string) || "").replace(/\D/g, "").slice(-10) === phoneDigits) || (!!l.email && (l.email as string).toLowerCase() === email));
  if (dupe) {
    const activity = ((dupe.activity as unknown[]) || []).concat([{ date: today, type: "note", text: "Also referred by " + label + " (" + (via === "link" ? "their referral link" : "partner portal") + ") — already on file, no duplicate created" + (dupe.referral_partner_id ? "" : ". Attribution left as-is; tell Joe if " + label + " should get credit."), author: "System" }]);
    await sb.from("leads").update({ activity }).eq("id", dupe.id as string);
    if (dupe.assigned_to) await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: dupe.assigned_to, lead_id: dupe.id, kind: "hot-lead", text: (dupe.name as string) + " was just referred to us again by " + label + " — they're actively shopping", date: today, read: false });
    return { ok: true, repeat: true };
  }

  const assignee = await pickLO(partner);
  const id = "L" + crypto.randomUUID().slice(0, 8).toUpperCase();
  const appToken = crypto.randomUUID();
  const activity = [
    { date: today, type: "note", text: "Referred by " + label + " (" + clean(partner.role, 40) + ") via " + (via === "link" ? "their referral link" : "the partner portal") + ". " + (unsure ? "Wasn't sure which loan they need. " : "") + (notes ? "Partner/borrower note: " + notes + ". " : "") + (dealBits.length ? "Deal details entered by " + label + ": " + dealBits.join(", ") + "." : ""), author: "System" },
    { date: today, type: "system", text: via === "link"
      ? "TCPA consent recorded " + stamp + ": borrower checked the box agreeing to calls, texts and email from Bridgepoint Lending at " + phone + " / " + email + " (may be autodialed)."
      : "Consent: " + label + " confirmed on " + stamp + " that the borrower agreed to be contacted by Bridgepoint Lending at " + phone + " / " + email + ".", author: "System" },
  ];
  const { error } = await sb.from("leads").insert({
    id, name, email, phone, source: "Referral — " + label, loan_type: loanType, property_address: property || null,
    stage: "new", status: "active", assigned_to: assignee, created_at: today, created_at_ts: stamp, referral_partner_id: partner.id,
    ai_stage: "engaging", entity_type: "LLC", application_token: appToken, preferred_language: "en", activity, ...deal,
  });
  if (error) { console.error("partner-api insert", error.message); return { error: "We couldn't save that — please try again." }; }

  const alertText = "🔥 New referral from " + label + ": " + name + " — " + loanType + (property ? " at " + property : "") + ". Call now: " + CRM_URL + "?lead=" + id;
  await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: assignee, lead_id: id, kind: "hot-lead", text: alertText.slice(0, 400), date: today, read: false });
  const { data: lo } = await sb.from("users").select("id,name,email,phone,photo_url").eq("id", assignee).single();
  if (lo?.phone) await post("send-text", { to: lo.phone, text: alertText, fromName: "Bridgepoint CRM" });
  if (lo?.email) await post("send-email", { to: lo.email, subject: "New referral from " + label + ": " + name, text: alertText, fromName: "Bridgepoint CRM" });

  // Welcome to the borrower from their loan officer (consent recorded above). Deterministic copy, no AI.
  if (lo && !opts.skipWelcome) {
    const first = name.split(/\s+/)[0];
    const book = CLIENT_URL + "?book=" + assignee + "&forLead=" + id;
    const msg = "Hi " + first + ", it's " + lo.name + " with Bridgepoint Lending. " + label + " asked me to reach out about your " + (unsure ? "financing" : loanType) + " request. " +
      "Reply with the property address and I'll run numbers, or grab a quick call here: " + book + " (Reply STOP to opt out)";
    await post("send-email", { leadId: id, to: email, subject: "Your loan request — Bridgepoint Lending", text: msg, fromName: lo.name, fromAddress: lo.email, fromUserId: lo.id, fromPhotoUrl: lo.photo_url || null, initiatedBy: "ai" });
    await post("send-text", { leadId: id, to: phone, text: msg, fromName: lo.name, initiatedBy: "ai" });
  }
  return { ok: true, leadId: id, applyUrl: via === "link" ? (CLIENT_URL + "?apply=" + id + "&t=" + appToken) : undefined };
}

// ---- pricing (Option A/B only; same scenario shaping as ai-price-lead) ----
function stateOf(addr: string): string {
  const m = (addr || "").match(/\b([A-Z]{2})\b(?:\s+\d{5})?(?:-\d{4})?\s*(?:,\s*USA)?\s*$/) || (addr || "").match(/,\s*([A-Z]{2})\b/);
  return m ? m[1] : "";
}
function propType(t: string): string {
  const s = String(t || "").toLowerCase();
  if (/mixed/.test(s)) return "Mixed-Use"; if (/condo/.test(s)) return "Condo"; if (/5\+|multifamily|apartment/.test(s)) return "Multifamily 5+";
  if (/2-4|duplex|triplex|four|quad/.test(s)) return "2-4 Unit"; return "SFR";
}
async function priceDeal(b: Record<string, unknown>) {
  const lt = LOAN_TYPES.includes(clean(b.loanType, 40)) ? clean(b.loanType, 40) : "";
  if (!lt) return { error: "Choose a loan type." };
  const rtl = RTL.includes(lt), mixed = lt === "Mixed-Use";
  const addr = clean(b.propertyAddress, 160);
  if (!stateOf(addr)) return { error: "Enter the property address with the state (for example: 123 Main St, Tampa, FL 33602)." };
  const credit = num(b.creditScore), price = num(b.purchasePrice);
  if (!credit || credit < 500 || credit > 850) return { error: "Enter the borrower's credit score (estimate is fine)." };
  if (!price) return { error: "Enter the purchase price (or current value for a refinance)." };
  const refi = clean(b.transactionType, 20) === "refi";
  const value = price;
  const scenario = {
    loanType: mixed ? "DSCR" : lt, transactionType: refi ? "ratetermrefi" : "purchase", propertyAddress: addr, propertyState: stateOf(addr),
    propertyType: mixed ? "Mixed-Use" : propType(clean(b.propertyType, 40)), numUnits: null,
    creditScore: credit, purchasePrice: refi ? null : price, currentValue: refi ? price : null, currentLoanBalance: refi ? num(b.loanBalance) : null, loanAmount: num(b.loanAmount),
    rehabBudget: rtl ? num(b.rehabBudget) : null, arv: rtl ? num(b.arv) : null, rentEstimate: rtl ? null : num(b.rentEstimate),
    monthlyTaxes: rtl ? null : Math.round(value * 0.012 / 12), monthlyInsurance: rtl ? null : Math.round(value * 0.005 / 12), monthlyHoa: rtl ? null : 0,
    experienceDeals: num(b.experienceDeals) ?? 0, citizenshipStatus: "US Citizen", entityType: "LLC", rentalType: rtl ? null : "ltr",
    termMonths: rtl ? 12 : 360, prepayTerm: rtl ? "none" : "5yr", pointsCharged: 0, guarantorFirstName: "Scenario", guarantorLastName: "Check",
    decliningMarket: "no", vacationArea: "no", creditEvent: "no", appraisalTransfer: "no", plansReady: "no",
  };
  if (rtl && !scenario.arv) return { error: "Enter the after-repair value (ARV)." };
  if (!rtl && !scenario.rentEstimate) return { error: "Enter the monthly rent (market rent if it's vacant)." };
  const res = await fetch(SUPABASE_URL + "/functions/v1/check-live-rates", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY }, body: JSON.stringify({ lead: scenario }),
  }).then((r) => r.json()).catch(() => null);
  if (!res || !res.ok) return { error: "Pricing is busy right now — please try again in a minute." };
  const picks: { rate: number; loanAmount: number | null }[] = [];
  for (const r of (res.results || []) as any[]) {
    if (!r || !r.eligible || !(r.options || []).length) continue;
    const opts = (r.options as any[]).filter((o) => rtl || ((o.price >= 99.9995) && o.revenuePts == null));
    if (!opts.length) continue;
    const best = opts.reduce((a, c) => (c.rate < a.rate ? c : a));
    picks.push({ rate: best.rate, loanAmount: best.loanAmount || r.loanAmountUsed || r.maxLoanAmount || null });
  }
  picks.sort((a, c) => a.rate - c.rate);
  const top = picks.slice(0, 2);
  const term = rtl ? "12-month interest-only" : "30-year fixed";
  if (!top.length) {
    // Partners only ever see Bridgepoint talking: no reasons copied from anywhere else, no mention of lenders or sources.
    return { ok: true, options: [], reasons: [], note: "This one needs a quick conversation with your Bridgepoint loan officer — a small change to the structure often makes it work. Call " + COMPANY_PHONE + "." };
  }
  return { ok: true, term, options: top.map((p, i) => ({ label: "Option " + ["A", "B"][i], rate: p.rate, loanAmount: p.loanAmount ? Math.round(p.loanAmount) : null })),
    note: "Estimates only. Final terms depend on the appraisal and underwriting, and fees and points are confirmed by your Bridgepoint loan officer." };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const action = String(b.action || "");
  try {
    // ---------- borrower link (no login) ----------
    if (action === "ref_info") {
      const p = await partnerByCode(String(b.code || ""));
      return p ? json({ ok: true, partnerName: partnerLabel(p) }) : json({ ok: false }, 404);
    }
    if (action === "submit_lead") {
      if (clean(b.website)) return json({ ok: true }); // honeypot
      const p = await partnerByCode(String(b.code || ""));
      if (!p) return json({ error: "This referral link isn't active. Please contact whoever sent it to you." }, 404);
      const r = await createReferralLead(p, b, "link");
      return (r as any).error ? json({ error: (r as any).error }, 400) : json(r);
    }

    // ---------- partner login ----------
    if (action === "request_login") {
      const email = clean(b.email, 120).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: true }); // never reveal who has an account
      const p = await partnerByEmail(email);
      if (p) {
        const since = new Date(Date.now() - 3600000).toISOString();
        const { count } = await sb.from("partner_login_codes").select("id", { count: "exact", head: true }).eq("partner_id", p.id).gte("created_at", since);
        if ((count || 0) < 4) {
          const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
          await sb.from("partner_login_codes").insert({ partner_id: p.id, code_hash: await sha(code + ":" + p.id), expires_at: new Date(Date.now() + 15 * 60000).toISOString() });
          const link = SITE_URL + "/partner/?e=" + encodeURIComponent(email) + "&c=" + code;
          await post("send-email", { to: email, subject: "Your Bridgepoint partner login", fromName: "Bridgepoint Partners", fromAddress: "leads@bplending.com",
            text: "Hi " + String(p.name || "").split(/\s+/)[0] + ",\n\nYour Bridgepoint partner portal login code is " + code + " (good for 15 minutes).\n\nOr just tap this link to sign in:\n" + link + "\n\nIf you didn't ask for this, you can ignore this email.\n\nBridgepoint Lending" });
        }
      }
      return json({ ok: true });
    }
    if (action === "verify") {
      const email = clean(b.email, 120).toLowerCase(), code = clean(b.code, 10).replace(/\D/g, "");
      const p = await partnerByEmail(email);
      if (!p || code.length !== 6) return json({ error: "That code didn't work. Request a new one." }, 401);
      const { data: row } = await sb.from("partner_login_codes").select("*").eq("partner_id", p.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!row || new Date(row.expires_at as string).getTime() < Date.now() || (row.attempts as number) >= 5) return json({ error: "That code expired. Request a new one." }, 401);
      if (row.code_hash !== await sha(code + ":" + p.id)) {
        await sb.from("partner_login_codes").update({ attempts: (row.attempts as number) + 1 }).eq("id", row.id);
        return json({ error: "That code didn't work. Request a new one." }, 401);
      }
      await sb.from("partner_login_codes").delete().eq("partner_id", p.id);
      const token = randHex(24);
      await sb.from("partner_sessions").insert({ token_hash: await sha(token), partner_id: p.id, expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
      await sb.from("referral_partners").update({ last_login_at: new Date().toISOString() }).eq("id", p.id);
      return json({ ok: true, token, name: p.name });
    }

    // ---------- partner portal (logged in) ----------
    const p = await partnerBySession(b.token);
    if (!p) return json({ error: "session", detail: "Please sign in again." }, 401);

    if (action === "logout") {
      await sb.from("partner_sessions").delete().eq("token_hash", await sha(clean(b.token, 80)));
      return json({ ok: true });
    }
    if (action === "me" || action === "referrals") {
      const { data: leads } = await sb.from("leads").select("id,name,loan_type,property_address,loan_amount,stage,status,created_at,assigned_to,activity").eq("referral_partner_id", p.id).order("created_at_ts", { ascending: false }).limit(200);
      const { data: users } = await sb.from("users").select("id,name");
      const loName = (id: string) => String(((users || []).find((u: any) => u.id === id) || { name: "" }).name || "").split(/\s+/)[0];
      const rows = (leads || []).map((l: any) => {
        const acts = Array.isArray(l.activity) ? l.activity : [];
        const last = acts.length ? String(acts[acts.length - 1].date || "") : "";
        return { id: l.id, name: l.name, loanType: l.loan_type, property: l.property_address || null, loanAmount: l.loan_amount ? Number(l.loan_amount) : null,
          status: plainStatus(l.stage, l.status), funded: l.stage === "closed" || l.stage === "postclosing", submitted: l.created_at, updated: last || l.created_at, contact: loName(l.assigned_to) };
      });
      const stats = { total: rows.length, active: rows.filter((r) => !r.funded && r.status !== "Not moving forward").length, funded: rows.filter((r) => r.funded).length };
      return json({ ok: true, partner: { name: p.name, company: p.company, link: SITE_URL + "/ref/?p=" + p.ref_code, companyPhone: COMPANY_PHONE }, stats, referrals: rows });
    }
    if (action === "price") {
      const since = new Date(Date.now() - 86400000).toISOString();
      const { count } = await sb.from("partner_price_log").select("id", { count: "exact", head: true }).eq("partner_id", p.id).gte("created_at", since);
      if ((count || 0) >= 40) return json({ error: "You've reached today's pricing limit. Call us and we'll run more." }, 429);
      await sb.from("partner_price_log").insert({ partner_id: p.id });
      const r = await priceDeal(b);
      return (r as any).error ? json({ error: (r as any).error }, 400) : json(r);
    }
    if (action === "submit_deal") {
      const wantApp = b.sendApplication === true;
      const r: any = await createReferralLead(p, b, "partner", { skipWelcome: wantApp });
      if (r.error) return json({ error: r.error }, 400);
      if (wantApp && r.leadId) { const a: any = await sendApplication(p, r.leadId); return json({ ok: true, applicationSent: !!a.ok }); }
      return json({ ok: true });
    }
    if (action === "send_application") {
      const r: any = await sendApplication(p, clean(b.referralId, 20));
      return r.error ? json({ error: r.error }, 400) : json(r);
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("partner-api", action, String(e));
    return json({ error: "Something went wrong — please try again." }, 500);
  }
});
