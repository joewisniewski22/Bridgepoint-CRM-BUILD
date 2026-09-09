// One-off admin utility: removes an address from Postmark's suppression
// list so transactional email can reach it again. Postmark auto-suppresses
// an address after a hard bounce, spam complaint, or manual suppression --
// removing the suppression is the only way to unblock it (retrying the
// send just gets rejected again). Not wired into the CRM UI; invoked
// directly when an address turns up bounced.
const POSTMARK_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const { email, stream } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ error: "missing_email" }), { status: 400, headers: CORS_HEADERS });
    }
    const streamId = stream || "outbound";
    const res = await fetch(`https://api.postmarkapp.com/message-streams/${streamId}/suppressions/delete`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": POSTMARK_TOKEN,
      },
      body: JSON.stringify({ Suppressions: [{ EmailAddress: email }] }),
    });
    const data = await res.json();
    return new Response(JSON.stringify({ ok: res.ok, status: res.status, data }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
