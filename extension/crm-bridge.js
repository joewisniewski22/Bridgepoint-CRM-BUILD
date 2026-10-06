// Runs on the Bridgepoint CRM. When Joe/Erika/Fiore click a lender under
// "Export to Lender", the CRM posts the one-time export token here; we hand it
// to the background worker (which opens the lender tab) and acknowledge so the
// CRM knows the extension is installed.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.type !== "BRIDGEPOINT_LENDER_EXPORT") return;
  const d = e.data;
  if (!/^[0-9a-f]{64}$/.test(d.token || "")) return;
  chrome.runtime.sendMessage({ kind: "startExport", token: d.token, lender: d.lender, lenderLabel: d.lenderLabel, portalUrl: d.portalUrl, api: d.api, leadName: d.leadName }, (res) => {
    if (res && res.ok) window.postMessage({ type: "BRIDGEPOINT_LENDER_EXPORT_ACK", token: d.token }, window.location.origin);
  });
});
