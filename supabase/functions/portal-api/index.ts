// Server side of the borrower application / portal page (opened with ?apply=<lead id>&t=<token>).
// Until 10/12/2026 that page talked to the database directly with the public key and could read
// or edit every lead. Now it only talks to this function, which checks the file's application
// token on every call and only ever touches that one lead.
//
// Actions: get (also used for polling), save (whitelisted fields only), upload-url, signed-url, q-get / q-save (property questionnaire).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
// Answers the property questionnaire may store (the page sends only these).
const Q_KEYS = ["yearBuilt","numBuildings","totalUnits","vacantUnits","occupiedUnits","crossStreets","areaDescription","siteSize","siteSizeUnit","buildingSize","waterSource","municipal","wetlands","repairsNeeded","repairsDescribe","multipleParcels","recentSale","marijuanaAdult","rentRegulated","pollution","envAssessment","contamination","dryCleaner","storageTank","storageTankRemoved","rcraGenerator","occupantsRegulated","pendingSuit","waterDamage","moldPlan","currentUse","pastUse"];

// Never sent to the browser.
const HIDE = [
  "guarantor_ssn_encrypted", "co_ssn_encrypted", "ai_quote", "call_attempts", "activity", "ai_stage", "pricing_review_note",
  "pricing_review_requested_by", "lost_reason_note", "guideline_override_note", "capital_source", "servicer", "lo_dialed_at",
];

