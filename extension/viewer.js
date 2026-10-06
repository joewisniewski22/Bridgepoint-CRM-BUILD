// Package viewer for lenders without a mapped portal yet (opened by the background worker).
chrome.runtime.sendMessage({ kind: "getPackage" }, (st) => {
  const out = document.getElementById("out");
  if (!st || !st.ok) { out.textContent = (st && st.error) || "No export in progress."; return; }
  const p = st.export.pkg;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  out.innerHTML = "<h2>" + esc(st.export.lenderLabel) + " — " + esc(st.export.leadName || p.meta.leadId) + "</h2>" +
    "<h3>Documents</h3><ul>" + p.documents.map((d) => '<li><a href="' + esc(d.url) + '" download="' + esc(d.fileName) + '">' + esc(d.name) + "</a></li>").join("") + "</ul>" +
    "<h3>File details</h3><pre>" + esc(JSON.stringify({ loan: p.loan, property: p.property, borrower: p.borrower, trackRecord: p.trackRecord }, null, 2)) + "</pre>";
});
