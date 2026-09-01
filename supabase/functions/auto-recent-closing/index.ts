// Fires automatically when a loan moves to Closed/Funded. Builds a
// conservative, anonymized closing announcement (loan type, general
// location, amount -- no borrower name, no exact street address) and
// publishes it to the CRM's own public showcase page (see site_content
// table + the public ?showcase=1 route in index.html). CRM-native by
// design -- Joe's site currently runs on GoHighLevel and this whole CRM
// build is meant to eventually replace GHL, not deepen the dependency on
// it. The owner's AI command box can create richer/named posts on request
// via the same create/publish path.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function esc(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtUSD(n: number | null): string | null {
  if (n == null) return null;
  return "$" + Math.round(n).toLocaleString("en-US");
}
function cityStateFromAddress(addr: string | null): string {
  if (!addr) return "";
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[1] + ", " + parts[2].split(" ")[0];
  if (parts.length === 2) return parts[1];
  return "";
}

function buildClosingCopy(lead: Record<string, unknown>): { title: string; body: string } {
  const loanType = (lead.loan_type as string) || "real estate";
  const cityState = cityStateFromAddress(lead.property_address as string);
  const amount = fmtUSD(lead.loan_amount as number);
  const exit = lead.exit_strategy as string;

  const title = "Closed: " + loanType + (cityState ? " in " + cityState : "") + (amount ? " — " + amount : "");
  const body =
    "<p>Bridgepoint Lending is proud to announce another successful closing" + (cityState ? " in " + esc(cityState) : "") + ".</p>" +
    "<p>" +
    "<strong>Loan type:</strong> " + esc(loanType) + "<br>" +
    (amount ? "<strong>Loan amount:</strong> " + amount + "<br>" : "") +
    (exit ? "<strong>Strategy:</strong> " + esc(exit) + "<br>" : "") +
    "</p>" +
    "<p>Ready to fund your next deal? <a href=\"https://bplending.com\">Get in touch with Bridgepoint Lending</a>.</p>";
  return { title, body };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const leadId: string = body.leadId;
    if (!leadId) {
      return new Response(JSON.stringify({ error: "missing_lead_id" }), { status: 400, headers: CORS_HEADERS });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: lead, error: leadErr } = await sb.from("leads").select("*").eq("id", leadId).single();
    if (leadErr || !lead) {
      return new Response(JSON.stringify({ error: "lead_not_found" }), { status: 404, headers: CORS_HEADERS });
    }

    const { title, body: postBody } = buildClosingCopy(lead);
    const contentId = "sc-" + crypto.randomUUID();
    await sb.from("site_content").insert({
      id: contentId, type: "closing", lead_id: leadId, title, body: postBody,
      status: "published", created_by: "system", published_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ ok: true, contentId, title, published: true }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
