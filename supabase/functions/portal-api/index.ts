// Server side of the borrower application / portal page (opened with ?apply=<lead id>&t=<token>).
// Until 10/12/2026 that page talked to the database directly with the public key and could read
// or edit every lead. Now it only talks to this function, which checks the file's application
// token on every call and only ever touches that one lead.
//
// Actions: get (also used for polling), save (whitelisted fields only), upload-url, signed-url.
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

// Never sent to the browser.
const HIDE = ["guarantor_ssn_encrypted", "co_ssn_encrypted", "ai_quote", "call_attempts"];

// The only columns a borrower's page may change.
const WRITABLE = new Set([
  "name", "email", "phone", "entity_type", "credit_score", "experience_deals", "liquidity", "property_address", "property_type",
  "exit_strategy", "purchase_price", "current_value", "current_loan_balance", "arv", "rehab_budget", "rent_estimate",
  "monthly_taxes", "monthly_insurance", "monthly_hoa", "loan_amount", "ltv", "term_months", "property_count", "birthday",
  "entity_legal_name", "guarantor_first_name", "guarantor_middle_name", "guarantor_last_name", "guarantor_phone", "guarantor_email",
  "guarantor_address", "guarantor_ownership_pct", "track_record", "co_first_name", "co_middle_name", "co_last_name", "co_birthday",
  "co_ownership_pct", "co_phone", "co_email", "co_address", "co_citizenship_status", "co_country_of_domicile", "co_credit_score",
  "co_experience_deals", "co_liquidity", "co_marital_status", "citizenship_status", "country_of_domicile", "marital_status",
  "transaction_type", "prepay_term", "built_year", "current_lender_name", "units_ready_for_rent", "property_occupied", "taxes_current",
  "property_lease_status", "delayed_purchase", "ny_cema_loan", "ny_closing_attorney", "num_units", "num_residential_units",
  "num_commercial_units", "lease_detail", "ach_form", "rtl_app", "dscr_app", "scope_of_work", "guideline_check",
  "application_sent_at", "application_taken_at", "preferred_language",
]);
const STAGE_ORDER = ["new", "attempting", "qualifying", "app_sent", "app_completed", "docs", "processing", "underwriting", "approved", "ctc", "closed", "postclosing"];
const strip = (row: Record<string, unknown>) => { const r = { ...row }; HIDE.forEach((k) => delete r[k]); return r; };

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

  if (action === "get") return json({ ok: true, lead: strip(lead) });

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

    // stage: the borrower can only move a file forward to "Application Completed"
    const cur = STAGE_ORDER.indexOf(String(lead.stage));
    if (row.stage === "app_completed" && cur >= 0 && cur < STAGE_ORDER.indexOf("app_completed")) upd.stage = "app_completed";

    // activity + portal chat: append only (a stale copy can never erase staff entries); chat entries must be the borrower's own
    const appendOnly = (existing: unknown, incoming: unknown, onlyBorrower: boolean) => {
      const ex = Array.isArray(existing) ? existing : [];
      const seen = new Set(ex.map((x) => JSON.stringify(x)));
      const add = (Array.isArray(incoming) ? incoming : []).filter((x) => x && typeof x === "object" && !seen.has(JSON.stringify(x)) && (!onlyBorrower || x.from === "borrower")).slice(-50);
      return add.length ? ex.concat(add) : null;
    };
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

    // alerts for the file's loan officer / processor only
    const notes = (Array.isArray(body.notifications) ? body.notifications : []).slice(-10);
    const recipients = new Set([lead.assigned_to, lead.assigned_processor].filter(Boolean));
    const rows = notes.filter((n: any) => n && recipients.has(n.to_user_id) && (n.lead_id === leadId || n.lead_id == null))
      .map((n: any) => ({ id: String(n.id || ("N" + crypto.randomUUID().slice(0, 8))).slice(0, 40), to_user_id: n.to_user_id, lead_id: leadId,
        kind: String(n.kind || "portal").slice(0, 40), text: String(n.text || "").slice(0, 500), date: String(n.date || new Date().toISOString().slice(0, 10)).slice(0, 10), read: false }));
    if (rows.length) await sb.from("notifications").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
