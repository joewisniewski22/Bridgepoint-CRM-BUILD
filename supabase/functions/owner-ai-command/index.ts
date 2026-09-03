// Owner-only AI command box. Joe types a plain-English request in his
// portal; Claude decides which of a small, fixed set of real backend tools
// to call (look up closed deals, draft/publish marketing content to the
// CRM's own public showcase page) and reports back what it actually did.
// CRM-native by design -- this whole CRM build is meant to eventually
// replace GoHighLevel (which currently runs bplending.com), not deepen
// the dependency on it. Deliberately narrow tool surface -- no arbitrary
// code/SQL execution, no ad-spend or payment tools yet (those get added
// only once those integrations are actually connected). Never claims an
// action succeeded unless the corresponding tool call reported success.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const LOAN_TYPES = ["DSCR", "Fix & Flip", "Ground Up Construction", "Portfolio/Blanket", "Bridge", "Mixed-Use"];
const SOURCES = ["Meta Ads", "Connected Investors", "Referral", "Repeat Client", "Website", "Self-Generated"];
const OUTSIDE_LENDERS = ["Kiavi", "RELIP", "RCN"];
const CITIZENSHIP_STATUSES = ["US Citizen", "Permanent Resident", "Foreign National", "ITIN"];
const PREPAY_TERMS = ["5yr", "3yr", "2yr", "1yr", "none"];

async function buildSystemPrompt(): Promise<string> {
  const { data: staff } = await sb.from("users").select("id,name,role").order("name");
  const roster = (staff || []).map((u) => u.id + " = " + u.name + " (" + u.role + ")").join("; ");
  return "You are Joe's AI operations assistant for Bridgepoint Lending, embedded in his CRM (owner-only -- you're never shown to loan officers or borrowers). " +
    "This CRM is meant to eventually replace GoHighLevel entirely (which currently runs bplending.com) -- content you publish lives on the CRM's public page, not GoHighLevel. " +
    "You do NOT yet have access to ad platforms (Meta/Facebook), payments, or pricing changes -- if asked for something outside your current tools, say clearly that it isn't wired up yet rather than pretending to do it. " +
    "\n\nStaff roster (use these exact ids for assignedTo, never guess an id): " + roster +
    "\n\nCAPABILITIES:\n" +
    "1. Marketing content: create_content then publish_content to post recent-closing announcements or stories to the CRM's public showcase page. Never claim something is live unless publish_content reports success. Default to NOT naming the borrower and NOT including their exact street address (city/state only) unless Joe explicitly asks -- these are real clients' financial details. Write body as simple HTML (p, strong, br, a tags only).\n" +
    "2. Loan file creation from a term sheet: when Joe pastes term sheet text or attaches a term sheet document/image for a BRAND NEW loan (not already in the CRM), extract the real figures and call create_loan_file. Valid loanType values: " + LOAN_TYPES.join(", ") + ". Valid source values: " + SOURCES.join(", ") + " (use 'Referral' or the closest fit if unclear, never invent a new source). Valid outsideLender values: " + OUTSIDE_LENDERS.join(", ") + " or omit for in-house. NEVER guess a figure that isn't actually in the document -- omit any field you can't find rather than inventing a number, and tell Joe what's missing in your reply. If the assignee isn't stated, ASK rather than picking someone.\n" +
    "3. Updating an EXISTING loan file: when Joe gets a new/real quote back (e.g. a lender's pricing terms sheet) for a loan already in the CRM, call update_loan_file with the leadId and only the fields that changed -- extract real figures the same way as create_loan_file, never guess. If Joe doesn't give you the leadId, ask for it (or ask for the borrower's name and use list_closed_deals / say you need the id -- you have no generic lead-search tool yet). Always write a one-sentence changeSummary describing what changed and why (e.g. citing a pricing/quote ID if the source document has one) -- it gets logged to the loan's activity history.\n" +
    "4. Sending documents: to send a Pre-Approval Letter or Term Sheet to a borrower on an existing loan file, call send_document with the leadId and kind -- this actually emails/texts them for real, so only call it when Joe clearly asks to send (not just when he asks you to create or update a file).\n" +
    "5. Looking up loans: list_closed_deals for recently funded loans.\n\n" +
    "Keep replies concise -- confirm what you actually did (per tool results), don't over-explain. If a tool result shows an error, say so plainly rather than claiming success.";
}

