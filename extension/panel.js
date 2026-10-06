// Bridgepoint panel on lender sites. Appears only while an Export to Lender is
// in progress for THIS lender. Staff log in to the lender themselves; the panel
// fills the current page from the CRM package, uploads documents, and lists
// every value for click-to-copy. It never presses the lender's submit button.
(async function () {
  const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
  const host = location.hostname;
  const lenderKey = Object.keys(window.BP_MAPS).find((k) => window.BP_MAPS[k].host && window.BP_MAPS[k].host.test(host));
  if (!lenderKey) return;
  const st = await send({ kind: "getPackage" });
  if (!st || !st.ok || st.export.lender !== lenderKey) return; // not exporting to this lender right now
  const exp = st.export, pkg = exp.pkg, map = window.BP_MAPS[lenderKey];

  // ---- panel UI (shadow DOM so the lender's CSS can't break it) ----
  const hostEl = document.createElement("div");
  hostEl.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647";
  const root = hostEl.attachShadow({ mode: "open" });
  document.documentElement.appendChild(hostEl);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const money = (v) => (v == null || v === "" ? "" : "$" + Math.round(Number(v)).toLocaleString("en-US"));
  root.innerHTML = `
  <style>
    .p{width:340px;max-height:86vh;overflow:auto;background:#fff;border:2px solid #0b2a4a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111}
    .h{background:#0b2a4a;color:#fff;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0}
    .h b{color:#e8c36a}.b{padding:10px 12px}.btn{background:#0b2a4a;color:#fff;border:0;border-radius:6px;padding:8px 10px;cursor:pointer;font-weight:600;width:100%}
    .btn2{background:#eef2f7;color:#0b2a4a;border:1px solid #c9d3df;border-radius:6px;padding:4px 7px;cursor:pointer;font-size:12px}
    .sec{margin-top:10px;border-top:1px solid #e5e7eb;padding-top:8px}.t{font-weight:700;font-size:12px;text-transform:uppercase;color:#0b2a4a;margin-bottom:4px}
    .kv{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dotted #eee;cursor:pointer}.kv span:first-child{color:#555}.kv span:last-child{font-weight:600;text-align:right}
    .ok{color:#166534}.bad{color:#b42318}.muted{color:#666;font-size:12px}select{max-width:150px;font-size:12px}
    .min{background:transparent;border:0;color:#fff;cursor:pointer;font-size:16px}
  </style>
  <div class="p"><div class="h"><div><b>Bridgepoint</b> → ${esc(exp.lenderLabel)}<div class="muted" style="color:#cbd5e1">${esc(exp.leadName || pkg.meta.leadId)}</div></div><button class="min" id="min" title="Minimize">–</button></div>
  <div class="b" id="body">
    <button class="btn" id="fill">Fill this page</button>
    <div id="res" class="muted" style="margin-top:6px">${map.pages.length ? "Log in, open the application page, then click Fill." : "This lender isn't mapped yet — copy fields below and use the document buttons to upload."}</div>
    <div class="sec"><div class="t">Documents (${pkg.documents.length})</div><div id="docs"></div></div>
    <div class="sec"><div class="t">All file details — click to copy</div><div id="kv"></div></div>
    <div class="sec muted">SSN and bank account numbers aren't sent — type those on the lender's form. Review everything, then submit on ${esc(exp.lenderLabel)} yourself.</div>
  </div></div>`;
  const $ = (id) => root.getElementById(id);
  $("min").onclick = () => { const b = $("body"); b.style.display = b.style.display === "none" ? "" : "none"; };

  // ---- click-to-copy list of every value ----
  const g = pkg.borrower.guarantor || {}, co = pkg.borrower.coGuarantor, L = pkg.loan, P = pkg.property;
  const rows = [
    ["Loan type", L.loanType], ["Transaction", L.transactionType], ["Loan amount", money(L.loanAmount)], ["Rate", L.rate], ["Term (months)", L.termMonths],
    ["Purchase price", money(L.purchasePrice)], ["As-is / current value", money(L.currentValue)], ["ARV", money(L.arv)], ["Rehab budget", money(L.rehabBudget)], ["Payoff", money(L.currentLoanBalance)], ["Target close", L.closeDate], ["Prepay", L.prepayTerm], ["Exit strategy", L.exitStrategy],
    ["Property street", P.street], ["City", P.city], ["State", P.state], ["Zip", P.zip], ["Property type", P.propertyType], ["Units", P.units], ["Year built", P.yearBuilt], ["Monthly rent", money(P.monthlyRent)], ["Monthly taxes", money(P.monthlyTaxes)], ["Monthly insurance", money(P.monthlyInsurance)], ["Monthly HOA", money(P.monthlyHoa)],
    ["Entity name", pkg.borrower.entityName], ["Entity type", pkg.borrower.entityType],
    ["Guarantor first", g.firstName], ["Guarantor middle", g.middleName], ["Guarantor last", g.lastName], ["Email", g.email], ["Phone", g.phone], ["Date of birth", g.dateOfBirth], ["Home address", g.address], ["Citizenship", g.citizenship], ["Marital status", g.maritalStatus], ["Ownership %", g.ownershipPct], ["Credit score (est.)", g.creditScore], ["Completed deals", g.experienceDeals], ["Liquidity", money(g.liquidity)],
  ];
  if (co) rows.push(["Co-guarantor", [co.firstName, co.lastName].filter(Boolean).join(" ")], ["Co email", co.email], ["Co phone", co.phone], ["Co DOB", co.dateOfBirth], ["Co ownership %", co.ownershipPct]);
  $("kv").innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map((r) => `<div class="kv" data-v="${esc(r[1])}"><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join("") +
    (pkg.trackRecord.length ? `<div class="muted" style="margin-top:6px">${pkg.trackRecord.length} track-record properties: ${pkg.trackRecord.map((t) => esc(t.address)).join("; ")}</div>` : "");
  root.querySelectorAll(".kv").forEach((el) => (el.onclick = () => { navigator.clipboard.writeText(el.dataset.v); el.style.background = "#ecfdf5"; setTimeout(() => (el.style.background = ""), 600); }));

  // ---- documents: download, or attach to any upload slot on this page ----
  const fetchDoc = async (d) => {
    const r = await send({ kind: "fetchDoc", url: d.url });
    if (!r || !r.ok) return null;
    const bin = atob(r.b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], d.fileName, { type: r.type });
  };
  const slotOptions = () => Array.from(document.querySelectorAll('input[type="file"]')).map((inp, i) => {
    let label = ""; let n = inp; for (let k = 0; k < 5 && n && !label; k++) { n = n.parentElement; const t = n && n.innerText && n.innerText.trim(); if (t) label = t.split("\n")[0].slice(0, 40); }
    return { i, label: label || "Upload slot " + (i + 1) };
  });
  const renderDocs = () => {
    const slots = slotOptions();
    $("docs").innerHTML = pkg.documents.map((d, i) => `<div class="kv" style="cursor:default"><span title="${esc(d.fileName)}">${esc(d.name)}</span><span>
      <a class="btn2" href="${esc(d.url)}" target="_blank" download="${esc(d.fileName)}">⬇</a>
      ${slots.length ? `<select data-i="${i}"><option value="">Attach to…</option>${slots.map((s) => `<option value="${s.i}">${esc(s.label)}</option>`).join("")}</select>` : ""}
    </span></div>`).join("") || '<div class="muted">No received documents on this file yet.</div>';
    root.querySelectorAll("select[data-i]").forEach((sel) => (sel.onchange = async () => {
      if (sel.value === "") return;
      const d = pkg.documents[Number(sel.dataset.i)], input = document.querySelectorAll('input[type="file"]')[Number(sel.value)];
      const f = await fetchDoc(d);
      if (f && input) { await window.BPFill.uploadToInput(input, [f]); sel.outerHTML = '<span class="ok">attached ✓</span>'; send({ kind: "log", events: ["uploaded " + d.name + " to '" + (input.name || "slot") + "'"] }); }
      else sel.outerHTML = '<span class="bad">failed</span>';
    }));
  };
  renderDocs();
  new MutationObserver(() => { clearTimeout(window.__bpDocT); window.__bpDocT = setTimeout(renderDocs, 800); }).observe(document.body, { childList: true, subtree: true });

  // ---- fill the current page from the lender map ----
  // Joe 2026-10-06: "hit export and everything goes in" -- fill automatically once
  // the lender's application page is recognized (once per page; never submits).
  const autoFilled = new Set();
  const tryAutoFill = () => {
    const ready = map.pages.filter((p) => { try { return p.match(); } catch (_) { return false; } });
    const key = location.pathname + "|" + ready.map((p) => p.name).join(",");
    if (!ready.length || autoFilled.has(key)) return;
    autoFilled.add(key);
    $("res").textContent = "Application page found — filling it in…";
    setTimeout(() => $("fill").click(), 1200);
  };
  $("fill").onclick = async () => {
    const pages = map.pages.filter((p) => { try { return p.match(); } catch (_) { return false; } });
    if (!pages.length) { $("res").innerHTML = '<span class="bad">This page isn\'t mapped for ' + esc(exp.lenderLabel) + ' yet.</span> Use the copy list and document buttons below.'; return; }
    $("res").textContent = "Filling…";
    const all = { filled: [], missing: [], skipped: [], uploaded: [], uploadMissing: [] };
    for (const p of pages) { const r = await window.BPFill.runPage(p, pkg, fetchDoc); Object.keys(all).forEach((k) => all[k].push(...r[k])); }
    $("res").innerHTML = `<span class="ok">Filled ${all.filled.length} field(s)</span>${all.uploaded.length ? `, <span class="ok">uploaded ${all.uploaded.length}</span>` : ""}.` +
      (all.missing.length ? `<br><span class="bad">Couldn't find: ${esc(all.missing.join(", "))}</span>` : "") +
      (all.uploadMissing.length ? `<br><span class="bad">No document for: ${esc(all.uploadMissing.join(", "))}</span>` : "") +
      (all.skipped.length ? `<br>Not on the file: ${esc(all.skipped.join(", "))}` : "") + "<br>Review the page, then continue on the lender's site.";
    send({ kind: "log", events: ["filled " + all.filled.length + " fields on " + pages.map((p) => p.name).join(", "), ...all.uploaded.map((u) => "uploaded " + u), ...(all.missing.length ? ["missing fields: " + all.missing.join(", ")] : [])] });
  };
  tryAutoFill();
  // Single-page portals change screens without reloading -- keep watching (e.g. after login).
  new MutationObserver(() => { clearTimeout(window.__bpAutoT); window.__bpAutoT = setTimeout(tryAutoFill, 1000); }).observe(document.body, { childList: true, subtree: true });
})();
