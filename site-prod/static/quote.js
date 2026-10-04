/* BridgePoint quote + ballpark estimator widget.
   One widget, used on the home page, every loan page, /get-quote/ and /estimate/.
   Flow: what do you need -> goal -> property -> the numbers -> ESTIMATE (a conservative range, never an exact
   quote) -> contact -> lead lands in the CRM (ad-lead-intake) and the loan officer + AI follow up in minutes. */
(function(){
  "use strict";
  var API = "https://idzkigmvovehjpapatxv.supabase.co/functions/v1/";
  var BASE = window.BP_BASE || "";
  var PROGRAMS = [
    ["fixflip", "Fix & flip loan", "Purchase plus rehab funding"],
    ["dscr", "DSCR rental loan", "Qualify on the rent, not your tax returns"],
    ["bridge", "Bridge loan", "Fast short-term financing"],
    ["ground", "Ground-up construction", "Build from the ground up"],
    ["portfolio", "Portfolio / blanket loan", "Several properties, one loan"]
  ];
  var TYPES = [["SFR","Single-family"],["Duplex","Duplex"],["2-4 Unit","3–4 units"],["Multifamily 5+","5+ units"],["Condo","Condo"],["Mixed-Use","Mixed-use"]];
  var CREDIT = ["760+","720-759","680-719","640-679","Under 640"];
  var EXPERIENCE = [["First deal","First deal"],["1-2 deals","1–2"],["3-5 deals","3–5"],["6+ deals","6+"]];
  // States we do not lend in (Joe, 2026-10-04): NV, ND, SD (license-required). Remove more here as he confirms them.
  var STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NH NJ NM NY NC OH OK PA RI SC TN TX VA WA WV WI WY".split(" ");

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]; }); }
  function usd(n){ return "$" + Math.round(n).toLocaleString("en-US"); }
  function numFrom(v){ return String(v || "").replace(/[^0-9.]/g, ""); }
  function pct(r){ return (Math.round(r * 1000) / 1000).toString().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%"; }

  document.querySelectorAll("[data-qw]").forEach(function(root){ init(root); });

  function init(root){
    var fixed = root.getAttribute("data-program");
    var S = { state: root.getAttribute("data-state") || null, program: (fixed && fixed !== "auto") ? fixed : null, step: 0, goal: null, propertyType: null, credit: null, experience: null, estimate: null, estimateNote: "", timeline: "ASAP (under 30 days)" };
    var title = root.getAttribute("data-title") || "Get your estimate";
    var sub = root.getAttribute("data-sub") || "Takes about a minute. See a ballpark, then get exact numbers from a loan officer.";
    var params = new URLSearchParams(location.search);
    var utm = {};
    ["utm_source","utm_medium","utm_campaign","utm_content","utm_term"].forEach(function(k){ if (params.get(k)) utm[k] = params.get(k); });
    if (!utm.utm_content) utm.utm_content = location.pathname.replace(/\/+$/, "") || "/";

    function steps(){
      var p = S.program, list = [];
      if (!p) list.push("program");
      list.push("goal", "type", "deal");
      if (p !== "portfolio") list.push("estimate");
      list.push("contact");
      return list;
    }

    function goalChoices(){
      if (S.program === "dscr" || S.program === "portfolio") return [["purchase","Buy a rental property"],["refi","Refinance a property I own"],["cashout","Cash-out refinance"]];
      return [["purchase","Buy a property"],["refi","Refinance a property I own"]];
    }

    function render(){
      var list = steps();
      if (S.step >= list.length) S.step = list.length - 1;
      var cur = list[S.step];
      var pctDone = Math.round((S.step / list.length) * 100) + 8;
      var html = '<h2>' + esc(title) + '</h2><p class="sub">' + esc(sub) + '</p>' +
        '<div class="bar" aria-hidden="true"><i style="width:' + pctDone + '%"></i></div><div class="stepno" aria-live="polite">Step ' + (S.step + 1) + ' of ' + list.length + '</div>';
      html += '<div class="st on">' + stepHTML(cur) + '</div><div class="msg" role="alert"></div>';
      root.innerHTML = html;
      afterRender(cur);
    }

    function stepHTML(cur){
      if (cur === "program") {
        return '<p class="q">What kind of loan do you need?</p><div class="choices">' + PROGRAMS.map(function(x){
          return '<button type="button" class="choice" data-act="program" data-v="' + x[0] + '"><b>' + esc(x[1]) + '</b><br><span style="font-weight:400;font-size:14px;color:var(--muted)">' + esc(x[2]) + '</span></button>';
        }).join("") + '</div>';
      }
      if (cur === "goal") {
        return '<p class="q">What are you looking to do?</p><div class="choices">' + goalChoices().map(function(x){
          return '<button type="button" class="choice' + (S.goal === x[0] ? ' sel' : '') + '" data-act="goal" data-v="' + x[0] + '">' + esc(x[1]) + '</button>';
        }).join("") + '</div>' + backBtn();
      }
      if (cur === "type") {
        return '<p class="q">What type of property?</p><div class="choices two">' + TYPES.map(function(x){
          return '<button type="button" class="choice' + (S.propertyType === x[0] ? ' sel' : '') + '" data-act="type" data-v="' + x[0] + '">' + esc(x[1]) + '</button>';
        }).join("") + '</div>' + backBtn();
      }
      if (cur === "deal") {
        var p = S.program, f = '';
        var valueLabel = S.goal === "purchase" ? "Purchase price" : "Current value";
        f += field("value", p === "ground" ? "Land / purchase price" : valueLabel, "350,000", true);
        if (p === "dscr" || p === "portfolio") f += field("rent", p === "portfolio" ? "Total monthly rent" : "Monthly rent", "2,800", true);
        if (p === "fixflip" || p === "ground") {
          f += field("rehab", p === "ground" ? "Construction budget" : "Rehab budget", "60,000", true);
          f += field("arv", p === "ground" ? "Value when finished" : "After-repair value", "450,000", true);
        }
        f += '<div><label class="f" for="qw-state">Property state</label><div class="in"><select id="qw-state" data-k="state"><option value="">Select…</option>' + STATES.map(function(s){ return '<option' + (S.state === s ? ' selected' : '') + '>' + s + '</option>'; }).join("") + '</select></div></div>';
        var extra = '';
        if (p !== "dscr" && p !== "portfolio") {
          extra += '<p class="q" style="margin-top:16px">Deals completed in the last 3 years</p><div class="choices two">' + EXPERIENCE.map(function(x){
            return '<button type="button" class="choice' + (S.experience === x[0] ? ' sel' : '') + '" data-act="exp" data-v="' + x[0] + '">' + esc(x[1]) + '</button>';
          }).join("") + '</div>';
        }
        extra += '<p class="q" style="margin-top:16px">Estimated credit score</p><div class="choices two">' + CREDIT.map(function(x){
          return '<button type="button" class="choice' + (S.credit === x ? ' sel' : '') + '" data-act="credit" data-v="' + x + '">' + esc(x) + '</button>';
        }).join("") + '</div>';
        return '<p class="q">The deal — rough numbers are fine</p><div class="fields two">' + f + '</div>' + extra +
          '<div class="nav2"><button type="button" class="btn ghostq" data-act="back">Back</button><button type="button" class="btn btn-navy" data-act="deal-next">' + (p === "portfolio" ? 'Continue' : 'See my estimate') + '</button></div>';
      }
      if (cur === "estimate") {
        var e = S.estimate;
        if (!e) return '<div class="est"><div class="lbl">Checking live rates…</div><p style="margin:10px 0 0;color:var(--muted)">This takes a few seconds.</p></div>';
        var body;
        if (e.eligible) {
          body = '<div class="lbl" style="margin-top:0">Estimated rate range</div><div class="big">' + pct(e.rateLow) + ' – ' + pct(e.rateHigh) + '</div>' +
            (e.maxLoan ? '<div class="lbl">You could qualify for up to about</div><div class="big">' + usd(e.maxLoan) + '</div>' : '') +
            '<small>This is an estimate to help you plan — not an offer, rate lock or commitment to lend. Your actual rate, loan amount and fees depend on the full file, underwriting and market conditions. A loan officer will confirm exact numbers.</small>';
        } else {
          body = '<div class="big" style="font-size:24px">Let’s take a closer look</div><p style="margin:10px 0 0;color:var(--muted)">' + esc(e.message || 'Your scenario needs a loan officer’s eyes. We can often find a structure that works — send us your info and we’ll tell you what’s possible.') + '</p>';
        }
        return '<div class="est">' + body + '</div><div class="nav2"><button type="button" class="btn ghostq" data-act="back">Back</button><button type="button" class="btn btn-gold" data-act="to-contact">Get my exact numbers</button></div>';
      }
      if (cur === "contact") {
        return '<form novalidate data-form><p class="q">Where should we send your exact numbers?</p><div class="fields">' +
          '<div><label class="f" for="qw-name">Full name</label><div class="in"><input id="qw-name" name="name" autocomplete="name"></div></div>' +
          '<div><label class="f" for="qw-phone">Mobile number</label><div class="in"><input id="qw-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel"></div></div>' +
          '<div><label class="f" for="qw-email">Email</label><div class="in"><input id="qw-email" name="email" type="email" autocomplete="email"></div></div>' +
          '<div><label class="f" for="qw-time">When do you need to close?</label><div class="in"><select id="qw-time" name="timeline"><option>ASAP (under 30 days)</option><option>30-60 days</option><option>60+ days</option><option>Just exploring</option></select></div></div>' +
          '<div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div></div>' +
          '<label class="consent"><input type="checkbox" name="consent"><span>I agree that BridgePoint Lending may call, text and email me about my loan request at the number and email above, including with automated technology and AI-assisted messages. Consent is not a condition of any loan. Msg &amp; data rates may apply. Reply STOP to opt out. See our <a href="' + BASE + '/privacy-policy/">Privacy Policy</a>.</span></label>' +
          '<div class="nav2"><button type="button" class="btn ghostq" data-act="back">Back</button><button type="submit" class="btn btn-gold">Send me my numbers</button></div></form>';
      }
      return "";
    }
    function backBtn(){ return S.step > 0 ? '<div class="nav2"><button type="button" class="btn ghostq" data-act="back">Back</button></div>' : ''; }
    function field(k, label, ph, money){
      var v = S[k] ? esc(S[k]) : "";
      return '<div><label class="f" for="qw-' + k + '">' + esc(label) + '</label><div class="in' + (money ? ' pre' : '') + '"><input id="qw-' + k + '" data-k="' + k + '" inputmode="numeric" autocomplete="off" placeholder="' + esc(ph) + '" value="' + v + '"></div></div>';
    }
    function afterRender(cur){
      if (cur === "estimate" && !S.estimate) runEstimate();
      if (cur === "contact") {
        var form = root.querySelector("form");
        form.addEventListener("submit", function(e){ e.preventDefault(); submit(form); });
      }
    }
    function msg(t){ var m = root.querySelector(".msg"); if (m) m.textContent = t || ""; }
    function next(){ S.step++; render(); try { root.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {} }

    function readInputs(){
      root.querySelectorAll("[data-k]").forEach(function(el){
        var k = el.getAttribute("data-k");
        S[k] = (k === "state") ? el.value : numFrom(el.value);
      });
    }

    root.addEventListener("input", function(e){ var k = e.target.getAttribute && e.target.getAttribute("data-k"); if (k) S[k] = (k === "state") ? e.target.value : numFrom(e.target.value); });
    root.addEventListener("click", function(e){
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var act = b.getAttribute("data-act"), v = b.getAttribute("data-v");
      if (act === "program") { S.program = v; S.goal = S.propertyType = S.credit = S.experience = null; S.estimate = null; S.step = 0; /* the program step drops out of the list once chosen, so step 0 is now "goal" */ render(); return; }
      if (act === "goal") { S.goal = v; next(); return; }
      if (act === "type") { S.propertyType = v; next(); return; }
      if (act === "exp") { S.experience = v; mark(b); return; }
      if (act === "credit") { S.credit = v; mark(b); return; }
      if (act === "back") { if (S.step > 0) { S.step--; if (steps()[S.step] === "estimate") S.step--; render(); } return; }
      if (act === "deal-next") { readInputs(); if (validateDeal()) { S.estimate = null; next(); } return; }
      if (act === "to-contact") { S.step = steps().indexOf("contact"); render(); return; }
    });
    function mark(b){ b.parentNode.querySelectorAll(".choice").forEach(function(c){ c.classList.remove("sel"); }); b.classList.add("sel"); }

    function validateDeal(){
      var p = S.program;
      if (!S.value) { msg("Please enter the price or value — a rough number is fine."); return false; }
      if ((p === "dscr" || p === "portfolio") && !S.rent) { msg("Please enter the monthly rent."); return false; }
      if ((p === "fixflip" || p === "ground") && (!S.rehab || !S.arv)) { msg("Please fill in the budget and finished value — rough is fine."); return false; }
      if (!S.state) { msg("Please pick the property’s state."); return false; }
      if (p !== "dscr" && p !== "portfolio" && !S.experience) { msg("Please pick how many deals you’ve done."); return false; }
      if (!S.credit) { msg("Please pick your estimated credit score."); return false; }
      msg(""); return true;
    }

    function runEstimate(){
      var payload = { program: S.program, state: S.state, goal: S.goal, propertyType: S.propertyType, value: S.value, rent: S.rent, rehab: S.rehab, arv: S.arv, credit: S.credit, experience: S.experience, website: "" };
      fetch(API + "public-estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          if (res.ok && res.j && res.j.ok && res.j.eligible) {
            S.estimate = res.j;
            S.estimateNote = pct(res.j.rateLow) + "-" + pct(res.j.rateHigh) + (res.j.maxLoan ? ", up to " + usd(res.j.maxLoan) : "");
          } else if (res.j && res.j.error === "rate_limited") {
            S.estimate = { eligible: false, message: res.j.detail };
          } else {
            S.estimate = { eligible: false };
            S.estimateNote = "needs a closer look";
          }
          if (steps()[S.step] === "estimate") render();
        }).catch(function(){ S.estimate = { eligible: false, message: "We couldn’t run that just now — leave your number and a loan officer will run it with you." }; if (steps()[S.step] === "estimate") render(); });
    }

    function submit(form){
      var name = form.elements.name.value.trim(), phone = form.elements.phone.value.trim(), email = form.elements.email.value.trim();
      var digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      if (name.length < 2) return msg("Please enter your name.");
      if (digits.length !== 10) return msg("Please enter a 10-digit mobile number.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return msg("Please enter a valid email.");
      if (!form.elements.consent.checked) return msg("Please check the box so we can contact you about your request.");
      var btn = form.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Sending…";
      var body = Object.assign({}, utm, { src: "site", program: S.program, name: name, phone: phone, email: email, consent: true, website: form.elements.website.value,
        timeline: form.elements.timeline.value, goal: S.goal, propertyType: S.propertyType, value: S.value, rent: S.rent, rehab: S.rehab, arv: S.arv,
        credit: S.credit, experience: S.experience, state: S.state, estimate: S.estimateNote || "" });
      fetch(API + "ad-lead-intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          if (!res.ok || !res.j.ok) throw new Error((res.j && res.j.detail) || "Something went wrong.");
          // The conversion event fires once, on the thank-you page (see site.js), so ads/analytics never double count.
          location.href = BASE + "/thank-you/?p=" + encodeURIComponent(S.program);
        })
        .catch(function(err){ btn.disabled = false; btn.textContent = "Send me my numbers"; msg(err.message || "We couldn’t send that — please try again or call us."); });
    }

    render();
  }
})();