const TOOLS = [
  {
    name: "list_closed_deals",
    description: "Look up recently closed/funded loans to reference in marketing content.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results, default 5" } },
    },
  },
  {
    name: "list_content_drafts",
    description: "List existing site content (recent closings / stories) and their status.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["draft", "published", "publish_failed", "all"], description: "Filter by status, default all" } },
    },
  },
  {
    name: "create_content",
    description: "Create a new piece of marketing content as a draft (not yet live). Follow with publish_content to actually push it to the website.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["closing", "story"] },
        leadId: { type: "string", description: "Related loan file id, if any" },
        title: { type: "string" },
        body: { type: "string", description: "Simple HTML content (p, strong, br, a tags only)" },
      },
      required: ["type", "title", "body"],
    },
  },
  {
    name: "publish_content",
    description: "Publish a draft content item live to the CRM's public showcase page (bridgepoint-crm-build.vercel.app/?showcase=1).",
    input_schema: {
      type: "object",
      properties: { contentId: { type: "string" } },
      required: ["contentId"],
    },
  },
  {
    name: "create_loan_file",
    description: "Create a new loan file from a term sheet Joe pasted or attached. Only include fields you actually found -- omit anything not clearly stated.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Borrower/guarantor full name" },
        email: { type: "string" },
        phone: { type: "string" },
        loanType: { type: "string", enum: LOAN_TYPES },
        source: { type: "string", enum: SOURCES },
        assignedTo: { type: "string", description: "Staff user id from the roster" },
        outsideLender: { type: "string", enum: OUTSIDE_LENDERS, description: "Omit if in-house" },
        propertyAddress: { type: "string" },
        propertyType: { type: "string" },
        purchasePrice: { type: "number" },
        loanAmount: { type: "number" },
        rate: { type: "number", description: "Interest rate as a percent, e.g. 10.99" },
        termMonths: { type: "integer" },
        pointsCharged: { type: "number", description: "Total points as a percent, e.g. 4.44" },
        creditScore: { type: "integer" },
        entityLegalName: { type: "string" },
        exitStrategy: { type: "string" },
        notifyAssignee: { type: "boolean", description: "Whether to email the assigned staff member about this new file (default true)" },
      },
      required: ["name", "loanType"],
    },
  },
  {
    name: "update_loan_file",
    description: "Update fields on an EXISTING loan file already in the CRM -- e.g. after Joe gets a real quote/pricing terms sheet back for a loan. Only include fields you actually found in the new document; anything omitted is left untouched.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "The loan file id to update -- ask Joe for this if he hasn't given it" },
        propertyAddress: { type: "string" },
        propertyType: { type: "string" },
        transactionType: { type: "string", enum: ["purchase", "ratetermrefi", "cashout"] },
        purchasePrice: { type: "number" },
        currentValue: { type: "number", description: "As-is value -- used instead of purchase price for refinance LTV" },
        arv: { type: "number", description: "After-repair value, for rehab/construction loans" },
        rehabBudget: { type: "number" },
        rentEstimate: { type: "number", description: "Monthly rental income, for DSCR loans" },
        monthlyTaxes: { type: "number" },
        monthlyInsurance: { type: "number" },
        monthlyHoa: { type: "number" },
        loanAmount: { type: "number" },
        rate: { type: "number", description: "Interest rate as a percent, e.g. 6.975" },
        termMonths: { type: "integer" },
        pointsCharged: { type: "number", description: "Total points Bridgepoint is actually charging, as a percent -- use what Joe tells you to charge, not necessarily whatever number is printed on an outside quote" },
        creditScore: { type: "integer" },
        prepayTerm: { type: "string", enum: PREPAY_TERMS },
        citizenshipStatus: { type: "string", enum: CITIZENSHIP_STATUSES },
        exitStrategy: { type: "string" },
        changeSummary: { type: "string", description: "One short sentence for the activity log describing what changed and why (cite a pricing/quote ID from the source document if there is one)" },
        notifyAssignee: { type: "boolean", description: "Whether to text/email the assigned loan officer that terms changed (default true)" },
      },
      required: ["leadId"],
    },
  },
  {
    name: "send_document",
    description: "Send a Pre-Approval Letter or Term Sheet to a borrower on an existing loan file -- real email + text. Only call this when Joe explicitly asks to send something, not when just creating a file.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string" },
        kind: { type: "string", enum: ["preapproval", "termSheet"] },
      },
      required: ["leadId", "kind"],
    },
  },
];

