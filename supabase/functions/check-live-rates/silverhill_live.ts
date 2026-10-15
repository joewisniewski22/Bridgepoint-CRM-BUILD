// Silver Hill Capital -- live rate (Phase 2). Joe 2026-10-14 authorized this in chat ("Yes, write and run code that signs in to Silver Hill with the
// saved login" and "... search the Silver Hill portal page code for the security token so the server can price deals"; settings.json autoMode note added).
//
// How the broker portal (Salesforce Experience Cloud, Aura) works, all verified 10/14/26:
//  1. Sign in: GET /Portal/s/login/ (scrape fwuid, loaded + apck of app siteforce:loginApp2), then POST the Aura action
//     apex://applauncher.LoginFormController/ACTION$login {username, password, startUrl:""}. Success = SUCCESS with a null return value and a
//     markup://aura:clientRedirect event holding a frontdoor.jsp URL; following it (with a cookie jar) creates the session.
//     The username is the email + ".shc"; the account locks after 3 FAILED logins, so this code makes at most one attempt per call and refuses
//     to retry after the portal says the credentials are wrong.
//  2. Every later Aura call needs aura.token = the value of the __Host-ERIC_* cookie (334 chars, 3 parts) -- verified with a read-only call.
//  3. Pricing is a Salesforce Flow: startFlow (flowDevName Quick_Calculator_Flow = 1-4 DSCR, SBC_Quick_Calculator_Flow = small-balance
//     commercial) then ONE navigateFlow NEXT with the form fields. That creates a Deal Scenario record in Joe's account (stage In Progress, not
//     submitted); its Final Interest Rate is read from the Deal Scenario list view. Because each run leaves a record, results are cached 24h and
//     the caller only runs this for fallback scenarios.
type S = any;
const SITE = "https://shf.my.site.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const LIST_VIEW_ID = "00BPr0000041tzRMAQ"; // "Deal Scenarios Created/Modified 30 Days"

type Sess = { jar: Record<string, string>; token: string; ctx: any; exp: number };
let memo: Sess | null = null;
let lockedOut = false; // set when the portal rejects the saved credentials: stop trying until a new deploy / secret change

