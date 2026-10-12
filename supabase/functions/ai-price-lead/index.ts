// Prices a lead privately once the text-message AI has gathered the full deal (Joe 2026-10-12).
// Nothing here ever reaches the borrower: it runs the live pricer, saves the result on the lead as `ai_quote`
// (a drafted, lender-free text the loan officer can edit and send with one tap), and alerts the loan officer.
// Called by ai-lead-engage with the service key. Replies 202 right away and works in the background.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_URL = "https://bridgepoint-crm-build.vercel.app/";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

// What the pricer needs per loan type (lead columns).
const NEED: Record<string, string[]> = {
  "Fix & Flip": ["property_address", "purchase_price", "arv", "rehab_budget", "credit_score", "experience_deals"],
  "Bridge": ["property_address", "purchase_price", "credit_score", "experience_deals"],
  "Ground Up Construction": ["property_address", "purchase_price", "arv", "rehab_budget", "credit_score", "experience_deals"],
  "DSCR": ["property_address", "purchase_price", "rent_estimate", "credit_score"],
  "Mixed-Use": ["property_address", "purchase_price", "rent_estimate", "credit_score"],
};
const RTL = ["Fix & Flip", "Bridge", "Ground Up Construction"];

function stateOf(addr: string): string {
  const m = (addr || "").match(/\b([A-Z]{2})\b(?:\s+\d{5})?(?:-\d{4})?\s*(?:,\s*USA)?\s*$/) || (addr || "").match(/,\s*([A-Z]{2})\b/);
  return m ? m[1] : "";
}
function propType(t: string | null): string {
  const s = String(t || "").toLowerCase();
  if (/mixed/.test(s)) return "Mixed-Use";
  if (/condo/.test(s)) return "Condo";
  if (/multi.*5|5\+|apartment/.test(s)) return "Multifamily 5+";
  if (/2-4|duplex|triplex|four|quad/.test(s)) return "2-4 Unit";
  return "SFR";
}
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const short = (n: number) => n >= 1e6 ? "$" + (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : n >= 1000 ? "$" + Math.round(n / 1000) + "k" : "$" + Math.round(n);

function buildScenario(lead: Record<string, any>) {
  const lt = String(lead.loan_type);
  const rtl = RTL.includes(lt), mixed = lt === "Mixed-Use";
  const addr = String(lead.property_address || "");
  const value = Number(lead.current_value || lead.purchase_price || 0);
  const num = (x: unknown) => (x == null || x === "" ? null : Number(x));
  return {
    loanType: mixed ? "DSCR" : lt, transactionType: lead.transaction_type || "purchase", propertyAddress: addr, propertyState: stateOf(addr),
    propertyType: mixed ? "Mixed-Use" : propType(lead.property_type), numUnits: lead.num_units || null,
    creditScore: num(lead.credit_score), purchasePrice: num(lead.purchase_price), currentValue: num(lead.current_value), currentLoanBalance: num(lead.current_loan_balance),
    loanAmount: num(lead.loan_amount),
    rehabBudget: rtl ? num(lead.rehab_budget) : null, arv: rtl ? num(lead.arv) : null,
    rentEstimate: rtl ? null : num(lead.rent_estimate),
    // borrowers rarely know these; a standard estimate keeps the DSCR honest and is flagged for the loan officer
    monthlyTaxes: rtl ? null : (num(lead.monthly_taxes) ?? Math.round(value * 0.012 / 12)),
    monthlyInsurance: rtl ? null : (num(lead.monthly_insurance) ?? Math.round(value * 0.005 / 12)),
    monthlyHoa: rtl ? null : (num(lead.monthly_hoa) ?? 0),
    experienceDeals: num(lead.experience_deals) ?? 0, citizenshipStatus: lead.citizenship_status || "US Citizen", entityType: lead.entity_type || "LLC",
    rentalType: rtl ? null : "ltr", termMonths: rtl ? 12 : 360, prepayTerm: rtl ? "none" : "5yr", pointsCharged: 0,
    guarantorFirstName: "Scenario", guarantorLastName: "Check", decliningMarket: "no", vacationArea: "no", creditEvent: "no", appraisalTransfer: "no", plansReady: "no",
  };
}

async function priceLead(leadId: string, force: boolean) {
  const { data: lead } = await sb.from("leads").select("*").eq("id", leadId).single();
  if (!lead) return;
  const need = NEED[String(lead.loan_type)] || [];
  if (!need.length || !need.every((k) => lead[k] != null && lead[k] !== "")) return;
  const scenario = buildScenario(lead);
  const hash = JSON.stringify([scenario.loanType, scenario.propertyType, scenario.propertyAddress, scenario.transactionType, scenario.creditScore, scenario.purchasePrice, scenario.currentValue,
    scenario.loanAmount, scenario.rehabBudget, scenario.arv, scenario.rentEstimate, scenario.monthlyTaxes, scenario.monthlyInsurance, scenario.experienceDeals, scenario.citizenshipStatus]);
  const prior = lead.ai_quote as Record<string, any> | null;
  if (!force && prior && prior.hash === hash && ["ready", "sent", "no_match"].includes(prior.status)) return;

  const res = await fetch(SUPABASE_URL + "/functions/v1/check-live-rates", {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY }, body: JSON.stringify({ lead: scenario }),
  }).then((r) => r.json()).catch(() => null);
  if (!res || !res.ok) return;

  const rtl = RTL.includes(String(lead.loan_type));
  const results: any[] = res.results || [];
  // Best quotable option per lender, lowest rate. DSCR: only options priced at 100.00+ (no discount points) and not the lender-paid plan.
  const picks: any[] = [];
  for (const r of results) {
    if (!r || !r.eligible || !(r.options || []).length) continue;
    const opts = (r.options as any[]).filter((o) => rtl || ((o.price >= 99.9995) && o.revenuePts == null));
    if (!opts.length) continue;
    const best = opts.reduce((a, b) => (b.rate < a.rate ? b : a));
    picks.push({ lender: r.lender, program: best.program, rate: best.rate, price: best.price, loanAmount: best.loanAmount || r.loanAmountUsed || r.maxLoanAmount || null, estimate: r.source === "model", warning: r.staleWarning || null });
  }
  picks.sort((a, b) => a.rate - b.rate);
  const top = picks.slice(0, 2);

  const first = String(lead.name || "there").split(" ")[0];
  const { data: lo } = await sb.from("users").select("id,name,phone").eq("id", lead.assigned_to).single();
  const loName = (lo && lo.name) || "your loan officer";
  const bits: string[] = [];
  if (scenario.purchasePrice) bits.push(short(scenario.purchasePrice) + " purchase");
  if (rtl && scenario.rehabBudget) bits.push(short(scenario.rehabBudget) + " rehab");
  if (rtl && scenario.arv) bits.push(short(scenario.arv) + " after-repair value");
  if (!rtl && scenario.rentEstimate) bits.push(money(scenario.rentEstimate) + "/mo rent");
  const termTxt = rtl ? "12-month interest-only" : "30-year fixed";
  const letters = ["A", "B"];
  let draft = "";
  if (top.length) {
    draft = "Hi " + first + ", it's " + loName + " with Bridgepoint Lending. Based on what you told me (" + bits.join(", ") + "), here's where we'd start:\n\n" +
      top.map((p, i) => "Option " + letters[i] + ": up to " + (p.loanAmount ? money(p.loanAmount) : "your full amount") + " at " + p.rate + "%, " + termTxt).join("\n") +
      "\n\nThese are estimates; final terms depend on the appraisal and underwriting, and I'll confirm fees and points on a quick call. Want me to send your application so we can lock this in?";
  }
  const reasons = Array.from(new Set(results.filter((r) => r && !r.eligible && !r.unavailable && r.reason).map((r) => String(r.reason)))).slice(0, 5);
  const quote = {
    at: new Date().toISOString(), hash, status: top.length ? "ready" : "no_match",
    scenario: { loanType: lead.loan_type, summary: bits.join(", "), state: scenario.propertyState, credit: scenario.creditScore, experience: scenario.experienceDeals },
    options: top, draft, reasons: top.length ? [] : reasons,
    assumed: [scenario.citizenshipStatus === "US Citizen" && !lead.citizenship_status ? "assumed U.S. citizen" : null, !lead.entity_type ? "assumed LLC" : null,
      !rtl && lead.monthly_taxes == null ? "taxes estimated at 1.2% of value" : null, !rtl && lead.monthly_insurance == null ? "insurance estimated at 0.5% of value" : null].filter(Boolean),
  };
  await sb.from("leads").update({ ai_quote: quote }).eq("id", leadId);

  const activity = (Array.isArray(lead.activity) ? lead.activity : []) as unknown[];
  activity.push({ date: new Date().toISOString().slice(0, 10), type: "system", author: "AI Assistant",
    text: top.length ? "AI priced this deal privately from the text conversation. Best: " + top[0].rate + "% up to " + (top[0].loanAmount ? money(top[0].loanAmount) : "max") + ". Open the lead to review and send the quote."
      : "AI collected the full deal over text but nothing placed: " + (reasons[0] || "no lender matched") + "." });
  await sb.from("leads").update({ activity }).eq("id", leadId);

  if (lo) {
    const text = top.length
      ? "💰 " + lead.name + " texted their full deal and it's priced: best " + top[0].rate + "% (" + quote.scenario.summary + "). Open the lead and tap Send Quote: " + CRM_URL + "?lead=" + leadId
      : "⚠ " + lead.name + " texted their full deal but nothing placed (" + (reasons[0] || "no match").slice(0, 90) + "). Open the lead: " + CRM_URL + "?lead=" + leadId;
    await sb.from("notifications").insert({ id: "N" + crypto.randomUUID().slice(0, 8), to_user_id: lo.id, lead_id: leadId, kind: "hot-lead", text: text.slice(0, 400), date: new Date().toISOString().slice(0, 10), read: false });
    if (lo.phone) {
      await fetch(SUPABASE_URL + "/functions/v1/send-text", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_KEY },
        body: JSON.stringify({ to: lo.phone, text, fromName: "Bridgepoint CRM" }) }).catch(() => null);
    }
  }
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // The text AI calls this with the service key; signed-in staff can also re-price a lead from the CRM.
  let allowed = token === SERVICE_KEY;
  if (!allowed && token) { const { data } = await sb.auth.getUser(token).catch(() => ({ data: null as any })); allowed = !!(data && data.user); }
  if (!allowed) return json({ error: "not_authorized" }, 403);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const leadId = String(body.leadId || "");
  if (!leadId) return json({ error: "missing_lead_id" }, 400);
  const work = priceLead(leadId, body.force === true).catch((e) => console.error("ai-price-lead failed", leadId, String(e)));
  try { (globalThis as any).EdgeRuntime.waitUntil(work); } catch (_e) { await work; }
  return json({ ok: true, queued: true }, 202);
});
