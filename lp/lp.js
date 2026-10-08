/* Quiz form for the Bridgepoint ad landing pages. One script, two programs
   (data-program="dscr" | "fixflip" on #quiz). Posts to the ad-lead-intake
   edge function. No tracking is loaded unless META_PIXEL_ID is filled in. */
(function(){
  "use strict";
  var ENDPOINT = "https://idzkigmvovehjpapatxv.supabase.co/functions/v1/ad-lead-intake";
  var BOOK_URL = "https://app.bplending.com/?book=owner";
  var META_PIXEL_ID = "828172673668690"; // paste the Meta Pixel ID here to turn on pixel tracking + the Lead event

  if (META_PIXEL_ID){
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", META_PIXEL_ID); window.fbq("track", "PageView");
  }

  var root = document.getElementById("quiz");
  if (!root) return;
  var program = root.getAttribute("data-program") === "fixflip" ? "fixflip" : "dscr";
  var steps = Array.prototype.slice.call(root.querySelectorAll(".step"));
  var bar = root.querySelector(".bar i");
  var stepno = root.querySelector(".stepno");
  var msg = root.querySelector(".msg");
  var data = {};
  var idx = 0;

  var params = new URLSearchParams(location.search);
  ["utm_source","utm_medium","utm_campaign","utm_content","utm_term"].forEach(function(k){ if (params.get(k)) data[k] = params.get(k); });

  // Funnel tracking (2026-10-08): which step each visitor reaches, so a form that
  // loses people can't hide. Step 1-4 = quiz steps shown, 5 = pressed "Get my quote".
  // Sends no personal info. Never blocks the form.
  var session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var pinged = {};
  function ping(step){
    if (pinged[step]) return; pinged[step] = true;
    try {
      fetch(ENDPOINT, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ping: true, step: step, program: program, session: session, utm_campaign: data.utm_campaign || "", utm_content: data.utm_content || "" }) }).catch(function(){});
    } catch (e) {}
  }

  function show(i){
    ping(i + 1);
    idx = i;
    steps.forEach(function(s, n){ s.classList.toggle("on", n === i); });
    var pct = Math.round(((i) / (steps.length)) * 100);
    bar.style.width = (pct + 8) + "%";
    stepno.textContent = "Step " + (i + 1) + " of " + steps.length;
    msg.textContent = "";
    var first = steps[i].querySelector(".in input, .in select");
    if (first && i > 0 && window.matchMedia("(min-width:860px)").matches) first.focus();
  }

  root.addEventListener("click", function(e){
    var c = e.target.closest(".choice");
    if (c){
      var group = c.closest(".choices");
      Array.prototype.forEach.call(group.querySelectorAll(".choice"), function(x){ x.classList.remove("sel"); x.setAttribute("aria-pressed", "false"); });
      c.classList.add("sel"); c.setAttribute("aria-pressed", "true");
      data[group.getAttribute("data-key")] = c.getAttribute("data-val");
      // Single-question choice steps advance on tap.
      if (group.hasAttribute("data-auto") && idx < steps.length - 1) setTimeout(function(){ show(idx + 1); }, 160);
      return;
    }
    if (e.target.closest("[data-next]")) { if (valid(idx)) show(idx + 1); return; }
    if (e.target.closest("[data-back]")) { if (idx > 0) show(idx - 1); }
  });

  function numVal(name){ var el = root.querySelector('[name="' + name + '"]'); return el ? el.value.replace(/[^0-9.]/g, "") : ""; }

  function valid(i){
    var step = steps[i], need = step.getAttribute("data-need");
    msg.textContent = "";
    if (need){
      var keys = need.split(",");
      for (var k = 0; k < keys.length; k++){
        if (!data[keys[k]]){ msg.textContent = "Please pick one to continue."; return false; }
      }
    }
    var req = step.getAttribute("data-req");
    if (req){
      var names = req.split(",");
      for (var n = 0; n < names.length; n++){
        if (!numVal(names[n])){ msg.textContent = "Please fill in each number — a rough estimate is fine."; return false; }
        data[names[n]] = numVal(names[n]);
      }
    }
    return true;
  }

  var form = root.querySelector("form");
  form.addEventListener("submit", function(e){
    e.preventDefault();
    ping(5);
    if (!valid(idx)) return;
    var name = form.elements.name.value.trim(), phone = form.elements.phone.value.trim(), email = form.elements.email.value.trim();
    var digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (name.length < 2){ msg.textContent = "Please enter your name."; return; }
    if (digits.length !== 10){ msg.textContent = "Please enter a 10-digit mobile number."; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ msg.textContent = "Please enter a valid email."; return; }
    if (!form.elements.consent.checked){ msg.textContent = "Please check the box so we can contact you about your request."; return; }
    var btn = form.querySelector("[type=submit]");
    btn.disabled = true; btn.textContent = "Sending…";
    var body = Object.assign({}, data, {
      program: program, name: name, phone: phone, email: email, consent: true, session: session,
      // Hidden anti-spam field (renamed bp_hp 10/8 so phone AutoFill leaves it alone; old name still read for cached pages).
      website: ((form.elements.bp_hp || form.elements.website || {}).value) || "",
      timeline: form.elements.timeline.value
    });
    fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok || !res.j.ok){ throw new Error((res.j && res.j.detail) || "Something went wrong."); }
        if (window.fbq) window.fbq("track", "Lead");
        var first = name.split(/\s+/)[0];
        root.innerHTML = '<div class="done"><h2>Thanks, ' + first.replace(/[<>&"]/g, "") + ' — you\'re in.</h2>' +
          '<p>A loan officer is reviewing your answers now and will text you shortly. Want to skip the wait?</p>' +
          '<a class="btn gold" href="' + BOOK_URL + '">Pick a time to talk</a></div>';
      })
      .catch(function(err){
        btn.disabled = false; btn.textContent = "Get my quote";
        msg.textContent = err.message || "We couldn't send that — please try again.";
      });
  });

  show(0);
})();