function takeCookies(jar: Record<string, string>, res: Response) {
  const list: string[] = (res.headers as any).getSetCookie ? (res.headers as any).getSetCookie() : [];
  for (const c of list) { const kv = c.split(";")[0]; const i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1); }
}
const cookieHeader = (jar: Record<string, string>) => Object.keys(jar).map((k) => k + "=" + jar[k]).join("; ");
function safeDecode(s: string): string { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (_) { return s.replace(/%22/g, '"').replace(/%3A/g, ":").replace(/%2F/g, "/").replace(/%40/g, "@").replace(/%7B/g, "{").replace(/%7D/g, "}").replace(/%2C/g, ","); } }
async function getFollow(jar: Record<string, string>, url: string, hops = 10): Promise<{ text: string; url: string }> {
  let u = url;
  for (let i = 0; i < hops; i++) {
    const res = await fetch(u, { redirect: "manual", headers: { cookie: cookieHeader(jar), "user-agent": UA } });
    takeCookies(jar, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u).toString(); continue; }
    return { text: await res.text(), url: u };
  }
  throw new Error("silverhill_redirects");
}
async function auraPost(jar: Record<string, string>, ctx: any, pageUri: string, token: string, qs: string, actions: unknown[]): Promise<any> {
  const body = "message=" + encodeURIComponent(JSON.stringify({ actions })) + "&aura.context=" + encodeURIComponent(JSON.stringify(ctx)) + "&aura.pageURI=" + encodeURIComponent(pageUri) + "&aura.token=" + encodeURIComponent(token);
  const r = await fetch(SITE + "/Portal/s/sfsites/aura?r=1&" + qs, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", cookie: cookieHeader(jar), "user-agent": UA }, body });
  takeCookies(jar, r);
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t.replace(/^\*\//, "").replace(/\/\*ERROR\*\/$/, "")); } catch (_) { /* not json */ }
  if (!j) throw new Error("silverhill_http_" + r.status);
  if (j.exceptionEvent || (j.event && /invalidSession/.test(JSON.stringify(j.event)))) throw new Error("silverhill_session");
  return j;
}

async function login(): Promise<Sess> {
  if (lockedOut) throw new Error("silverhill_credentials_rejected");
  const user = (Deno.env.get("SILVERHILL_USERNAME") || "").trim(), pass = Deno.env.get("SILVERHILL_PASSWORD") || "";
  if (!user || !pass) throw new Error("not_configured");
  if (!/\.shc$/i.test(user)) throw new Error("silverhill_username_needs_shc");
  const jar: Record<string, string> = {};
  const page = await getFollow(jar, SITE + "/Portal/s/login/");
  const dec = safeDecode(page.text.slice(0, 400000));
  const fwuid = (/"fwuid":"([^"]+)"/.exec(dec) || [])[1] || "";
  const la = /"APPLICATION@markup:\/\/siteforce:loginApp2":"([^"]+)"/.exec(dec);
  const apck = (/"apck":"([^"]+)"/.exec(dec) || [])[1] || "";
  if (!fwuid || !la) throw new Error("silverhill_login_page_changed");
  const lctx: any = { mode: "PROD", fwuid, app: "siteforce:loginApp2", loaded: { "APPLICATION@markup://siteforce:loginApp2": la[1] }, dn: [], globals: {}, uad: false };
  if (apck) { lctx.apce = 1; lctx.apck = apck; }
  const lr = await auraPost(jar, lctx, "/Portal/s/login/", "null", "applauncher.LoginForm.login=1", [{ id: "134;a", descriptor: "apex://applauncher.LoginFormController/ACTION$login", callingDescriptor: "markup://salesforceIdentity:loginForm2", params: { username: user, password: pass, startUrl: "" }, version: "68.0" }]);
  const a = lr.actions && lr.actions[0];
  if (a && typeof a.returnValue === "string" && a.returnValue) { lockedOut = /login attempt|username|password|locked/i.test(a.returnValue); throw new Error(lockedOut ? "silverhill_credentials_rejected" : "silverhill_login_failed"); }
  let redirect = "";
  for (const e of (lr.events || [])) { const v = e && e.attributes && e.attributes.values; const c = v && (v.url || v.uri); if (typeof c === "string" && c) { redirect = c; break; } }
  if (!redirect) throw new Error("silverhill_no_redirect");
  await getFollow(jar, new URL(redirect, SITE).toString());
  const home = await getFollow(jar, SITE + "/Portal/s/");
  const bm = /(\/Portal\/s\/sfsites\/l\/[^"' ]*)bootstrap\.js\?[^"' ]*/.exec(home.text) || /(\/Portal\/s\/sfsites\/l\/[^"' ]*)bootstrap\.js\?[^"' ]*/.exec(safeDecode(home.text));
  const eric = Object.keys(jar).find((k) => k.startsWith("__Host-ERIC_"));
  if (!bm || !eric) throw new Error("silverhill_session_missing");
  const bd = safeDecode(bm[0].replace(/&amp;/g, "&"));
  const cfw = (/"fwuid":"([^"]+)"/.exec(bd) || [])[1] || fwuid;
  const cl = /"APPLICATION@markup:\/\/siteforce:communityApp":"([^"]+)"/.exec(bd);
  if (!cl) throw new Error("silverhill_app_context_missing");
  const ctx = { mode: "PROD", fwuid: cfw, app: "siteforce:communityApp", loaded: { "APPLICATION@markup://siteforce:communityApp": cl[1] }, dn: [], globals: {}, uad: false };
  return { jar, token: jar[eric], ctx, exp: Date.now() + 25 * 60000 };
}
async function session(fresh = false): Promise<Sess> {
  if (!fresh && memo && memo.exp > Date.now()) return memo;
  memo = await login();
  return memo;
}
async function call(qs: string, actions: unknown[], retry = true): Promise<any> {
  const s = await session();
  try { return await auraPost(s.jar, s.ctx, "/Portal/s/", s.token, qs, actions); }
  catch (e) { if (retry && String((e as Error).message) === "silverhill_session") { memo = null; await session(true); return call(qs, actions, false); } throw e; }
}

