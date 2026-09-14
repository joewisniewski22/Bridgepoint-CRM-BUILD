// One-off diagnostic: looks up a sent message's real delivery status
// (Sent/Delivered/Bounced/etc.) from Postmark's own Message Details API,
// using the same POSTMARK_SERVER_TOKEN already configured for send-email.
// Exists because "the API accepted it" (what send-email's own response
// confirms) is NOT the same thing as "it actually reached an inbox" --
// Postmark can still bounce a message asynchronously after accepting it.
const POSTMARK_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const url = new URL(req.url);
    let messageId = url.searchParams.get("messageId");
    if (!messageId && req.method === "POST") {
      const body = await req.json();
      messageId = body.messageId;
    }
    if (!messageId) return new Response(JSON.stringify({ error: "missing_messageId" }), { status: 400, headers: CORS_HEADERS });

    const res = await fetch("https://api.postmarkapp.com/messages/outbound/" + encodeURIComponent(messageId) + "/details", {
      headers: { "Accept": "application/json", "X-Postmark-Server-Token": POSTMARK_TOKEN },
    });
    const data = await res.json();
    if (!res.ok) return new Response(JSON.stringify({ error: "postmark_error", detail: data }), { status: 502, headers: CORS_HEADERS });

    return new Response(JSON.stringify({
      ok: true,
      status: data.Status,
      recipients: data.Recipients,
      messageEvents: (data.MessageEvents || []).map((e: Record<string, unknown>) => ({ type: e.Type, time: e.ReceivedAt, details: e.Details })),
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