// The only columns a borrower's page may change.
const WRITABLE = new Set([
  "name", "email", "phone", "entity_type", "credit_score", "experience_deals", "liquidity", "property_address", "property_type",
  "exit_strategy", "purchase_price", "current_value", "current_loan_balance", "arv", "rehab_budget", "rent_estimate",
  "monthly_taxes", "monthly_insurance", "monthly_hoa", "loan_amount", "ltv", "term_months", "property_count", "birthday",
  "entity_legal_name", "guarantor_first_name", "guarantor_middle_name", "guarantor_last_name", "guarantor_phone", "guarantor_email",
  "guarantor_address", "guarantor_ownership_pct", "track_record", "reo", "reo_owns", "co_first_name", "co_middle_name", "co_last_name", "co_birthday",
  "co_ownership_pct", "co_phone", "co_email", "co_address", "co_citizenship_status", "co_country_of_domicile", "co_credit_score",
  "co_experience_deals", "co_liquidity", "co_marital_status", "citizenship_status", "country_of_domicile", "marital_status",
  "transaction_type", "prepay_term", "built_year", "current_lender_name", "units_ready_for_rent", "property_occupied", "taxes_current",
  "property_lease_status", "delayed_purchase", "est_closing_date", "short_term_rental", "ny_cema_loan", "ny_closing_attorney", "num_units", "num_residential_units",
  "num_commercial_units", "lease_detail", "ach_form", "rtl_app", "dscr_app", "scope_of_work", "guideline_check",
  "application_sent_at", "application_taken_at", "preferred_language",
]);
const STAGE_ORDER = ["new", "attempting", "qualifying", "app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
const strip = (row: Record<string, unknown>) => { const r = { ...row }; HIDE.forEach((k) => delete r[k]); return r; };

// What an application has to contain before the file counts as "Application Completed": the deal, not just the borrower.
function dealGaps(l: Record<string, any>): string[] {
  const gaps: string[] = [];
  const num = (x: unknown) => { const n = Number(x); return isFinite(n) && n > 0; };
  const type = String(l.loan_type || "");
  const rtl = ["Fix & Flip", "Bridge", "Ground Up Construction"].indexOf(type) !== -1;
  const purchase = !l.transaction_type || l.transaction_type === "purchase";
  const portfolio = type === "Portfolio/Blanket";
  if (!portfolio && !String(l.property_address || "").trim()) gaps.push("property address");
  if (portfolio && !num(l.property_count)) gaps.push("the list of properties");
  if (purchase ? !(num(l.purchase_price) || num(l.current_value)) : !(num(l.current_value) || num(l.purchase_price))) gaps.push(purchase ? "purchase price" : "current value");
  if (rtl && type !== "Bridge" && l.rehab_budget == null) gaps.push(type === "Ground Up Construction" ? "construction budget" : "rehab budget");
  if (rtl && type !== "Bridge" && !num(l.arv)) gaps.push("after-repair value (ARV)");
  if (!rtl && type && !num(l.rent_estimate)) gaps.push("monthly rent");
  return gaps;
}
// The borrower submitted but the deal is missing: leave the stage alone, say so on the file, tell the LO, and give them a task.
async function holdIncompleteApplication(lead: Record<string, any>, gaps: string[]) {
  const today = new Date().toISOString().slice(0, 10);
  const text = "Application submitted, but it is missing: " + gaps.join(", ") + ". The file stays at its current stage until the deal details are in.";
  const { data: cur } = await sb.from("leads").select("activity").eq("id", lead.id).single();
  const act: any[] = Array.isArray(cur && cur.activity) ? (cur!.activity as any[]) : [];
  const already = act.some((a) => a && a.type === "application" && String(a.text || "") === text);
  if (!already) {
    act.push({ date: today, at: new Date().toISOString(), type: "application", text, author: "System" });
    await sb.from("leads").update({ activity: act }).eq("id", lead.id);
    if (lead.assigned_to) {
      await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: lead.assigned_to, lead_id: lead.id, kind: "application",
        text: String(lead.name || "A borrower") + " submitted an application with no deal details (missing " + gaps.join(", ") + ") — call to get them.", date: today, read: false });
    }
  }
  if (lead.assigned_to) {
    await sb.from("followup_tasks").insert({
      lead_id: lead.id, assigned_to: lead.assigned_to, situation: "scheduled", step_key: "appgap:" + lead.id, step_n: 0, channel: "call",
      title: "Get the deal details from " + String(lead.name || "the borrower").split(" ")[0] + " — application has no " + gaps[0] + (gaps.length > 1 ? " (+" + (gaps.length - 1) + " more)" : ""),
      goal: "They submitted the application without: " + gaps.join(", ") + ". Ask what property they are looking at and get those numbers, then update the file.",
      lever: "They already did the paperwork; the one thing missing is the deal.", due_at: new Date(Date.now() + 45 * 60000).toISOString(), priority: 85, urgent: false, status: "open",
      meta: { manual: true, source: "application-gap", gaps },
    });   // unique step_key per lead: a repeat submission doesn't make a second task
  }
}