// Salesforce flow field keys: option text with every run of non-alphanumerics collapsed to "_", trimmed, and an "X" prefix when it starts with a digit.
const key = (t: string) => { const k = String(t).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); return /^[0-9]/.test(k) ? "X" + k : k; };
const sel = (field: string, optionText: string) => ({ field: field + "." + key(optionText) + ".selected", value: true, isVisible: true });
const val = (field: string, v: unknown) => ({ field, value: v, isVisible: true });

const DSCR_PROP: Record<string, string> = { "SFR": "Single Family", "Single Family": "Single Family", "Duplex": "2 To 4 Family", "2-4 Unit": "2 To 4 Family", "Condo": "Residential Condo", "Townhome": "Town House/Row House", "PUD": "PUD" };
const SBC_PROP: Record<string, string> = { "Multifamily 5+": "Multi-Family", "Mixed-Use": "Mixed-Use Tier 1 (Primarily Res)", "Mixed-Use (Commercial Heavy)": "Mixed-Use Tier 2 (Primarily Comm)", "Office": "Office", "Retail": "Retail/Wholesale Store/Strip Center", "Warehouse": "Warehouse", "Self-Storage": "Self-Storage Facility", "Automotive": "Automotive", "Mobile Home Park": "Mobile Home Park", "Commercial Condo": "Commercial Condo", "Day Care": "Day Care" };
const DSCR_PREPAY: Record<string, string> = { "none": "No Prepay", "1yr": "Reduced: 5% for 1 Yr", "2yr": "Reduced: 5% for 2 Yrs", "3yr": "Standard: 5% for 3 yrs", "5yr": "Declining: 5%,4%,3%,2%,1%" };
const SBC_PREPAY: Record<string, string> = { "3yr": "Standard: 5% for 3 yrs", "5yr": "Declining: 5%,4%,3%,2%,1%" };

function zipOf(addr: string): string { return (/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(String(addr || "")) || [])[1] || ""; }
function pmt(amount: number, annualRatePct: number, years = 30): number { const r = annualRatePct / 1200, n = years * 12; return r === 0 ? amount / n : amount * r / (1 - Math.pow(1 + r, -n)); }

export type ShQuote = { ok: boolean; rate?: number; rateStatus?: string; errors?: string; program?: string; reason?: string; dealName?: string; cached?: boolean; raw?: unknown };

// Build the form fields for a scenario; returns null + reason when something the form needs is missing.
function buildFields(s: S): { flow: string; fields: any[]; program: string; amountForMatch: number; propLabel: string } | { reason: string } {
  const pt = String(s.propertyType || "");
  const dscr = !!DSCR_PROP[pt];
  const refi = s.transactionType && s.transactionType !== "purchase";
  const value = refi ? (s.currentValue || s.purchasePrice) : (s.purchasePrice && s.currentValue ? Math.min(s.purchasePrice, s.currentValue) : (s.purchasePrice || s.currentValue));
  const amt = Number(s.loanAmount) || 0;
  const zip = zipOf(s.propertyAddress), st = String(s.propertyState || "").toUpperCase();
  if (!value) return { reason: "Needs the property value." };
  if (!amt) return { reason: "Needs a loan amount." };
  if (!zip) return { reason: "Needs the property zip code." };
  if (!s.creditScore) return { reason: "Needs a credit score." };
  const purpose = !refi ? "Purchase" : s.transactionType === "cashout" ? "Cash Out" : "Refinance";
  if (dscr) {
    const rent = Number(s.rentEstimate) || 0;
    if (!rent) return { reason: "Needs the monthly rent to work out the DSCR." };
    const carry = (Number(s.monthlyTaxes) || 0) + (Number(s.monthlyInsurance) || 0) + (Number(s.monthlyHoa) || 0);
    const d = Math.round(rent / (pmt(amt, 8.0) + carry) * 1000) / 1000; // DSCR at an assumed ~8% rate: Silver Hill sets the rate from it, so this is an estimate
    const fields = [sel("Loan_Purpose_Input", purpose), sel("Property_Type_input", DSCR_PROP[pt]), val("Deal_FICO", Number(s.creditScore)), sel("Prepayment_Penalty", DSCR_PREPAY[String(s.prepayTerm || "3yr")] || "Standard: 5% for 3 yrs"), val("Zip_Code", zip), val("Estimated_Property_Value", Math.round(value)), val("Loan_Amount", Math.round(amt)), val("Estimated_DSCR", d), val("_0", st), sel("Response_Priority", "No")];
    return { flow: "Quick_Calculator_Flow", fields, program: "1-4 DSCR", amountForMatch: Math.round(amt), propLabel: DSCR_PROP[pt] };
  }
  if (SBC_PROP[pt]) {
    const fields = [sel("Property_Type", SBC_PROP[pt]), val("Deal_FICO", Number(s.creditScore)), sel("Prepayment_Penalty", SBC_PREPAY[String(s.prepayTerm || "3yr")] || "Standard: 5% for 3 yrs"), val("Zip_Code", zip), sel("Doc_Type", "Complete"), sel("Loan_Purpose", purpose), val("Estimated_Property_Value", Math.round(value)), val("Loan_Amount", Math.round(amt)), sel("Loan_Program", "30 Yr Fixed"), sel("Amortization_years", "30"), sel("Occupancy", "Investor"), sel("Response_Priority", "No")];
    return { flow: "SBC_Quick_Calculator_Flow", fields, program: "Small balance commercial", amountForMatch: Math.round(amt), propLabel: SBC_PROP[pt] };
  }
  return { reason: "Silver Hill has no form for " + pt + "." };
}