function fmtUSD(n: number | null): string | null {
  if (n == null) return null;
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "list_closed_deals") {
    const limit = Math.min((input.limit as number) || 5, 20);
    const { data, error } = await sb.from("leads").select("id,name,loan_type,loan_amount,property_address,exit_strategy,close_date")
      .in("stage", ["closed", "postclosing"]).order("close_date", { ascending: false }).limit(limit);
    if (error) return { error: error.message };
    return { deals: (data || []).map((l) => ({
      id: l.id, name: l.name, loanType: l.loan_type, loanAmount: fmtUSD(l.loan_amount),
      propertyAddress: l.property_address, exitStrategy: l.exit_strategy, closeDate: l.close_date,
    })) };
  }
  if (name === "list_content_drafts") {
    const status = (input.status as string) || "all";
    let q = sb.from("site_content").select("id,type,title,status,wp_url,created_at").order("created_at", { ascending: false }).limit(20);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { items: data || [] };
  }
  if (name === "create_content") {
    const contentId = "sc-" + crypto.randomUUID();
    const { error } = await sb.from("site_content").insert({
      id: contentId, type: input.type, lead_id: input.leadId || null,
      title: input.title, body: input.body, status: "draft", created_by: "owner-ai",
    });
    if (error) return { error: error.message };
    return { ok: true, contentId };
  }
  if (name === "publish_content") {
    const { data: row, error } = await sb.from("site_content").select("id").eq("id", input.contentId).single();
    if (error || !row) return { error: "content_not_found" };
    const { error: updErr } = await sb.from("site_content").update({
      status: "published", published_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (updErr) return { ok: false, error: updErr.message };
    return { ok: true, url: "https://bridgepoint-crm-build.vercel.app/?showcase=1" };
  }
  if (name === "create_loan_file") {
    if (!LOAN_TYPES.includes(input.loanType as string)) return { error: "invalid_loan_type", validValues: LOAN_TYPES };
    if (input.assignedTo) {
      const { data: staffCheck } = await sb.from("users").select("id").eq("id", input.assignedTo).single();
      if (!staffCheck) return { error: "invalid_assignedTo", detail: "No staff member with that id" };
    }
    const id = "L" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const row: Record<string, unknown> = {
      id, name: input.name, email: input.email || null, phone: input.phone || null,
      source: input.source || "Referral", loan_type: input.loanType, stage: "new", status: "active",
      assigned_to: input.assignedTo || null, created_at: today,
      entity_type: "LLC", credit_score: input.creditScore || null,
      property_address: input.propertyAddress || null, property_type: input.propertyType || null,
      purchase_price: input.purchasePrice || null, loan_amount: input.loanAmount || null,
      rate: input.rate || null, term_months: input.termMonths || null, points_charged: input.pointsCharged || null,
      exit_strategy: input.exitStrategy || null, entity_legal_name: input.entityLegalName || null,
      outside_lender: input.outsideLender || null,
      application_token: crypto.randomUUID(),
      activity: [{ date: today, type: "note", text: "Loan file created by AI from a term sheet", author: "AI Assistant" }],
    };
    const { error } = await sb.from("leads").insert(row);
    if (error) return { error: error.message };
    const link = "https://bridgepoint-crm-build.vercel.app/?lead=" + id;
    if (input.notifyAssignee !== false && input.assignedTo) {
      const { data: assignee } = await sb.from("users").select("email,phone,name,quo_phone_number").eq("id", input.assignedTo).single();
      if (assignee?.email) {
        fetch(SUPABASE_URL + "/functions/v1/send-email", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.email, subject: "New loan file: " + input.name, text: "New loan file: " + input.name + " (" + input.loanType + ") — open & dial: " + link, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
      if (assignee?.phone) {
        fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.phone, text: "🔥 New loan file: " + input.name + " (" + input.loanType + ") — open & dial: " + link, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
    }
    return { ok: true, leadId: id, link };
  }
  if (name === "update_loan_file") {
    const leadId = input.leadId as string;
    if (!leadId) return { error: "missing_leadId" };
    const { data: existing, error: fetchErr } = await sb.from("leads").select("*").eq("id", leadId).single();
    if (fetchErr || !existing) return { error: "lead_not_found" };

    const fieldMap: Record<string, string> = {
      propertyAddress: "property_address", propertyType: "property_type", transactionType: "transaction_type",
      purchasePrice: "purchase_price", currentValue: "current_value", arv: "arv", rehabBudget: "rehab_budget",
      rentEstimate: "rent_estimate", monthlyTaxes: "monthly_taxes", monthlyInsurance: "monthly_insurance",
      monthlyHoa: "monthly_hoa", loanAmount: "loan_amount", rate: "rate", termMonths: "term_months",
      pointsCharged: "points_charged", creditScore: "credit_score", prepayTerm: "prepay_term",
      citizenshipStatus: "citizenship_status", exitStrategy: "exit_strategy",
    };
    const patch: Record<string, unknown> = {};
    const changedLabels: string[] = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      const v = input[key];
      if (v !== undefined && v !== null && v !== "") {
        patch[col] = v;
        changedLabels.push(key + " = " + v);
      }
    }
    if (Object.keys(patch).length === 0) return { error: "no_fields_provided" };

    const merged = { ...existing, ...patch } as Record<string, unknown>;
    const txnType = merged.transaction_type as string | null;
    const valueBasis = (txnType && txnType !== "purchase" && merged.current_value)
      ? (merged.current_value as number) : (merged.purchase_price as number | null);
    if (valueBasis && merged.loan_amount) {
      patch.ltv = Math.round(((merged.loan_amount as number) / valueBasis) * 1000) / 10;
    }

    const today = new Date().toISOString().slice(0, 10);
    const activity = Array.isArray(existing.activity) ? existing.activity as unknown[] : [];
    activity.push({
      date: today, type: "note",
      text: (input.changeSummary as string) || ("Loan scenario updated by AI: " + changedLabels.join(", ")),
      author: "AI Assistant",
    });
    patch.activity = activity;

    const { error: updErr } = await sb.from("leads").update(patch).eq("id", leadId);
    if (updErr) return { error: updErr.message };

    const link = "https://bridgepoint-crm-build.vercel.app/?lead=" + leadId;
    if (input.notifyAssignee !== false && existing.assigned_to) {
      const { data: assignee } = await sb.from("users").select("email,phone,name").eq("id", existing.assigned_to as string).single();
      const alertText = (existing.name as string) + "'s loan terms were updated: " + changedLabels.join(", ") + " — " + link;
      if (assignee?.email) {
        fetch(SUPABASE_URL + "/functions/v1/send-email", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.email, subject: "Loan terms updated: " + existing.name, text: alertText, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
      if (assignee?.phone) {
        fetch(SUPABASE_URL + "/functions/v1/send-text", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + SERVICE_ROLE_KEY },
          body: JSON.stringify({ to: assignee.phone, text: alertText, fromName: "Bridgepoint CRM" }),
        }).catch(() => {});
      }
    }
    return { ok: true, leadId, link, changedFields: changedLabels };
  }
  if (name === "send_document") {
    const { data: lead } = await sb.from("leads").select("id").eq("id", input.leadId).single();
    if (!lead) return { error: "lead_not_found" };
    if (input.kind !== "preapproval" && input.kind !== "termSheet") return { error: "invalid_kind" };
    // Actual bilingual send happens client-side (reuses the CRM's tested
    // send pipeline) -- this just validates and signals the frontend to do it.
    return { ok: true, requiresFrontendAction: "send_document", leadId: input.leadId, kind: input.kind };
  }
  return { error: "unknown_tool" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const message: string = body.message;
    const userId: string = body.userId || "owner";
    // Optional term sheet attachment (PDF or image), base64-encoded.
    const attachmentBase64: string | null = body.attachmentBase64 || null;
    const attachmentMediaType: string | null = body.attachmentMediaType || null;
    if (!message && !attachmentBase64) {
      return new Response(JSON.stringify({ error: "missing_message" }), { status: 400, headers: CORS_HEADERS });
    }

    const { data: history } = await sb.from("ai_chat_messages").select("role,content").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(20);
    const priorMessages = (history || []).reverse().map((m) => ({ role: m.role, content: m.content }));

    const userContent: Array<Record<string, unknown>> = [];
    if (attachmentBase64 && attachmentMediaType) {
      const blockType = attachmentMediaType === "application/pdf" ? "document" : "image";
      userContent.push({ type: blockType, source: { type: "base64", media_type: attachmentMediaType, data: attachmentBase64 } });
    }
    userContent.push({ type: "text", text: message || "Here's a term sheet -- create a loan file from it." });

    const messages: Array<Record<string, unknown>> = [...priorMessages, { role: "user", content: userContent }];
    const actionsTaken: Array<Record<string, unknown>> = [];
    const systemPrompt = await buildSystemPrompt();

    let finalText = "";
    for (let iter = 0; iter < 6; iter++) {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1536, system: systemPrompt, messages, tools: TOOLS }),
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        return new Response(JSON.stringify({ error: "anthropic_error", detail: aiData }), { status: 502, headers: CORS_HEADERS });
      }

      const content = aiData.content || [];
      const textParts = content.filter((c: Record<string, unknown>) => c.type === "text").map((c: Record<string, unknown>) => c.text).join("\n");
      const toolUses = content.filter((c: Record<string, unknown>) => c.type === "tool_use");

      if (aiData.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = textParts;
        break;
      }

      messages.push({ role: "assistant", content });
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await runTool(tu.name, tu.input || {});
        actionsTaken.push({ tool: tu.name, input: tu.input, result });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }

    const historyText = (message || "") + (attachmentBase64 ? " [attached a document/image]" : "");
    await sb.from("ai_chat_messages").insert([
      { id: "msg-" + crypto.randomUUID(), user_id: userId, role: "user", content: historyText },
      { id: "msg-" + crypto.randomUUID(), user_id: userId, role: "assistant", content: finalText || "(no reply)" },
    ]);

    return new Response(JSON.stringify({ ok: true, reply: finalText, actions: actionsTaken }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
