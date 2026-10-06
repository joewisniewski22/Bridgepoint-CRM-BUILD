/* Attribution: remember which post, ad or link brought a visitor, across pages, so a lead is tied to the real source. */
(function(){
  try {
    var KEYS = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term"], p = new URLSearchParams(location.search), cur = {}, any = false, s = null;
    KEYS.forEach(function(k){ var v = p.get(k); if (v){ cur[k] = String(v).slice(0, 80); any = true; } });
    try { s = JSON.parse(localStorage.getItem("bp_attr") || "null"); } catch (e) { s = null; }
    var ref = ""; try { ref = document.referrer && document.referrer.indexOf(location.host) === -1 ? document.referrer.slice(0, 160) : ""; } catch (e) {}
    if (any){
      if (!s) s = { first: cur, firstAt: Date.now(), landing: location.pathname };
      s.last = cur; s.lastAt = Date.now(); s.landing = s.landing || location.pathname; if (ref) s.ref = ref;
      localStorage.setItem("bp_attr", JSON.stringify(s));
    } else if (!s && ref){
      localStorage.setItem("bp_attr", JSON.stringify({ first: {}, last: {}, firstAt: Date.now(), lastAt: Date.now(), landing: location.pathname, ref: ref }));
    }
  } catch (e) {}
  window.bpAttr = function(){
    var out = {}, s = null;
    try { s = JSON.parse(localStorage.getItem("bp_attr") || "null"); } catch (e) {}
    if (!s) return out;
    var src = (s.last && Object.keys(s.last).length) ? s.last : (s.first || {});
    Object.keys(src).forEach(function(k){ out[k] = src[k]; });
    if (s.landing) out.landing = s.landing;
    if (s.ref) out.referrer = s.ref;
    return out;
  };
})();