// The Deal Scenario list gives record ids (its rows come back as metadata only); a record's fields are read with getRecordWithFields.
async function listIds(): Promise<string[]> {
  const j = await call("ui-force-components-controllers-lists-listViewDataManager.ListViewDataManager.getItems=1", [{ id: "405;a", descriptor: "serviceComponent://ui.force.components.controllers.lists.listViewDataManager.ListViewDataManagerController/ACTION$getItems", callingDescriptor: "UNKNOWN", params: { filterName: LIST_VIEW_ID, entityName: "Deal_Scenario__c", pageSize: 50, layoutType: "LIST", sortBy: null, getCount: false, enableRowActions: false, offset: 0 }, storable: false }]);
  const rv = j.actions && j.actions[0] && j.actions[0].returnValue;
  return ((rv && rv.recordIdActionsList) || []).map((x: any) => x.recordId).filter(Boolean);
}
async function readRecord(id: string): Promise<any> {
  const fields = ["Name", "Final_Interest_Rate__c", "Rate_Status__c", "Errors__c", "Proposed_Loan_Amount__c", "CreatedDate", "Property_Type__c"].map((f) => "Deal_Scenario__c." + f);
  const r = await call("aura.RecordUi.getRecordWithFields=1", [{ id: "9;a", descriptor: "aura://RecordUiController/ACTION$getRecordWithFields", callingDescriptor: "UNKNOWN", params: { recordId: id, fields } }]);
  const rv = r.actions && r.actions[0] && r.actions[0].returnValue;
  const f = (n: string) => { const v = rv && rv.fields && rv.fields[n]; return v ? v.value : null; };
  return { id, name: f("Name"), rate: f("Final_Interest_Rate__c"), rateStatus: f("Rate_Status__c"), errors: f("Errors__c"), loan: f("Proposed_Loan_Amount__c"), created: f("CreatedDate"), propType: f("Property_Type__c") };
}
export async function silverHillQuote(s: S, debug = false): Promise<ShQuote> {
  const built = buildFields(s);
  if ("reason" in built) return { ok: false, reason: built.reason };
  const t0 = Date.now();
  try {
    const before = new Set(await listIds());
    const st = await call("aura.FlowRuntimeConnect.startFlow=1", [{ id: "198;a", descriptor: "aura://FlowRuntimeConnectController/ACTION$startFlow", callingDescriptor: "UNKNOWN", params: { flowDevName: built.flow, arguments: "[]", enableTrace: false, enableRollbackMode: false, debugAsUserId: "", useLatestSubflow: false, isBuilderDebug: false } }]);
    const sa = st.actions && st.actions[0];
    const state = sa && sa.returnValue && sa.returnValue.response && sa.returnValue.response.serializedEncodedState;
    if (!state) return { ok: false, reason: "Silver Hill's pricing form didn't start.", raw: debug ? mask(JSON.stringify(st).slice(0, 400)) : undefined };
    const nav = await call("aura.FlowRuntimeConnect.navigateFlow=1", [{ id: "224;a", descriptor: "aura://FlowRuntimeConnectController/ACTION$navigateFlow", callingDescriptor: "UNKNOWN", params: { request: { action: "NEXT", serializedState: state, fields: built.fields, uiElementVisited: true, enableTrace: false, lcErrors: {}, isBuilderDebug: false } } }]);
    const na = nav.actions && nav.actions[0];
    const resp = na && na.returnValue && na.returnValue.response;
    if (!resp || (na.returnValue && na.returnValue.error)) return { ok: false, reason: "Silver Hill's pricing form rejected the scenario.", raw: debug ? mask(JSON.stringify(na && na.returnValue && na.returnValue.error)) : undefined };
    // The rate is computed right after the record is created; poll the list a few times.
    let deal: any = null;
    let newId = "";
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 1500 : 2000));
      if (!newId) { const now = await listIds(); newId = now.find((x) => !before.has(x)) || ""; }
      if (newId) { deal = await readRecord(newId); if (deal && deal.rate != null && deal.rate !== "") break; }
    }
    if (!deal || deal.rate == null || deal.rate === "") return { ok: false, reason: "Silver Hill didn't return a rate for this scenario (it may be outside their guidelines).", dealName: deal && deal.name, rateStatus: deal && deal.rateStatus, errors: deal && deal.errors, raw: debug ? deal : undefined, program: built.program };
    const rate = Number(deal.rate);
    return { ok: isFinite(rate) && rate > 0, rate: isFinite(rate) ? rate : undefined, rateStatus: deal.rateStatus, errors: deal.errors, dealName: deal.name, program: built.program, raw: debug ? deal : undefined };
  } catch (e) {
    return { ok: false, reason: "Silver Hill couldn't be reached: " + String((e as Error).message || e).slice(0, 120) };
  }
}
const mask = (s: string) => String(s || "").replace(/[A-Za-z0-9_\-\.\/\+%=]{40,}/g, "<long>").slice(0, 400);

