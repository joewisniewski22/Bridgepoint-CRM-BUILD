// Address lookup + rural-area flag using the US Census Bureau's free public
// geocoder (no API key required). This is a server-side proxy only because
// the Census API doesn't send CORS headers, so the browser can't call it
// directly. Not a substitute for a real typeahead service (Google Places,
// etc.) -- it validates/standardizes a fairly complete address rather than
// suggesting candidates on every keystroke.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS_HEADERS });
  }
  try {
    const body = await req.json();
    const address: string = (body.address || "").trim();
    if (!address || address.length < 6) {
      return new Response(JSON.stringify({ ok: true, matched: false }), { headers: CORS_HEADERS });
    }
    const url = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress" +
      "?address=" + encodeURIComponent(address) +
      "&benchmark=Public_AR_Current&vintage=Current_Current&layers=Urban%20Areas&format=json";
    const censusRes = await fetch(url);
    if (!censusRes.ok) {
      return new Response(JSON.stringify({ ok: true, matched: false }), { headers: CORS_HEADERS });
    }
    const data = await censusRes.json();
    const matches = (data.result && data.result.addressMatches) || [];
    if (!matches.length) {
      return new Response(JSON.stringify({ ok: true, matched: false }), { headers: CORS_HEADERS });
    }
    const match = matches[0];
    const urbanAreas = (match.geographies && match.geographies["Urban Areas"]) || [];
    return new Response(JSON.stringify({
      ok: true,
      matched: true,
      matchedAddress: match.matchedAddress,
      rural: urbanAreas.length === 0,
    }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: "server_error", detail: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