/* Small site behaviours: mobile menu, DSCR + fix & flip calculators, thank-you tracking. No dependencies. */
(function(){
  "use strict";
  var btn = document.querySelector(".menu-btn"), nav = document.getElementById("site-nav");
  if (btn && nav) btn.addEventListener("click", function(){
    var open = nav.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  function num(id){ var el = document.getElementById(id); var v = el ? parseFloat(String(el.value).replace(/[^0-9.]/g, "")) : 0; return isFinite(v) ? v : 0; }
  function usd(n){ return (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US"); }
  function monthlyPmt(principal, ratePct, years){
    var r = ratePct / 100 / 12, n = years * 12;
    if (!principal) return 0;
    if (!r) return principal / n;
    return principal * r / (1 - Math.pow(1 + r, -n));
  }

  // DSCR calculator
  var dscr = document.getElementById("dscr-calc");
  if (dscr) {
    var runDscr = function(){
      var rent = num("c-rent"), price = num("c-price"), ltv = num("c-ltv"), rate = num("c-rate"), tax = num("c-tax"), ins = num("c-ins"), hoa = num("c-hoa");
      var io = document.getElementById("c-io").checked;
      var loan = price * ltv / 100;
      var pi = io ? loan * rate / 100 / 12 : monthlyPmt(loan, rate, 30);
      var pitia = pi + tax + ins + hoa;
      var ratio = pitia > 0 ? rent / pitia : 0;
      document.getElementById("r-ratio").textContent = pitia > 0 ? ratio.toFixed(2) + "x" : "\u2014";
      document.getElementById("r-loan").textContent = usd(loan);
      document.getElementById("r-pi").textContent = usd(pi);
      document.getElementById("r-pitia").textContent = usd(pitia);
      document.getElementById("r-cash").textContent = usd(rent - pitia);
      var v = document.getElementById("r-verdict");
      v.textContent = !pitia ? "Enter the numbers to see your ratio." : ratio >= 1.25 ? "Strong \u2014 this ratio is comfortable for most DSCR programs." : ratio >= 1.0 ? "Qualifies on many DSCR programs. Some lenders prefer a bit more cushion." : ratio >= 0.75 ? "Below 1.0 \u2014 some programs allow it, usually with a lower loan-to-value or higher rate." : "Rent does not cover the payment \u2014 a loan officer can show options (lower leverage, interest-only, or a different structure).";
    };
    dscr.addEventListener("input", runDscr); runDscr();
  }

  // Fix & flip profit calculator
  var flip = document.getElementById("flip-calc");
  if (flip) {
    var runFlip = function(){
      var buy = num("f-buy"), rehab = num("f-rehab"), arv = num("f-arv"), months = num("f-months") || 1, rate = num("f-rate"), points = num("f-points"), hold = num("f-hold"), sellPct = num("f-sell"), other = num("f-other");
      var loan = buy + rehab; // assumes financing the full purchase + rehab for a simple worst-case view
      var interest = loan * rate / 100 / 12 * months;
      var fees = loan * points / 100;
      var holdTotal = hold * months;
      var selling = arv * sellPct / 100;
      var cost = buy + rehab + interest + fees + holdTotal + selling + other;
      var profit = arv - cost;
      var invested = interest + fees + holdTotal + other;
      document.getElementById("fr-profit").textContent = usd(profit);
      document.getElementById("fr-cost").textContent = usd(cost);
      document.getElementById("fr-int").textContent = usd(interest + fees);
      document.getElementById("fr-hold").textContent = usd(holdTotal);
      document.getElementById("fr-sell").textContent = usd(selling);
      document.getElementById("fr-70").textContent = usd(arv * 0.7 - rehab);
      var v = document.getElementById("fr-verdict");
      v.textContent = !arv ? "Enter the numbers to see your estimated profit." : (profit / Math.max(arv, 1) >= 0.1) ? "Healthy margin \u2014 over 10% of the resale price." : profit > 0 ? "Thin margin \u2014 small surprises could erase it." : "This deal loses money at these numbers.";
    };
    flip.addEventListener("input", runFlip); runFlip();
  }

  // Thank-you page: fire conversion hooks once.
  if (document.getElementById("thanks")) {
    if (window.fbq) window.fbq("track", "Lead");
    if (window.gtag) window.gtag("event", "conversion_thank_you");
  }
  // Live proof sections: recently funded loans and customer reviews. Both render only when there is approved data,
  // so nothing appears (and nothing is faked) until Joe approves real posts/reviews in the CRM.
  (function(){
    var prod = !(window.BP_BASE);
    if (!prod) return; // preview under /site has no API routes
    function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
    var recent = document.getElementById("recent");
    fetch("/api/funded?format=json&limit=3").then(function(r){ return r.ok ? r.json() : []; }).then(function(rows){
      if (!rows || !rows.length) return;
      if (recent) {
        var g = recent.querySelector(".fd-grid");
        g.innerHTML = rows.map(function(d){
          var loc = [d.city, d.state].filter(Boolean).join(", ");
          return '<a class="fd-card" href="/funded/' + esc(d.slug) + '/">' + (d.imageUrl ? '<img class="fd-img" loading="lazy" alt="Funded property in ' + esc(loc) + '" src="' + esc(d.imageUrl) + '">' : '') +
            '<div class="fd-body"><div class="cat">' + esc(d.loanType || "Loan") + '</div><h3>' + esc(d.headline || (d.loanType + " loan in " + loc)) + '</h3><p>' + esc(loc) + (d.propertyType ? " \u00b7 " + esc(d.propertyType) : "") + '</p>' + (d.loanAmount ? '<span class="fd-amt">$' + Math.round(d.loanAmount).toLocaleString("en-US") + '</span>' : '') + '</div></a>';
        }).join("");
        recent.hidden = false;
      }
      var col = document.querySelector(".ft .cols > div:last-child ul");
      if (col) { var li = document.createElement("li"); li.innerHTML = '<a href="/funded/">Recently Funded</a>'; col.insertBefore(li, col.children[2] || null); }
    }).catch(function(){});
    var rv = document.getElementById("reviews");
    if (rv) {
      fetch("https://idzkigmvovehjpapatxv.supabase.co/rest/v1/site_reviews?select=author,rating,body,source,source_url,loan_type,city,state&status=eq.approved&order=created_at.desc&limit=6", { headers: { apikey: "sb_publishable_zn3PaFZPVrsUq0LEWxbDJg_k1TUlzVd" } })
        .then(function(r){ return r.ok ? r.json() : []; }).then(function(rows){
          if (!rows || !rows.length) return;
          rv.querySelector(".rv-grid").innerHTML = rows.map(function(x){
            var stars = ""; for (var i = 0; i < 5; i++) stars += i < x.rating ? "\u2605" : "\u2606";
            var loc = [x.city, x.state].filter(Boolean).join(", ");
            return '<div class="rv"><div class="stars" aria-label="' + x.rating + ' out of 5 stars">' + stars + '</div><p>\u201c' + esc(x.body) + '\u201d</p><div class="who">' + esc(x.author) + (loc ? " \u00b7 " + esc(loc) : "") + (x.source ? " \u00b7 via " + esc(x.source) : "") + '</div></div>';
          }).join("");
          rv.hidden = false;
        }).catch(function(){});
    }
  })();

})();