// Read-only: shape of the Deal Scenario list response (no pricing, creates nothing). Used to wire readDeal().
export async function silverHillListShape(): Promise<unknown> {
  const j = await call("ui-force-components-controllers-lists-listViewDataManager.ListViewDataManager.getItems=1", [{ id: "405;a", descriptor: "serviceComponent://ui.force.components.controllers.lists.listViewDataManager.ListViewDataManagerController/ACTION$getItems", callingDescriptor: "UNKNOWN", params: { filterName: LIST_VIEW_ID, entityName: "Deal_Scenario__c", pageSize: 50, layoutType: "LIST", sortBy: null, getCount: false, enableRowActions: false, offset: 0 }, storable: false }]);
  const a = j.actions && j.actions[0];
  const rv = a && a.returnValue;
  const shape: Record<string, string> = {};
  if (rv && typeof rv === "object") for (const k of Object.keys(rv)) { const v = rv[k]; shape[k] = Array.isArray(v) ? "array[" + v.length + "]" : typeof v === "object" && v ? "object{" + Object.keys(v).slice(0, 12).join(",") + "}" : typeof v; }
  const arr = rv && Object.keys(rv).find((k) => Array.isArray(rv[k]) && rv[k].length && typeof rv[k][0] === "object" && /record|result|item|row/i.test(k));
  const first = arr ? rv[arr][0] : null;
  return { state: a && a.state, shape, state2: j.actions ? j.actions.length : 0, fields: rv && Array.isArray(rv.fields) ? rv.fields.slice(0, 40) : null, firstKey: arr || null, firstRecord: first ? JSON.stringify(first).slice(0, 1500) : null };
}