async function loadLead(leadId: string, token: string) {
  if (!leadId || !token) return null;
  const { data } = await sb.from("leads").select("*").eq("id", leadId).eq("application_token", token).maybeSingle();
  return data as Record<string, any> | null;
}
const safePath = (leadId: string, p: unknown) => typeof p === "string" && p.startsWith(leadId + "/") && !p.includes("..") && p.length < 300;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const leadId = String(body.leadId || ""), token = String(body.token || ""), action = String(body.action || "");
  const lead = await loadLead(leadId, token);
  if (!lead) return json({ ok: false, error: "invalid" }, 404);

  if (action === "get") {
    // Contact details for this file's own loan officer / processor only (the staff directory is not public).
    const ids = [lead.assigned_to, lead.assigned_processor].filter(Boolean);
    const { data: staffRows } = ids.length ? await sb.from("users").select("id,name,role,title,phone,email,nmls_number,photo_url,speaks_spanish").in("id", ids) : { data: [] };
    const staff = (staffRows || []).map((u: any) => ({ id: u.id, name: u.name, role: u.role, title: u.title, phone: u.phone, email: u.email,
      nmls: u.nmls_number, photoUrl: u.photo_url, speaksSpanish: !!u.speaks_spanish, fullAccess: false, portalPrefs: {} }));
    return json({ ok: true, lead: strip(lead), staff });
  }

  if (action === "upload-url") {
    if (!safePath(leadId, body.path)) return json({ ok: false, error: "bad_path" }, 400);
    const { data, error } = await sb.storage.from("lead-documents").createSignedUploadUrl(body.path);
    if (error || !data) return json({ ok: false, error: "upload_unavailable" }, 500);
    return json({ ok: true, path: data.path, token: data.token });
  }

  if (action === "signed-url") {
    if (!safePath(leadId, body.path)) return json({ ok: false, error: "bad_path" }, 400);
    const staffPaths = new Set<string>();
    for (const d of (Array.isArray(lead.documents) ? lead.documents : [])) {
      if (d && d.staffOnly) [d.storagePath, d.referenceFileUrl, d.fileUrl].forEach((p) => p && staffPaths.add(p));
    }
    if (staffPaths.has(body.path)) return json({ ok: false, error: "not_allowed" }, 403);
    const { data, error } = await sb.storage.from("lead-documents").createSignedUrl(body.path, 3600);
    if (error || !data) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, url: data.signedUrl });
  }

  if (action === "save") {
    const row = (body.row && typeof body.row === "object") ? body.row as Record<string, any> : {};
    const upd: Record<string, any> = {};
    for (const k of Object.keys(row)) if (WRITABLE.has(k)) upd[k] = row[k];

    // stage: the borrower can only move a file forward to "Application Completed" -- and only when the deal itself is in the application (Joe 10/16: María correa's
    // file was tagged Application Completed with no property, price, rehab or ARV). A submission with the deal missing stays "Application Sent", the loan officer
    // gets a task to collect the missing items, and the file says exactly what is missing.
    const cur = STAGE_ORDER.indexOf(String(lead.stage));
    let heldGaps: string[] = [];
    if (row.stage === "app_completed" && cur >= 0 && cur < STAGE_ORDER.indexOf("app_completed")) {
      heldGaps = dealGaps({ ...lead, ...upd });
      if (!heldGaps.length) upd.stage = "app_completed";
      else delete upd.application_taken_at;   // the engine treats "application taken" as done; it isn't until the deal is in
    }

    // activity + portal chat: append only (a stale copy can never erase staff entries); chat entries must be the borrower's own
    const appendOnly = (existing: unknown, incoming: unknown, onlyBorrower: boolean) => {
      const ex = Array.isArray(existing) ? existing : [];
      const seen = new Set(ex.map((x) => JSON.stringify(x)));
      const add = (Array.isArray(incoming) ? incoming : []).filter((x) => x && typeof x === "object" && !seen.has(JSON.stringify(x)) && (!onlyBorrower || x.from === "borrower")).slice(-50);
      return add.length ? ex.concat(add) : null;
    };
    // the page never receives the file's internal activity log, so everything it sends is new
    const act = appendOnly(lead.activity, row.activity, false);
    if (act) upd.activity = act;
    const chat = appendOnly(lead.portal_chat, row.portal_chat, true);
    if (chat) upd.portal_chat = chat;

    // documents: the borrower's list replaces ours, except staff-only documents, which never change here
    if (Array.isArray(row.documents) && row.documents.length <= 300) {
      const existing = Array.isArray(lead.documents) ? lead.documents : [];
      const staffOnly = existing.filter((d: any) => d && d.staffOnly);
      const names = new Set(staffOnly.map((d: any) => d.name));
      upd.documents = row.documents.filter((d: any) => d && typeof d === "object" && !d.staffOnly && !names.has(d.name)).concat(staffOnly);
    }

    if (Object.keys(upd).length) {
      const { error } = await sb.from("leads").update(upd).eq("id", leadId);
      if (error) return json({ ok: false, error: "save_failed", detail: error.message }, 500);
    }
    if (heldGaps.length) await holdIncompleteApplication(lead, heldGaps);

    // alerts for the file's loan officer / processor only
    const notes = (Array.isArray(body.notifications) ? body.notifications : []).slice(-10);
    const recipients = new Set([lead.assigned_to, lead.assigned_processor].filter(Boolean));
    const rows = notes.filter((n: any) => n && recipients.has(n.to_user_id) && (n.lead_id === leadId || n.lead_id == null))
      .map((n: any) => ({ id: String(n.id || ("N" + crypto.randomUUID().slice(0, 8))).slice(0, 40), to_user_id: n.to_user_id, lead_id: leadId,
        kind: String(n.kind || "portal").slice(0, 40), text: String(n.text || "").slice(0, 500), date: String(n.date || new Date().toISOString().slice(0, 10)).slice(0, 10), read: false }));
    if (rows.length) await sb.from("notifications").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    return json({ ok: true });
  }

  // ---- Property questionnaire (public page /questionnaire/?l=<lead id>&t=<token>) ----
  if (action === "q-get") {
    const q = (lead.property_questionnaire && typeof lead.property_questionnaire === "object") ? lead.property_questionnaire : {};
    const { data: lo } = lead.assigned_to ? await sb.from("users").select("name,phone").eq("id", lead.assigned_to).maybeSingle() : { data: null as any };
    return json({ ok: true, firstName: String(lead.name || "").split(" ")[0], language: lead.preferred_language || "en", propertyAddress: lead.property_address || "",
      totalUnits: lead.num_units ?? null, answers: q.answers || {}, submittedAt: q.submittedAt || null, lo: lo ? { name: lo.name, phone: lo.phone } : null });
  }
  if (action === "q-save") {
    const inA = (body.answers && typeof body.answers === "object") ? body.answers as Record<string, unknown> : {};
    const clean: Record<string, string> = {};
    for (const k of Q_KEYS) { const v = inA[k]; if (v != null && String(v).trim() !== "") clean[k] = String(v).trim().slice(0, k === "areaDescription" || k === "repairsDescribe" ? 400 : 160); }
    const prev = (lead.property_questionnaire && typeof lead.property_questionnaire === "object") ? lead.property_questionnaire : {};
    const submit = body.submit === true;
    const next: Record<string, unknown> = { answers: { ...(prev.answers || {}), ...clean }, updatedAt: new Date().toISOString(), language: String(body.language || "").slice(0, 5) || null, submittedAt: prev.submittedAt || null };
    if (submit) next.submittedAt = new Date().toISOString();
    const upd: Record<string, unknown> = { property_questionnaire: next };
    if (submit && !prev.submittedAt) {
      const today = new Date().toISOString().slice(0, 10);
      upd.activity = (Array.isArray(lead.activity) ? lead.activity : []).concat([{ date: today, at: new Date().toISOString(), type: "note", author: lead.name, text: "Completed the Property Questionnaire online (" + Object.keys(next.answers as object).length + " answers)." }]);
    }
    const { error } = await sb.from("leads").update(upd).eq("id", leadId);
    if (error) return json({ ok: false, error: "save_failed", detail: error.message }, 500);
    if (submit && !prev.submittedAt) {
      // Tell Joe and the file's loan officer (staff only).
      const who = [...new Set(["owner", lead.assigned_to].filter(Boolean))] as string[];
      await sb.from("notifications").insert(who.map((u) => ({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: u, lead_id: leadId, kind: "questionnaire", text: "✅ " + lead.name + " finished the property questionnaire.", date: new Date().toISOString().slice(0, 10), read: false })));
      const { data: staff } = await sb.from("users").select("id,phone").in("id", who);
      for (const s of staff || []) if (s.phone) await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_KEY }, body: JSON.stringify({ to: s.phone, text: "✅ " + lead.name + " finished the property questionnaire. " + "https://app.bplending.com/?lead=" + leadId, fromName: "Bridgepoint CRM" }) }).catch(() => null);
    }
    return json({ ok: true, submitted: !!next.submittedAt });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
