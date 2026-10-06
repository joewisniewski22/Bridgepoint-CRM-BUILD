// Bridgepoint Lender Export -- background worker.
// Holds the current export (token + lender), fetches the lender package from
// the CRM's lender-export function, downloads documents for upload, and opens
// the lender's portal. Nothing here ever logs into a lender or submits anything.
const API_ALLOWED = /^https:\/\/idzkigmvovehjpapatxv\.supabase\.co\/functions\/v1\/lender-export$/;

async function getExport() {
  const { current } = await chrome.storage.session.get("current");
  return current || null;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.kind === "startExport") {
      if (!API_ALLOWED.test(msg.api || "")) return reply({ ok: false, error: "bad api" });
      const current = { token: msg.token, lender: msg.lender, lenderLabel: msg.lenderLabel, api: msg.api, leadName: msg.leadName, startedAt: Date.now(), pkg: null };
      await chrome.storage.session.set({ current });
      const url = msg.portalUrl || chrome.runtime.getURL("viewer.html");
      await chrome.tabs.create({ url });
      return reply({ ok: true });
    }
    if (msg.kind === "getPackage") {
      const cur = await getExport();
      if (!cur) return reply({ ok: false, error: "No export in progress. Click Export to Lender in the CRM first." });
      if (cur.pkg && !msg.refresh) return reply({ ok: true, export: cur });
      const r = await fetch(cur.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "package", token: cur.token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.package) return reply({ ok: false, error: (j && j.detail) || "Couldn't load the file from the CRM (the link may have expired — click Export to Lender again)." });
      cur.pkg = j.package;
      await chrome.storage.session.set({ current: cur });
      return reply({ ok: true, export: cur });
    }
    if (msg.kind === "fetchDoc") {
      // Returns the document as base64 so the page script can build a File for an upload input.
      const r = await fetch(msg.url);
      if (!r.ok) return reply({ ok: false, error: "download failed (" + r.status + ")" });
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return reply({ ok: true, b64: btoa(s), type: r.headers.get("content-type") || "application/octet-stream" });
    }
    if (msg.kind === "log") {
      const cur = await getExport();
      if (!cur) return reply({ ok: false });
      await fetch(cur.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "log", token: cur.token, events: msg.events || [] }) }).catch(() => null);
      return reply({ ok: true });
    }
    if (msg.kind === "clear") { await chrome.storage.session.remove("current"); return reply({ ok: true }); }
    reply({ ok: false, error: "unknown" });
  })();
  return true; // async reply
});