// Read-only: try fetching one deal record by id (shape probe for readDeal()).
export async function silverHillRecordProbe(): Promise<unknown> {
  const j = await call("ui-force-components-controllers-lists-listViewDataManager.ListViewDataManager.getItems=1", [{ id: "405;a", descriptor: "serviceComponent://ui.force.components.controllers.lists.listViewDataManager.ListViewDataManagerController/ACTION$getItems", callingDescriptor: "UNKNOWN", params: { filterName: LIST_VIEW_ID, entityName: "Deal_Scenario__c", pageSize: 50, layoutType: "LIST", sortBy: null, getCount: false, enableRowActions: false, offset: 0 }, storable: false }]);
  const rv = j.actions && j.actions[0] && j.actions[0].returnValue;
  const ids: string[] = ((rv && rv.recordIdActionsList) || []).map((x: any) => x.recordId);
  const out: any = { ids: ids.length, tries: [] };
  const fields = ["Deal_Scenario__c.Name", "Deal_Scenario__c.Final_Interest_Rate__c", "Deal_Scenario__c.Rate_Status__c", "Deal_Scenario__c.Errors__c", "Deal_Scenario__c.Proposed_Loan_Amount__c", "Deal_Scenario__c.CreatedDate", "Deal_Scenario__c.Property_Type__c"];
  const descriptors = ["aura://RecordUiController/ACTION$getRecordWithFields", "serviceComponent://ui.force.components.controllers.recordGlobalValueProvider.RecordGvpController/ACTION$getRecord"];
  for (const d of descriptors) {
    try {
      const params = d.includes("RecordUiController") ? { recordId: ids[0], fields } : { recordDescriptor: ids[0] + ".undefined.null.null.VIEW.true.null.null.null.null.null.null" };
      const r = await call(d.includes("RecordUiController") ? "aura.RecordUi.getRecordWithFields=1" : "ui-force-components-controllers-recordGlobalValueProvider.RecordGvp.getRecord=1", [{ id: "9;a", descriptor: d, callingDescriptor: "UNKNOWN", params }]);
      const a = r.actions && r.actions[0];
      out.tries.push({ d: d.split("/").pop(), state: a && a.state, err: a && a.error ? JSON.stringify(a.error).slice(0, 200) : null, rv: a && a.returnValue ? JSON.stringify(a.returnValue).slice(0, 700) : null });
    } catch (e) { out.tries.push({ d: d.split("/").pop(), exception: String((e as Error).message).slice(0, 100) }); }
  }
  return out;
}

// ---- 24h cache + hourly cap (each fresh price leaves a Deal Scenario record in Joe's Silver Hill account) ----
const SB_URL = () => Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const sbHeaders = () => ({ apikey: SB_KEY(), Authorization: "Bearer " + SB_KEY(), "Content-Type": "application/json" });
async function sha(t: string): Promise<string> { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join(""); }
const MAX_FRESH_PER_HOUR = 8;

export async function silverHillQuoteCached(s: S): Promise<ShQuote> {
  const built = buildFields(s);
  if ("reason" in built) return { ok: false, reason: built.reason };
  if (!Deno.env.get("SILVERHILL_USERNAME") || !Deno.env.get("SILVERHILL_PASSWORD")) return { ok: false, reason: "Silver Hill live pricing isn't connected (sign-in secrets missing)." };
  const key = await sha(built.flow + "|" + JSON.stringify(built.fields));
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await fetch(SB_URL() + "/rest/v1/silverhill_quote_cache?select=result&key=eq." + key + "&created_at=gte." + encodeURIComponent(since), { headers: sbHeaders() });
    const rows: any[] = r.ok ? await r.json() : [];
    if (rows.length && rows[0].result) return { ...(rows[0].result as ShQuote), cached: true };
    const hour = new Date(Date.now() - 3600 * 1000).toISOString();
    const c = await fetch(SB_URL() + "/rest/v1/silverhill_quote_cache?select=key&created_at=gte." + encodeURIComponent(hour), { headers: sbHeaders() });
    const recent: any[] = c.ok ? await c.json() : [];
    if (recent.length >= MAX_FRESH_PER_HOUR) return { ok: false, reason: "Silver Hill live pricing is paused for the hour (too many fresh prices); price it in their portal." };
  } catch (_) { /* cache unreachable: fall through and price live */ }
  const q = await silverHillQuote(s);
  if (q.ok) {
    try { await fetch(SB_URL() + "/rest/v1/silverhill_quote_cache", { method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key, result: q, created_at: new Date().toISOString() }) }); } catch (_) { /* best effort */ }
  }
  return q;
}
