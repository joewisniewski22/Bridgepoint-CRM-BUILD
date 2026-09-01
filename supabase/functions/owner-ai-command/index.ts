// Owner-only AI command box. Joe types a plain-English request in his
// portal; Claude decides which of a small, fixed set of real backend tools
// to call (look up closed deals, draft/publish marketing content to the
// bplending.com WordPress site) and reports back what it actually did.
// Deliberately narrow tool surface -- no arbitrary code/SQL execution, no
// ad-spend or payment tools yet (those get added only once those
// integrations are actually connected). Never claims an action succeeded
// unless the corresponding tool call reported success.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WP_URL = Deno.env.get("WP_URL") || "";
const WP_USERNAME = Deno.env.get("WP_USERNAME") || "";
const WP_APP_PASSWORD = Deno.env.get("WP_APP_PASSWORD") || "";
const MODEL = "claude-sonnet-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SYSTEM_PROMPT =
  "You are Joe's AI operations assistant for Bridgepoint Lending, embedded in his CRM (owner-only -- you're never shown to loan officers or borrowers). " +
  "You currently have tools for: looking up recently closed deals, and drafting/publishing marketing content (recent-closing announcements, story posts) to the company WordPress site at bplending.com. " +
  "You do NOT yet have access to ad platforms (Meta/Facebook), payments, pricing, or other users' data -- if asked for something outside your current tools, say clearly that it isn't wired up yet rather than pretending to do it. " +
  "When asked to post/publish something, always use create_content then publish_content -- never claim something is live unless publish_content reports success. " +
  "When drafting closing announcements or stories, default to NOT naming the borrower and NOT including their exact street address (city/state only) unless Joe explicitly asks you to include the name -- these are real clients' financial details. " +
  "Keep marketing copy in a warm, direct, non-corporate voice. Write body content as simple HTML (p, strong, br, a tags only). Be concise in your replies back to Joe -- confirm what you did, don't over-explain.";

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
    description: "Publish a draft content item live to the bplending.com WordPress site.",
    input_schema: {
      type: "object",
      properties: { contentId: { type: "string" } },
      required: ["contentId"],
    },
  },
];

function fmtUSD(n: number | null): string | null {
  if (n == null) return null;
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function publishToWordPress(title: string, body: string): Promise<{ ok: boolean; wpPostId?: number; wpUrl?: string; error?: string }> {
  if (!WP_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
    return { ok: false, error: "WordPress isn't connected yet -- Joe needs to generate a WP Application Password and set WP_URL/WP_USERNAME/WP_APP_PASSWORD." };
  }
  const auth = btoa(WP_USERNAME + ":" + WP_APP_PASSWORD);
  const res = await fetch(WP_URL.replace(/\/$/, "") + "/wp-json/wp/v2/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
    body: JSON.stringify({ title, content: body, status: "publish" }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: JSON.stringify(data) };
  return { ok: true, wpPostId: data.id, wpUrl: data.link };
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
    const { data: row, error } = await sb.from("site_content").select("*").eq("id", input.contentId).single();
    if (error || !row) return { error: "content_not_found" };
    const result = await publishToWordPress(row.title, row.body);
    if (result.ok) {
      await sb.from("site_content").update({
        status: "published", wp_post_id: result.wpPostId, wp_url: result.wpUrl, published_at: new Date().toISOString(),
      }).eq("id", row.id);
    } else {
      await sb.from("site_content").update({ status: "publish_failed" }).eq("id", row.id);
    }
    return result;
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
    if (!message) {
      return new Response(JSON.stringify({ error: "missing_message" }), { status: 400, headers: CORS_HEADERS });
    }

    const { data: history } = await sb.from("ai_chat_messages").select("role,content").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(20);
    const priorMessages = (history || []).reverse().map((m) => ({ role: m.role, content: m.content }));

    const messages: Array<Record<string, unknown>> = [...priorMessages, { role: "user", content: message }];
    const actionsTaken: Array<Record<string, unknown>> = [];

    let finalText = "";
    for (let iter = 0; iter < 6; iter++) {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, messages, tools: TOOLS }),
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

    await sb.from("ai_chat_messages").insert([
      { id: "msg-" + crypto.randomUUID(), user_id: userId, role: "user", content: message },
      { id: "msg-" + crypto.randomUUID(), user_id: userId, role: "assistant", content: finalText || "(no reply)" },
    ]);

    return new Response(JSON.stringify({ ok: true, reply: finalText, actions: actionsTaken }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
