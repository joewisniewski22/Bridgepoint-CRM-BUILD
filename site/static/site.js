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
      document.getElementById("r-ratio").textContent = pitia > 0 ? ratio.toFixed(2) + "x" : "—";
      document.getElementById("r-loan").textContent = usd(loan);
      document.getElementById("r-pi").textContent = usd(pi);
      document.getElementById("r-pitia").textContent = usd(pitia);
      document.getElementById("r-cash").textContent = usd(rent - pitia);
      var v = document.getElementById("r-verdict");
      v.textContent = !pitia ? "Enter the numbers to see your ratio." : ratio >= 1.25 ? "Strong — this ratio is comfortable for most DSCR programs." : ratio >= 1.0 ? "Qualifies on many DSCR programs. Some lenders prefer a bit more cushion." : ratio >= 0.75 ? "Below 1.0 — some programs allow it, usually with a lower loan-to-value or higher rate." : "Rent does not cover the payment — a loan officer can show options (lower leverage, interest-only, or a different structure).";
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
      v.textContent = !arv ? "Enter the numbers to see your estimated profit." : (profit / Math.max(arv, 1) >= 0.1) ? "Healthy margin — over 10% of the resale price." : profit > 0 ? "Thin margin — small surprises could erase it." : "This deal loses money at these numbers.";
    };
    flip.addEventListener("input", runFlip); runFlip();
  }

  // Thank-you page: fire conversion hooks once.
  if (document.getElementById("thanks")) {
    if (window.fbq) window.fbq("track", "Lead");
    if (window.gtag) window.gtag("event", "conversion_thank_you");
  }
})();
