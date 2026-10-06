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

  // Run one page map. Returns { filled:[], missing:[], uploaded:[], uploadMissing:[] }.
  async function runPage(page, pkg, fetchDoc) {
    const res = { filled: [], missing: [], skipped: [], uploaded: [], uploadMissing: [] };
    for (const f of page.fields || []) {
      let v = typeof f.value === "function" ? f.value(pkg) : pick(pkg, f.value);
      if (f.fmt && FMT[f.fmt]) v = FMT[f.fmt](v);
      if (v == null || v === "") { res.skipped.push(f.label || f.selector); continue; }
      const ok = f.radio ? pickRadio(f, v) : (() => { const el = findField(f); return el ? setValue(el, v) : false; })();
      (ok ? res.filled : res.missing).push(f.label || f.selector);
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
