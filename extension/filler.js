// Bridgepoint Lender Export -- form-filling engine (used by panel.js with the
// per-lender maps in maps.js). Fills what it can find, reports what it
// couldn't, and NEVER clicks a lender's submit/sign/lock button.
(function () {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // Read a value from the package by dotted path ("borrower.guarantor.firstName").
  function pick(pkg, path) {
    return String(path || "").split(".").reduce((o, k) => (o == null ? o : o[k]), pkg);
  }

  // Formatting the lender's form expects.
  const FMT = {
    money: (v) => (v == null || v === "" ? "" : String(Math.round(Number(v)))),
    pct: (v) => (v == null || v === "" ? "" : String(Number(v))),
    int: (v) => (v == null || v === "" ? "" : String(parseInt(v, 10))),
    mdy: (v) => { if (!v) return ""; const [y, m, d] = String(v).slice(0, 10).split("-"); return m && d ? m + "/" + d + "/" + y : String(v); },
    ymd: (v) => (v ? String(v).slice(0, 10) : ""),
    upper: (v) => String(v || "").toUpperCase(),
  };

  // Find a form control: by CSS selector, or by visible label / aria-label / placeholder / name text.
  function findField(spec, root) {
    root = root || document;
    if (spec.selector) { const el = root.querySelector(spec.selector); if (el) return el; }
    const want = norm(spec.label);
    if (!want) return null;
    const controls = Array.from(root.querySelectorAll("input:not([type=hidden]):not([type=file]), select, textarea")).filter((el) => el.offsetParent !== null);
    for (const el of controls) {
      const texts = [];
      if (el.id) { const lab = root.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lab) texts.push(lab.innerText); }
      const wrapLab = el.closest("label"); if (wrapLab) texts.push(wrapLab.innerText);
      texts.push(el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"));
      const lb = el.getAttribute("aria-labelledby"); if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) texts.push(n.innerText); });
      // Label in the same row/cell (common in table-style forms).
      const row = el.closest("tr, .form-group, .field, .row, div"); if (row) { const l = row.querySelector("label, td, th, span"); if (l && l !== el) texts.push(l.innerText); }
      if (texts.some((t) => norm(t) === want) || (spec.contains && texts.some((t) => norm(t).includes(want)))) return el;
    }
    return null;
  }

  // Set a value the way a person typing would, so React/Angular/jQuery forms register it.
  function setValue(el, value) {
    if (el.tagName === "SELECT") {
      const want = norm(value);
      const opt = Array.from(el.options).find((o) => norm(o.text) === want || norm(o.value) === want) || Array.from(el.options).find((o) => norm(o.text).includes(want) && want);
      if (!opt) return false;
      el.value = opt.value;
    } else if (el.type === "checkbox" || el.type === "radio") {
      const on = value === true || /^(yes|true|1|on)$/i.test(String(value));
      if (el.checked !== on) el.click();
      return true;
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    }
    ["input", "change", "blur"].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
    if (window.jQuery) { try { window.jQuery(el).trigger("change"); } catch (_) {} }
    return true;
  }

  // Choose a radio button by its label text within a group.
  function pickRadio(spec, value) {
    const want = norm(value);
    const radios = Array.from(document.querySelectorAll(spec.selector || 'input[type="radio"]'));
    for (const r of radios) {
      const lab = (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) || r.closest("label");
      if (lab && norm(lab.innerText) === want) { r.click(); return true; }
    }
    return false;
  }

  async function uploadToInput(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Find a file input for an upload slot: selector, or the input nearest a matching label/heading.
  function findUpload(slot) {
    if (slot.selector) return document.querySelector(slot.selector);
    const want = norm(slot.label);
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const inp of inputs) {
      let n = inp;
      for (let i = 0; i < 6 && n; i++) { n = n.parentElement; if (n && norm(n.innerText).includes(want)) return inp; }
    }
    return null;
  }

  // Never press anything that could submit, sign, lock, or send on the lender's side.
  const FORBIDDEN = /submit|sign|lock|send|email|confirm|finish|complete|delete|remove|clear/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pick a radio by its value: { radioName: "loanProgram" } or { radioPrefix: "currentOccupancy_" }.
  function pickRadioByValue(f, v) {
    const sel = f.radioName ? 'input[type="radio"][name="' + f.radioName + '"]' : 'input[type="radio"][name^="' + f.radioPrefix + '"]';
    const r = Array.from(document.querySelectorAll(sel)).find((x) => x.value === String(v));
    if (!r) return false;
    if (!r.checked) r.click();
    return true;
  }

  // Run one page map. Returns { filled:[], missing:[], uploaded:[], uploadMissing:[] }.
  // Field entries run in order; besides fields they can be
  //   { click: "css", index?: n, when?: (pkg)=>bool }  -- reveal-only UI buttons (e.g. "Can't find address")
  //   { wait: ms }                                      -- let the lender's page react
  async function runPage(page, pkg, fetchDoc) {
    const res = { filled: [], missing: [], skipped: [], uploaded: [], uploadMissing: [] };
    for (const f of page.fields || []) {
      if (f.when && !f.when(pkg)) continue;
      if (f.wait) { await sleep(f.wait); continue; }
      if (f.click) {
        const b = document.querySelectorAll(f.click)[f.index || 0];
        if (b && !FORBIDDEN.test((b.innerText || b.value || "").replace(/can't find address/i, ""))) { b.click(); await sleep(250); }
        continue;
      }
      let v = typeof f.value === "function" ? f.value(pkg) : pick(pkg, f.value);
      if (f.fmt && FMT[f.fmt]) v = FMT[f.fmt](v);
      const name = f.label || f.name || f.selector || f.radioName || f.radioPrefix;
      if (v == null || v === "") { res.skipped.push(name); continue; }
      let ok;
      if (f.radioName || f.radioPrefix) { ok = pickRadioByValue(f, v); if (ok) await sleep(200); }
      else if (f.radio) ok = pickRadio(f, v);
      else {
        const el = f.selector ? document.querySelectorAll(f.selector)[f.index || 0] : findField(f);
        ok = el ? setValue(el, v) : false;
      }
      (ok ? res.filled : res.missing).push(name);
    }
    for (const u of page.uploads || []) {
      const docs = (pkg.documents || []).filter((d) => (u.categories || [u.category]).includes(d.category));
      if (!docs.length) { res.uploadMissing.push(u.label || u.category); continue; }
      const input = findUpload(u.slot || {});
      if (!input) { res.uploadMissing.push((u.label || u.category) + " (slot not found)"); continue; }
      const files = [];
      for (const d of docs) { const f = await fetchDoc(d); if (f) files.push(f); if (!input.multiple) break; }
      if (files.length) { await uploadToInput(input, files); res.uploaded.push((u.label || u.category) + " (" + files.length + ")"); }
    }
    return res;
  }

  window.BPFill = { pick, FMT, findField, setValue, pickRadio, findUpload, uploadToInput, runPage, norm };
})();
