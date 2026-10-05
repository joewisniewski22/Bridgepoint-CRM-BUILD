/* BridgePoint Deal Analyzer: four deal types, financed vs. all-cash math, stress tests and a downloadable PDF.
   Every number is computed in the browser from the visitor's own inputs. Financing assumptions are editable; the
   interest rate is prefilled from our live ballpark estimator (public-estimate) so the analysis uses real market
   ballparks, not made-up ones. Illustration only -- not an offer, rate lock or commitment to lend. */
(function(){
  "use strict";
  var BASE = window.BP_BASE || "";
  var API = "https://idzkigmvovehjpapatxv.supabase.co/functions/v1/";
  var STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NH NJ NM NY NC OH OK PA RI SC TN TX VA WA WV WI WY".split(" ");
  var CREDIT = ["760+","720-759","680-719","640-679","Under 640"];
  var EXPERIENCE = [["First deal","First deal"],["1-2 deals","1–2 deals"],["3-5 deals","3–5 deals"],["6+ deals","6+ deals"]];

  /* ---------- helpers ---------- */
  function usd(n, signed){
    if (n === null || n === undefined || !isFinite(n)) return "—";
    var s = "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
    return n < 0 ? "-" + s : (signed && n > 0 ? "+" + s : s);
  }
  function pct(n, d){ return (n === null || n === undefined || !isFinite(n)) ? "—" : (n * 100).toFixed(d === undefined ? 1 : d) + "%"; }
  function mult(n){ return (!isFinite(n) || n <= 0) ? "—" : n.toFixed(1) + "x"; }
  function pmt(loan, ratePct, months){
    var r = ratePct / 100 / 12;
    if (!loan || loan <= 0) return 0;
    if (!r) return loan / months;
    return loan * r / (1 - Math.pow(1 + r, -months));
  }
  function balance(loan, ratePct, months, paid){
    var r = ratePct / 100 / 12, p = pmt(loan, ratePct, months);
    if (!r) return Math.max(0, loan - p * paid);
    return Math.max(0, loan * Math.pow(1 + r, paid) - p * (Math.pow(1 + r, paid) - 1) / r);
  }
  function annualize(roi, months){ return roi > -1 ? Math.pow(1 + roi, 12 / Math.max(months, 1)) - 1 : -1; }
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }

  /* ---------- pro data helpers: rehab estimate + comps-based value check ---------- */
  // Base rehab cost per square foot, in January-2025 national-average dollars (typical investor rehab ranges).
  var SCOPES = {
    cosmetic: { label: "Cosmetic refresh", lo: 18, hi: 30, desc: "paint, flooring, fixtures and a light kitchen and bath refresh" },
    moderate: { label: "Moderate rehab", lo: 35, hi: 55, desc: "kitchen and bath remodels, flooring, paint, doors and trim, some repairs" },
    heavy: { label: "Heavy rehab", lo: 55, hi: 85, desc: "full kitchen and baths plus roof, HVAC, electrical or plumbing updates and windows" },
    gut: { label: "Full gut rehab", lo: 85, hi: 130, desc: "down to the studs: structural work, all systems and a full interior" }
  };
  // Approximate regional cost adjustment versus the national average (1.00).
  var STATE_FACTOR = {AK:1.30,AL:0.86,AR:0.84,AZ:0.96,CA:1.25,CO:1.08,CT:1.17,DC:1.12,DE:1.04,FL:0.95,GA:0.92,HI:1.45,IA:0.93,ID:0.96,IL:1.08,IN:0.92,KS:0.90,KY:0.89,LA:0.90,MA:1.20,MD:1.03,ME:1.00,MI:0.98,MN:1.06,MO:0.96,MS:0.84,MT:0.98,NC:0.90,NE:0.91,NH:1.03,NJ:1.17,NM:0.93,NY:1.22,OH:0.95,OK:0.86,PA:1.03,RI:1.10,SC:0.88,TN:0.90,TX:0.90,VA:0.95,WA:1.10,WI:0.98,WV:0.90,WY:0.94};
  var MATERIALS_SHARE = 0.45; // materials are roughly 45% of a rehab budget; labor is the rest
  function rehabEstimate(scope, sqft, state, idx){
    var s = SCOPES[scope];
    if (!s || !sqft) return null;
    var sf = STATE_FACTOR[state] || 1, ratio = (idx && idx.ratio) ? idx.ratio : 1, adj = 1 + (ratio - 1) * MATERIALS_SHARE;
    var lo = sqft * s.lo * sf * adj, hi = sqft * s.hi * sf * adj;
    return { lo: lo, hi: hi, mid: (lo + hi) / 2, scope: scope, label: s.label, desc: s.desc, sqft: sqft, state: state, sf: sf, adj: adj, hasIndex: !!(idx && idx.ratio), yoy: idx && idx.yoy, asOf: idx && idx.asOf };
  }
  function rehabLine(e){
    if (!e) return "";
    return e.label + " on " + Number(e.sqft).toLocaleString("en-US") + " sq ft: " + usd(e.lo) + " to " + usd(e.hi) + " (midpoint " + usd(e.mid) + "). Based on typical investor rehab costs of " + usd(SCOPES[e.scope].lo) + " to " + usd(SCOPES[e.scope].hi) + " per sq ft (2025 national average), adjusted " + (e.sf === 1 ? "" : "by " + e.sf.toFixed(2) + "x for " + e.state + " and ") + (e.hasIndex ? "by " + ((e.adj - 1) * 100).toFixed(1) + "% for materials price changes (U.S. Bureau of Labor Statistics construction-input index, " + (e.yoy != null ? (e.yoy * 100).toFixed(1) + "% up over 12 months" : "latest data") + "). " : "") + "An estimate to plan with, not a contractor bid.";
  }
  function applyPro(R, type, i, f, ctx){
    var p = ctx.pro, cs = p.compStats || {}, ve = p.valueEstimate || null, re = p.rentEstimate || null, s = p.subject || {}, verdict = null, extra = [];
    R.pro = { subject: s, valueEstimate: ve, rentEstimate: re, soldComps: p.soldComps || [], compStats: cs, market: p.market || null, warnings: p.warnings || [], rehab: ctx.rehab || null, verdict: null };
    if (type === "flip" || type === "bridge" || type === "build"){
      if (cs.count >= 3 && cs.arvMid){
        var alt = {}, k, atMid;
        for (k in i) alt[k] = i[k];
        alt.arv = cs.arvMid;
        atMid = type === "build" ? calcBuild(alt, f) : calcFlip(alt, f);
        if (i.arv > cs.arvHigh){
          verdict = { tone: "warn", text: "Your value of " + usd(i.arv) + " is above what nearby closed sales support (" + usd(cs.arvLow) + " to " + usd(cs.arvHigh) + "). At the median of " + usd(cs.arvMid) + " the profit would be " + usd(atMid.profit) + " (" + pct(atMid.roi, 0) + " on your cash). Make sure your comps justify the higher number." };
        } else if (i.arv < cs.arvLow){
          verdict = { tone: "good", text: "Your value of " + usd(i.arv) + " is conservative against nearby closed sales (" + usd(cs.arvLow) + " to " + usd(cs.arvHigh) + ", median " + usd(cs.arvMid) + "). That's a healthy cushion." };
        } else {
          verdict = { tone: "good", text: "Your value of " + usd(i.arv) + " sits inside the range nearby closed sales support: " + usd(cs.arvLow) + " to " + usd(cs.arvHigh) + " (median " + usd(cs.arvMid) + ", based on " + cs.count + " sales at about " + usd(cs.medianPpsf) + " per sq ft)." };
        }
      } else if (ve && ve.price){
        verdict = { tone: "note", text: "Few closed sales were available here, so this check uses listings: the automated estimate for this property is " + usd(ve.price) + " (" + usd(ve.low) + " to " + usd(ve.high) + "). That is its current value, not necessarily the after-repair value." };
      }
    } else if (type === "rental"){
      var bits = [];
      if (ve && ve.price){ var d = (i.price - ve.price) / ve.price; bits.push("Your price of " + usd(i.price) + " is " + Math.abs(d * 100).toFixed(0) + "% " + (d <= 0 ? "below" : "above") + " the automated value estimate of " + usd(ve.price) + " (" + usd(ve.low) + " to " + usd(ve.high) + ")."); }
      if (re && re.rent){ var dr = (i.rent - re.rent) / re.rent; bits.push("Rent of " + usd(i.rent) + " compares with an estimated market rent of " + usd(re.rent) + " (" + usd(re.low) + " to " + usd(re.high) + ")" + (dr > 0.1 ? ", so your rent looks optimistic." : ".")); }
      if (bits.length) verdict = { tone: (re && re.rent && i.rent > re.rent * 1.1) ? "warn" : "good", text: bits.join(" ") };
    }
    R.pro.verdict = verdict;
    if (verdict) R.insights.unshift(verdict.text);
    if (p.market && (p.market.medianPrice || p.market.medianDaysOnMarket)) R.insights.push("Local market (" + (p.market.zip || "this ZIP") + "): median sale price " + usd(p.market.medianPrice) + (p.market.medianDaysOnMarket ? ", median " + Math.round(p.market.medianDaysOnMarket) + " days on market" : "") + ".");
    if (ctx.arvNote) R.assumptions.push(ctx.arvNote);
    if (ctx.rentNote) R.assumptions.push(ctx.rentNote);
    if (ctx.rehab) R.assumptions.push("Rehab: " + rehabLine(ctx.rehab));
    R.assumptions.push("Property and market data come from public records and listings via RentCast and are automated estimates, not an appraisal.");
  }

  /* ---------- deal definitions ---------- */
  var DEALS = {
    flip: {
      label: "Fix & Flip", program: "fixflip", blurb: "Buy, renovate and sell. See how financing multiplies the return on your cash.",
      fields: [
        ["price","Purchase price","usd",200000],["rehab","Rehab budget","usd",50000],["arv","After-repair value (ARV)","usd",340000],
        ["months","Months to renovate + sell","int",6],["holdMonthly","Monthly holding costs (taxes, insurance, utilities)","usd",1800],
        ["buyCostPct","Buying closing costs (% of price)","pct",2],["sellPct","Selling costs (% of ARV, agent + closing)","pct",7]
      ],
      fin: [["ltcPct","Purchase financed (% of price)","pct",90],["rehabPct","Rehab financed (%)","pct",100],["arvCapPct","Loan cap (% of ARV)","pct",75],["points","Origination points (%)","pct",2],["rate","Interest rate (%)","pct",11.5]]
    },
    rental: {
      label: "Rental (DSCR)", program: "dscr", blurb: "Buy and hold. Compare cash flow, DSCR and 5-year return with and without financing.",
      fields: [
        ["price","Purchase price","usd",280000],["rent","Monthly rent","usd",2700],["taxes","Monthly property taxes","usd",300],["insurance","Monthly insurance","usd",140],
        ["hoa","Monthly HOA","usd",0],["vacancyPct","Vacancy (% of rent)","pct",5],["repairsPct","Repairs & reserves (% of rent)","pct",8],["mgmtPct","Property management (% of rent)","pct",8],
        ["apprPct","Yearly appreciation (%)","pct",3],["rentGrowthPct","Yearly rent growth (%)","pct",3]
      ],
      fin: [["downPct","Down payment (%)","pct",25],["points","Origination points (%)","pct",2],["rate","Interest rate (%)","pct",7.75],["closingPct","Closing costs (% of price)","pct",2]]
    },
    bridge: {
      label: "Bridge Loan", program: "bridge", blurb: "Close fast on a deal that won't wait. See the profit you protect and the cash you can pull back out.",
      fields: [
        ["price","Purchase price","usd",250000],["rehab","Repairs / improvements","usd",30000],["arv","Value after improvements","usd",340000],
        ["months","Months until exit","int",9],["holdMonthly","Monthly holding costs","usd",1200],["buyCostPct","Buying closing costs (% of price)","pct",2],["sellPct","Selling costs if you sell (% of value)","pct",7]
      ],
      fin: [["ltcPct","Purchase financed (% of price)","pct",85],["rehabPct","Repairs financed (%)","pct",100],["arvCapPct","Loan cap (% of value)","pct",75],["points","Origination points (%)","pct",2],["rate","Interest rate (%)","pct",11.5],["refiLtv","Refinance later at (% LTV)","pct",75]]
    },
    build: {
      label: "Ground-Up Construction", program: "ground", blurb: "Build to sell. See how draws and leverage change your profit and your cash required.",
      fields: [
        ["land","Land cost","usd",80000],["hard","Hard construction cost","usd",260000],["soft","Soft costs (permits, design, fees)","usd",25000],["arv","Completed value (ARV)","usd",480000],
        ["buildMonths","Months to build","int",9],["sellMonths","Months to sell after completion","int",3],["holdMonthly","Monthly holding costs (taxes, insurance)","usd",500],["sellPct","Selling costs (% of ARV)","pct",7]
      ],
      fin: [["ltcPct","Loan to total cost (%)","pct",85],["arvCapPct","Loan cap (% of ARV)","pct",70],["points","Origination points (%)","pct",2],["rate","Interest rate (%)","pct",11.5]]
    }
  };

  /* ---------- calculations ---------- */
  function clampLoan(want, cap, maxLoan){
    var l = Math.min(want, cap);
    if (maxLoan && maxLoan > 0) l = Math.min(l, maxLoan);
    return Math.max(0, l);
  }

  function calcFlip(i, f, kind){
    var P = i.price, R = i.rehab, V = i.arv, M = Math.max(1, i.months);
    var closeBuy = P * i.buyCostPct / 100, hold = i.holdMonthly * M, sell = V * i.sellPct / 100;
    var cashCost = P + R + closeBuy + hold;
    var cashProfit = V - sell - cashCost;
    var loan = clampLoan(P * f.ltcPct / 100 + R * f.rehabPct / 100, V * f.arvCapPct / 100, f.maxLoan);
    var loanP = Math.min(P * f.ltcPct / 100, loan), loanR = loan - loanP;
    var interest = (loanP + 0.5 * loanR) * f.rate / 100 * M / 12;
    var points = loan * f.points / 100;
    var totalCost = cashCost + interest + points;
    var profit = V - sell - totalCost;
    var own = Math.max(totalCost - loan, 1);
    var roi = profit / own, cashRoi = cashProfit / cashCost;
    return {
      P:P,R:R,V:V,M:M,sell:sell,closeBuy:closeBuy,hold:hold,cashCost:cashCost,cashProfit:cashProfit,cashRoi:cashRoi,cashAnn:annualize(cashRoi,M),
      loan:loan,interest:interest,points:points,finCost:interest+points,totalCost:totalCost,profit:profit,own:own,roi:roi,ann:annualize(roi,M),
      breakEvenArv: totalCost / (1 - i.sellPct / 100), mao70: 0.7 * V - R, deals: cashCost / own
    };
  }
  function flipStress(i, f){
    function run(name, mod){ var j = {}; for (var k in i) j[k] = i[k]; mod(j); var r = calcFlip(j, f); return { name: name, profit: r.profit, roi: r.roi }; }
    return [
      run("ARV comes in 5% lower", function(j){ j.arv = i.arv * 0.95; }),
      run("Rehab runs 15% over budget", function(j){ j.rehab = i.rehab * 1.15; }),
      run("Takes 3 months longer", function(j){ j.months = i.months + 3; }),
      run("All three at once", function(j){ j.arv = i.arv * 0.95; j.rehab = i.rehab * 1.15; j.months = i.months + 3; })
    ];
  }

  function calcRental(i, f){
    var P = i.price, rent = i.rent, closing = P * f.closingPct / 100;
    var loan = P * (1 - f.downPct / 100);
    if (f.maxLoan && f.maxLoan > 0) loan = Math.min(loan, f.maxLoan);
    var pi = pmt(loan, f.rate, 360), pitia = pi + i.taxes + i.insurance + i.hoa;
    var dscr = pitia > 0 ? rent / pitia : 0;
    function noiAt(rentNow){ return rentNow * (1 - (i.vacancyPct + i.repairsPct + i.mgmtPct) / 100) - i.taxes - i.insurance - i.hoa; }
    var noi = noiAt(rent), cf = noi - pi;
    var cashIn = Math.max(P - loan + closing + loan * f.points / 100, 1), cashAll = P + closing;
    var sumCF = 0, sumNOI = 0, y, rentY;
    for (y = 1; y <= 5; y++){ rentY = rent * Math.pow(1 + i.rentGrowthPct / 100, y - 1); sumNOI += noiAt(rentY) * 12; sumCF += (noiAt(rentY) - pi) * 12; }
    var v5 = P * Math.pow(1 + i.apprPct / 100, 5), bal5 = balance(loan, f.rate, 360, 60), sellCost = v5 * 0.06;
    var total5 = (sumCF + v5 - sellCost - bal5 - cashIn) / cashIn;
    var totalCash5 = (sumNOI + v5 - sellCost - cashAll) / cashAll;
    return {
      P:P,loan:loan,pi:pi,pitia:pitia,dscr:dscr,noi:noi,cf:cf,cashIn:cashIn,cashAll:cashAll,closing:closing,
      coc: cf * 12 / cashIn, cocCash: noi * 12 / cashAll, cap: noi * 12 / P,
      sumCF:sumCF,sumNOI:sumNOI,v5:v5,bal5:bal5,equity5:v5-bal5,total5:total5,ann5:annualize(total5,60),totalCash5:totalCash5,annCash5:annualize(totalCash5,60),
      pointsCost: loan * f.points / 100, deals: cashAll / cashIn
    };
  }
  function rentalStress(i, f){
    function run(name, mod, fmod){ var j = {}, g = {}, k; for (k in i) j[k] = i[k]; for (k in f) g[k] = f[k]; mod(j); if (fmod) fmod(g); var r = calcRental(j, g); return { name:name, cf:r.cf, dscr:r.dscr, coc:r.coc }; }
    return [
      run("Rent 10% lower", function(j){ j.rent = i.rent * 0.9; }),
      run("Vacancy doubles", function(j){ j.vacancyPct = i.vacancyPct * 2; }),
      run("Rate 1 point higher", function(){}, function(g){ g.rate = f.rate + 1; }),
      run("All three at once", function(j){ j.rent = i.rent * 0.9; j.vacancyPct = i.vacancyPct * 2; }, function(g){ g.rate = f.rate + 1; })
    ];
  }

  function calcBridge(i, f){
    var base = calcFlip(i, f);
    var refiLoan = base.V * f.refiLtv / 100, refiCost = refiLoan * 0.02;
    var cashBack = refiLoan - base.loan - refiCost;
    return {
      P:base.P,R:base.R,V:base.V,M:base.M,loan:base.loan,interest:base.interest,points:base.points,finCost:base.finCost,totalCost:base.totalCost,
      profit:base.profit,own:base.own,roi:base.roi,ann:base.ann,cashCost:base.cashCost,cashProfit:base.cashProfit,cashRoi:base.cashRoi,deals:base.deals,
      valueCreated: base.V - base.P - base.R, refiLoan:refiLoan, cashBack:cashBack, cashLeft: Math.max(base.own - cashBack, 0), sell: base.sell
    };
  }
  function bridgeStress(i, f){
    function run(name, mod){ var j = {}; for (var k in i) j[k] = i[k]; mod(j); var r = calcBridge(j, f); return { name:name, profit:r.profit, roi:r.roi }; }
    return [
      run("Value comes in 5% lower", function(j){ j.arv = i.arv * 0.95; }),
      run("Repairs run 15% over", function(j){ j.rehab = i.rehab * 1.15; }),
      run("Exit takes 3 months longer", function(j){ j.months = i.months + 3; }),
      run("All three at once", function(j){ j.arv = i.arv * 0.95; j.rehab = i.rehab * 1.15; j.months = i.months + 3; })
    ];
  }

  function calcBuild(i, f, noFin){
    var totalMonths = i.buildMonths + i.sellMonths;
    var cost = i.land + i.hard + i.soft, hold = i.holdMonthly * totalMonths, sell = i.arv * i.sellPct / 100;
    var cashCost = cost + hold, cashProfit = i.arv - sell - cashCost;
    var loan = clampLoan(cost * f.ltcPct / 100, i.arv * f.capPct / 100 || i.arv * f.arvCapPct / 100, f.maxLoan);
    var loanLand = Math.min(i.land, loan), loanBuild = loan - loanLand;
    var interest = (loanLand * totalMonths + loanBuild * (0.5 * i.buildMonths + i.sellMonths)) * f.rate / 100 / 12;
    var points = loan * f.points / 100, totalCost = cashCost + interest + points;
    var profit = i.arv - sell - totalCost, own = Math.max(totalCost - loan, 1);
    var roi = profit / own, cashRoi = cashProfit / cashCost;
    return {
      cost:cost,hold:hold,sell:sell,cashCost:cashCost,cashProfit:cashProfit,cashRoi:cashRoi,cashAnn:annualize(cashRoi,totalMonths),loan:loan,interest:interest,points:points,
      finCost:interest+points,totalCost:totalCost,profit:profit,own:own,roi:roi,ann:annualize(roi,totalMonths),totalMonths:totalMonths,V:i.arv,
      breakEvenArv: totalCost / (1 - i.sellPct / 100), deals: cashCost / own
    };
  }
  function buildStress(i, f){
    function run(name, mod){ var j = {}; for (var k in i) j[k] = i[k]; mod(j); var r = calcBuild(j, f); return { name:name, profit:r.profit, roi:r.roi }; }
    return [
      run("Completed value 5% lower", function(j){ j.arv = i.arv * 0.95; }),
      run("Construction 15% over budget", function(j){ j.hard = i.hard * 1.15; }),
      run("Build takes 3 months longer", function(j){ j.buildMonths = i.buildMonths + 3; }),
      run("All three at once", function(j){ j.arv = i.arv * 0.95; j.hard = i.hard * 1.15; j.buildMonths = i.buildMonths + 3; })
    ];
  }

  /* ---------- turn a calculation into a displayable / printable report ---------- */
  function buildReport(type, i, f, ctx){
    var d = DEALS[type], R = { type:type, label:d.label, kpis:[], table:[], chart:null, stress:[], stressKind:"profit", insights:[], inputs:[], assumptions:[] };
    var rateNote = ctx.rateNote;
    if (type === "flip"){
      var c = calcFlip(i, f), st = flipStress(i, f);
      R.headline = c.profit > 0 ? "Projected profit " + usd(c.profit) + " on " + usd(c.own) + " of your own cash" : "These numbers don't produce a profit";
      R.kpis = [["Net profit (financed)", usd(c.profit), c.profit >= 0 ? "after all costs" : "loss at these numbers"],["Return on your cash", pct(c.roi,0), pct(c.ann,0) + " annualized"],["Cash you put in", usd(c.own), "vs " + usd(c.cashCost) + " all-cash"],["Break-even ARV", usd(c.breakEvenArv), pct(1 - c.breakEvenArv / c.V,0) + " cushion"]];
      R.table = [["", "All cash", "With financing"],["Cash you put in", usd(c.cashCost), usd(c.own)],["Financing cost (interest + points)", "$0", usd(c.finCost)],["Net profit", usd(c.cashProfit), usd(c.profit)],["Return on your cash", pct(c.cashRoi,1), pct(c.roi,1)],["Annualized return", pct(c.cashAnn,0), pct(c.ann,0)],["Similar deals your cash could fund", "1.0", c.deals.toFixed(1)]];
      R.chart = { title:"Return on your cash", labels:["Single deal","Annualized"], a:[c.cashRoi, c.cashAnn], b:[c.roi, c.ann], fmt:function(v){ return pct(v,0); } };
      R.stress = st; R.stressNote = "Financed profit and return if things go wrong";
      R.insights = [
        "Paying cash would tie up " + usd(c.cashCost) + ". Financing needs " + usd(c.own) + " of your own money, " + mult(c.cashCost / c.own) + " less, so the same capital could fund about " + c.deals.toFixed(1) + " deals like this at once.",
        "You earn " + pct(c.roi,0) + " on your cash with financing versus " + pct(c.cashRoi,0) + " paying all cash. You pay about " + usd(c.finCost) + " for the loan (" + usd(c.interest) + " interest plus " + usd(c.points) + " in points), and that cost is what buys the extra return.",
        st[0].profit > 0 ? "Even if the ARV comes in 5% lower, this deal still makes " + usd(st[0].profit) + " (" + pct(st[0].roi,0) + " on your cash)." : "A 5% lower ARV would erase the profit, so this deal has a thin margin. Negotiate the price or tighten the rehab before you commit.",
        "A common rule of thumb (70% of ARV minus rehab) suggests a maximum offer near " + usd(c.mao70) + ". You're at " + usd(c.P) + (c.P <= c.mao70 ? ", inside that guide." : ", above that guide, so double-check your ARV and rehab numbers.")
      ];
      R.inputs = [["Purchase price", usd(i.price)],["Rehab budget", usd(i.rehab)],["After-repair value", usd(i.arv)],["Time to renovate + sell", i.months + " months"],["Monthly holding costs", usd(i.holdMonthly)],["Buying costs", i.buyCostPct + "%"],["Selling costs", i.sellPct + "%"]];
      R.assumptions = ["Loan: " + usd(c.loan) + " (" + f.ltcPct + "% of price + " + f.rehabPct + "% of rehab, capped at " + f.arvCapPct + "% of ARV" + (f.maxLoan ? ", and at the ballpark maximum for your profile" : "") + ")","Interest-only at " + f.rate + "% with rehab funds drawn gradually (half outstanding on average); " + f.points + " point(s) up front",rateNote];
      R.summary = "Fix & Flip: " + pct(c.roi,0) + " financed vs " + pct(c.cashRoi,0) + " all-cash";
      R.metrics = { price:i.price, rehab:i.rehab, arv:i.arv };
    } else if (type === "rental"){
      var r = calcRental(i, f), rs = rentalStress(i, f);
      R.headline = r.cf >= 0 ? "Projected cash flow " + usd(r.cf) + " a month with a " + r.dscr.toFixed(2) + " DSCR" : "Cash flow is negative at these numbers";
      R.kpis = [["Monthly cash flow", usd(r.cf), "after the loan payment"],["DSCR", r.dscr.toFixed(2), r.dscr >= 1 ? "rent covers the payment" : "rent is below the payment"],["Cash-on-cash return", pct(r.coc,1), "vs " + pct(r.cocCash,1) + " all-cash"],["5-year total return", pct(r.total5,0), pct(r.ann5,0) + " a year"]];
      R.table = [["", "All cash", "With financing"],["Cash you put in", usd(r.cashAll), usd(r.cashIn)],["Monthly cash flow", usd(r.noi), usd(r.cf)],["Cash-on-cash return (yearly)", pct(r.cocCash,1), pct(r.coc,1)],["5-year total return", pct(r.totalCash5,0), pct(r.total5,0)],["Average yearly return", pct(r.annCash5,1), pct(r.ann5,1)],["Similar rentals your cash could buy", "1.0", r.deals.toFixed(1)]];
      R.chart = { title:"5-year return on your cash", labels:["Total","Per year"], a:[r.totalCash5, r.annCash5], b:[r.total5, r.ann5], fmt:function(v){ return pct(v,0); } };
      R.stress = rs; R.stressKind = "rental"; R.stressNote = "Monthly cash flow and DSCR if conditions change";
      R.insights = [
        "Your cash buys " + r.deals.toFixed(1) + " times as many rentals with financing: " + usd(r.cashIn) + " per property instead of " + usd(r.cashAll) + ". Each one adds its own cash flow, appreciation and loan paydown.",
        "Cash-on-cash return is " + pct(r.coc,1) + " with financing versus " + pct(r.cocCash,1) + " paying cash. Over 5 years the financed property returns about " + pct(r.total5,0) + " on your cash (cash flow + appreciation + loan paydown) versus " + pct(r.totalCash5,0) + " all-cash.",
        r.dscr >= 1 ? "A DSCR of " + r.dscr.toFixed(2) + " means the rent covers the full payment (principal, interest, taxes, insurance and HOA) with room to spare, which is what a DSCR loan qualifies on, not your tax returns." : "At a DSCR of " + r.dscr.toFixed(2) + " the rent doesn't fully cover the payment. A larger down payment, a lower price or higher rent would help, and some programs allow DSCR below 1.0 with less leverage.",
        "Loan paydown adds up: the balance falls from " + usd(r.loan) + " to about " + usd(r.bal5) + " in 5 years, building " + usd(r.equity5) + " of equity alongside appreciation."
      ];
      R.inputs = [["Purchase price", usd(i.price)],["Monthly rent", usd(i.rent)],["Taxes / insurance / HOA", usd(i.taxes) + " / " + usd(i.insurance) + " / " + usd(i.hoa)],["Vacancy", i.vacancyPct + "%"],["Repairs & reserves", i.repairsPct + "%"],["Management", i.mgmtPct + "%"],["Appreciation / rent growth", i.apprPct + "% / " + i.rentGrowthPct + "%"]];
      R.assumptions = ["Loan: " + usd(r.loan) + " (" + (100 - Math.round(r.loan / r.P * 100)) + "% down), 30-year fixed at " + f.rate + "%, " + f.points + " point(s), closing costs " + f.closingPct + "% of price","5-year view assumes a sale at the end with 6% selling costs",rateNote];
      R.summary = "Rental: " + usd(r.cf) + "/mo cash flow, DSCR " + r.dscr.toFixed(2) + ", " + pct(r.coc,1) + " cash-on-cash";
      R.metrics = { price:i.price, rent:i.rent };
    } else if (type === "bridge"){
      var b = calcBridge(i, f), bs = bridgeStress(i, f);
      R.headline = "A bridge loan lets you capture " + usd(b.valueCreated) + " of value with " + usd(b.own) + " of your own cash";
      R.kpis = [["Value created", usd(b.valueCreated), "value minus price and repairs"],["Net profit if you sell", usd(b.profit), pct(b.roi,0) + " on your cash"],["Cash you put in", usd(b.own), "vs " + usd(b.cashCost) + " all-cash"],["Cash back if you refinance", usd(Math.max(b.cashBack,0)), b.cashBack >= b.own ? "all your cash returned" : usd(b.cashLeft) + " left in the deal"]];
      R.table = [["", "All cash", "With a bridge loan"],["Cash you put in", usd(b.cashCost), usd(b.own)],["Financing cost (interest + points)", "$0", usd(b.finCost)],["Net profit if you sell", usd(b.cashProfit), usd(b.profit)],["Return on your cash", pct(b.cashRoi,1), pct(b.roi,1)],["Annualized return", pct(annualize(b.cashRoi,b.M),0), pct(b.ann,0)],["Cash back at refinance (" + f.refiLtv + "% LTV)", "n/a", usd(Math.max(b.cashBack,0))]];
      R.chart = { title:"Return on your cash if you sell", labels:["Single deal","Annualized"], a:[b.cashRoi, annualize(b.cashRoi,b.M)], b:[b.roi, b.ann], fmt:function(v){ return pct(v,0); } };
      R.stress = bs; R.stressNote = "Profit and return if the exit goes wrong";
      R.insights = [
        "Speed is the point of a bridge loan: if slower financing costs you this deal, you walk away from about " + usd(b.profit) + " of profit. The financing itself costs roughly " + usd(b.finCost) + ".",
        "You put in " + usd(b.own) + " instead of " + usd(b.cashCost) + ", so the same cash could work on about " + b.deals.toFixed(1) + " deals at once.",
        b.cashBack > 0 ? "Instead of selling, you could refinance into long-term financing at " + f.refiLtv + "% of value (" + usd(b.refiLoan) + "), pay off the bridge loan and pull back about " + usd(b.cashBack) + " of your cash" + (b.cashBack >= b.own ? ", all of it, while keeping the property." : ", leaving only " + usd(b.cashLeft) + " in the deal.") : "A refinance at " + f.refiLtv + "% of value wouldn't fully pay off the bridge loan at these numbers, so plan to sell or add equity.",
        bs[0].profit > 0 ? "If the value comes in 5% lower, you'd still clear about " + usd(bs[0].profit) + "." : "A 5% lower value would erase the profit, so make sure your value estimate is conservative."
      ];
      R.inputs = [["Purchase price", usd(i.price)],["Repairs / improvements", usd(i.rehab)],["Value after improvements", usd(i.arv)],["Months until exit", i.months + " months"],["Monthly holding costs", usd(i.holdMonthly)],["Buying / selling costs", i.buyCostPct + "% / " + i.sellPct + "%"]];
      R.assumptions = ["Loan: " + usd(b.loan) + " (" + f.ltcPct + "% of price + " + f.rehabPct + "% of repairs, capped at " + f.arvCapPct + "% of value), interest-only at " + f.rate + "%, " + f.points + " point(s)","Refinance assumes closing costs of 2% of the new loan",rateNote];
      R.summary = "Bridge: " + usd(b.valueCreated) + " value created, " + pct(b.roi,0) + " on cash";
      R.metrics = { price:i.price, rehab:i.rehab, arv:i.arv };
    } else {
      var g = calcBuild(i, f), gs = buildStress(i, f);
      R.headline = g.profit > 0 ? "Projected profit " + usd(g.profit) + " on " + usd(g.own) + " of your own cash" : "These numbers don't produce a profit";
      R.kpis = [["Net profit (financed)", usd(g.profit), g.profit >= 0 ? "after all costs" : "loss at these numbers"],["Return on your cash", pct(g.roi,0), pct(g.ann,0) + " annualized"],["Cash you put in", usd(g.own), "vs " + usd(g.cashCost) + " all-cash"],["Break-even value", usd(g.breakEvenArv), pct(1 - g.breakEvenArv / g.V,0) + " cushion"]];
      R.table = [["", "All cash", "With construction financing"],["Total project cost", usd(g.cashCost), usd(g.totalCost)],["Cash you put in", usd(g.cashCost), usd(g.own)],["Financing cost (interest + points)", "$0", usd(g.finCost)],["Net profit", usd(g.cashProfit), usd(g.profit)],["Return on your cash", pct(g.cashRoi,1), pct(g.roi,1)],["Annualized return", pct(g.cashAnn,0), pct(g.ann,0)],["Similar projects your cash could fund", "1.0", g.deals.toFixed(1)]];
      R.chart = { title:"Return on your cash", labels:["Whole project","Annualized"], a:[g.cashRoi, g.cashAnn], b:[g.roi, g.ann], fmt:function(v){ return pct(v,0); } };
      R.stress = gs; R.stressNote = "Financed profit and return if the project goes sideways";
      R.insights = [
        "Building with cash would tie up " + usd(g.cashCost) + ". With construction financing you put in " + usd(g.own) + ", " + mult(g.cashCost / g.own) + " less, so the same capital could run about " + g.deals.toFixed(1) + " projects at once.",
        "Construction funds are released in draws as work is completed, so you only pay interest on what's been drawn. Here that's about " + usd(g.interest) + " in interest plus " + usd(g.points) + " in points over " + g.totalMonths + " months.",
        "Return on your cash is " + pct(g.roi,0) + " financed versus " + pct(g.cashRoi,0) + " all-cash.",
        gs[3].profit > 0 ? "Even if value drops 5%, construction runs 15% over and the build takes 3 months longer, you'd still make about " + usd(gs[3].profit) + "." : "If value drops 5%, costs run 15% over and the build takes 3 months longer, the deal loses money, so build a bigger cushion into the budget and timeline."
      ];
      R.inputs = [["Land", usd(i.land)],["Hard construction cost", usd(i.hard)],["Soft costs", usd(i.soft)],["Completed value (ARV)", usd(i.arv)],["Build / sell time", i.buildMonths + " + " + i.sellMonths + " months"],["Holding costs / selling costs", usd(i.holdMonthly) + "/mo / " + i.sellPct + "%"]];
      R.assumptions = ["Loan: " + usd(g.loan) + " (" + f.ltcPct + "% of total cost, capped at " + f.arvCapPct + "% of completed value). Land funded at closing; construction drawn evenly (half outstanding on average during the build), full balance outstanding while selling","Interest-only at " + f.rate + "%, " + f.points + " point(s) up front",rateNote];
      R.summary = "Ground-up: " + pct(g.roi,0) + " financed vs " + pct(g.cashRoi,0) + " all-cash";
      R.metrics = { price:i.land + i.hard + i.soft, arv:i.arv };
    }
    if (ctx.pro) applyPro(R, type, i, f, ctx);
    return R;
  }

  /* ---------- form + page ---------- */
  function fieldHTML(group, f){
    var k = f[0], label = f[1], t = f[2], def = f[3];
    return '<div class="az-f"><label for="az-' + group + k + '">' + esc(label) + '</label><div class="az-in">' + (t === "usd" ? '<span class="az-u">$</span>' : "") +
      '<input id="az-' + group + k + '" data-k="' + k + '" data-g="' + group + '" inputmode="decimal" value="' + (t === "usd" ? Number(def).toLocaleString("en-US") : def) + '">' + (t === "pct" ? '<span class="az-u r">%</span>' : "") + '</div></div>';
  }
  function init(root){
    var type = "flip", touchedRate = false, ballpark = null, lastReport = null, jsPdfPromise = null, logoPromise = null;
    var saved = {}; try { saved = JSON.parse(localStorage.getItem("bp_az_contact") || "{}"); } catch (e) {}
    var tabs = Object.keys(DEALS).map(function(k){ return '<button type="button" class="az-tab" data-type="' + k + '">' + DEALS[k].label + '</button>'; }).join("");
    root.innerHTML =
      '<div class="az-tabs" role="tablist">' + tabs + '</div>' +
      '<div class="az-grid"><div class="az-card"><h2 id="az-title"></h2><p class="az-blurb" id="az-blurb"></p>' +
        '<div class="az-fields" id="az-fields"></div>' +
        '<details class="az-fin"><summary>Financing assumptions <span>(editable — we prefill a ballpark rate from our live estimator)</span></summary><div class="az-fields" id="az-fin"></div></details>' +
        '<h3 class="az-h3">Your profile <span>(used for the ballpark rate)</span></h3><div class="az-fields two">' +
          '<div class="az-f"><label for="az-state">Property state</label><div class="az-in"><select id="az-state"><option value="">Select…</option>' + STATES.map(function(s){ return '<option>' + s + '</option>'; }).join("") + '</select></div></div>' +
          '<div class="az-f"><label for="az-credit">Credit score</label><div class="az-in"><select id="az-credit">' + CREDIT.map(function(c){ return '<option' + (c === "720-759" ? " selected" : "") + '>' + c + '</option>'; }).join("") + '</select></div></div>' +
          '<div class="az-f"><label for="az-exp">Experience</label><div class="az-in"><select id="az-exp">' + EXPERIENCE.map(function(c){ return '<option value="' + c[0] + '"' + (c[0] === "1-2 deals" ? " selected" : "") + '>' + c[1] + '</option>'; }).join("") + '</select></div></div>' +
        '</div>' +
        '<h3 class="az-h3">Property address <span>(optional: unlocks real recent sales, value range and market data)</span></h3>' +
        '<div class="az-f"><label for="az-addr">Street, city, state, ZIP</label><div class="az-in"><input id="az-addr" autocomplete="street-address" placeholder="e.g. 123 Main St, Tampa, FL 33602"></div></div>' +
        '<details class="az-fin" id="az-rehab"><summary>Estimate my rehab budget <span>(uses real materials-cost data)</span></summary><div class="az-fields two">' +
          '<div class="az-f"><label for="az-scope">Scope of work</label><div class="az-in"><select id="az-scope"><option value="">Chooseâ€¦</option>' + Object.keys(SCOPES).map(function(k){ return '<option value="' + k + '">' + SCOPES[k].label + '</option>'; }).join("") + '</select></div></div>' +
          '<div class="az-f"><label for="az-sqft">Living area (sq ft)</label><div class="az-in"><input id="az-sqft" inputmode="numeric" placeholder="auto-filled from the address"></div></div></div>' +
          '<div id="az-rehabout"></div></details>' +
        '<div class="az-err" id="az-err" role="alert" aria-live="polite"></div>' +
        '<button type="button" class="btn btn-gold az-go" id="az-go">Analyze my deal</button></div>' +
      '<div class="az-out" id="az-out"><div class="az-empty"><b>Your analysis appears here.</b><br>Enter your numbers and click <em>Analyze my deal</em>. You&rsquo;ll see profit, return on your cash, financed vs. all-cash, and a stress test, then you can download it as a PDF.</div></div></div>' +
      '<div class="az-modal" id="az-modal" hidden><div class="az-box"><button type="button" class="az-x" id="az-x" aria-label="Close">×</button>' +
        '<h3 id="az-mtitle">Where should we send your PDF?</h3><p id="az-mtext">Your analysis downloads right away. A loan officer may follow up with exact numbers for this deal.</p>' +
        '<form id="az-form" novalidate><div class="az-fields"><div class="az-f"><label for="az-name">Full name</label><div class="az-in"><input id="az-name" name="name" autocomplete="name" value="' + esc(saved.name || "") + '"></div></div>' +
        '<div class="az-fields two"><div class="az-f"><label for="az-phone">Mobile phone</label><div class="az-in"><input id="az-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="' + esc(saved.phone || "") + '"></div></div>' +
        '<div class="az-f"><label for="az-email">Email</label><div class="az-in"><input id="az-email" name="email" type="email" autocomplete="email" value="' + esc(saved.email || "") + '"></div></div></div>' +
        '<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;opacity:0">' +
        '<label class="consent"><input type="checkbox" name="consent"><span>I agree that BridgePoint Lending may call, text and email me about my loan request at the number and email above, including with automated technology and AI-assisted messages. Not a condition of any loan. Msg &amp; data rates may apply; reply STOP to opt out. See our <a href="' + BASE + '/privacy-policy/">Privacy Policy</a>.</span></label>' +
        '<div class="az-err" id="az-ferr" role="alert" aria-live="polite"></div>' +
        '<button type="submit" class="btn btn-gold" id="az-dl">Continue</button></div></form></div></div>';

    var el = function(id){ return document.getElementById(id); };
    function renderFields(){
      var d = DEALS[type];
      el("az-title").textContent = d.label + " Deal Analysis";
      el("az-blurb").textContent = d.blurb;
      el("az-fields").innerHTML = d.fields.map(function(f){ return fieldHTML("i", f); }).join("");
      el("az-fin").innerHTML = d.fin.map(function(f){ return fieldHTML("f", f); }).join("");
      var tabsEl = root.querySelectorAll(".az-tab"), n;
      for (n = 0; n < tabsEl.length; n++) tabsEl[n].classList.toggle("on", tabsEl[n].getAttribute("data-type") === type);
      touchedRate = false; ballpark = null; touched = {};
      var rb = el("az-rehab"); if (rb) rb.style.display = (type === "flip" || type === "bridge") ? "" : "none";
    }
    function readGroup(group){
      var out = {}, nodes = root.querySelectorAll('input[data-g="' + group + '"]'), n, v;
      for (n = 0; n < nodes.length; n++){ v = parseFloat(String(nodes[n].value).replace(/[^0-9.\-]/g, "")); out[nodes[n].getAttribute("data-k")] = isFinite(v) ? v : 0; }
      return out;
    }
    root.addEventListener("click", function(e){
      var t = e.target.closest && e.target.closest(".az-tab");
      if (t){ type = t.getAttribute("data-type"); renderFields(); el("az-out").innerHTML = '<div class="az-empty"><b>Your analysis appears here.</b><br>Enter your numbers and click <em>Analyze my deal</em>.</div>'; lastReport = null; }
    });

    function fetchBallpark(i){
      var d = DEALS[type], state = el("az-state").value;
      var price = i.price || i.land + i.hard + i.soft;
      var body = { program: d.program, state: state, goal: "purchase", propertyType: "SFR", value: String(Math.round(price)), credit: el("az-credit").value, experience: el("az-exp").value };
      if (type === "rental") body.rent = String(Math.round(i.rent));
      if (type === "flip" || type === "bridge"){ body.rehab = String(Math.round(i.rehab || 1)); body.arv = String(Math.round(i.arv)); }
      return fetch(API + "public-estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){ return (res.ok && res.j && res.j.ok && res.j.eligible) ? res.j : null; })
        .catch(function(){ return null; });
    }

    var costIdx = null, contact = null, pendingRun = false, pendingDownload = false, touched = {};
    try { var sc = JSON.parse(localStorage.getItem("bp_az_lead") || "null"); if (sc && sc.leadId && Date.now() - sc.ts < 40 * 3600000) contact = sc; } catch (x) {}
    function getCostIndex(){
      if (costIdx) return Promise.resolve(costIdx);
      return fetch(API + "cost-index").then(function(r){ return r.json(); }).then(function(j){ if (j && j.ok) costIdx = j; return costIdx; }).catch(function(){ return null; });
    }
    function currentAddress(){ return (el("az-addr").value || "").trim(); }
    function setField(k, v){ var n = root.querySelector('input[data-g="i"][data-k="' + k + '"]'); if (n) n.value = Number(v).toLocaleString("en-US"); }
    function validate(i){
      if (!el("az-state").value) return "Pick the property state so we can pull a ballpark rate.";
      var core = type === "build" ? (i.land > 0 && i.hard > 0 && i.arv > 0) : (type === "rental" ? (i.price > 0 && i.rent > 0) : (i.price > 0 && i.arv > 0));
      return core ? "" : "Fill in the main numbers (price, value and rent or ARV) to run the analysis.";
    }
    function updateRehabOut(){
      var scope = el("az-scope").value, sqft = parseFloat(String(el("az-sqft").value).replace(/[^0-9.]/g, "")), out = el("az-rehabout");
      if (!scope || !sqft || !isFinite(sqft)){ out.innerHTML = ""; return; }
      getCostIndex().then(function(idx){
        var e = rehabEstimate(scope, sqft, el("az-state").value, idx);
        out.innerHTML = '<p class="az-rehabtxt"><b>' + usd(e.lo) + ' to ' + usd(e.hi) + '</b> (midpoint ' + usd(e.mid) + '). ' + esc(e.label) + ': ' + esc(e.desc) + '.</p><button type="button" class="btn btn-ghost az-smallbtn" id="az-userehab" data-mid="' + Math.round(e.mid) + '">Use the midpoint as my rehab budget</button><p class="az-fine">' + esc(rehabLine(e)) + '</p>';
      });
    }
    root.addEventListener("input", function(e){
      var t = e.target, k = t && t.getAttribute && t.getAttribute("data-k");
      if (k === "rate") touchedRate = true;
      if (k && t.getAttribute("data-g") === "i") touched[k] = true;
      if (t && (t.id === "az-sqft")) updateRehabOut();
    });
    root.addEventListener("change", function(e){ if (e.target && (e.target.id === "az-scope" || e.target.id === "az-state")) updateRehabOut(); });
    getCostIndex();

    function openContactModal(title, text){
      el("az-mtitle").textContent = title; el("az-mtext").textContent = text; el("az-ferr").textContent = ""; el("az-modal").hidden = false;
    }
    function submitLead(c){
      var rep = lastReport, i = rep ? rep.metrics : readGroup("i");
      var body = { src: "site", tool: "analyzer", program: DEALS[type].program, name: c.name, phone: c.phone, email: c.email, consent: true, website: c.website || "",
        state: el("az-state").value, credit: el("az-credit").value, experience: el("az-exp").value, goal: "purchase",
        value: i.price, rent: i.rent, rehab: i.rehab, arv: i.arv, address: currentAddress(),
        estimate: "Deal Analyzer: " + (rep ? rep.summary : "started a " + DEALS[type].label + " analysis" + (currentAddress() ? " (pro lookup)" : "")) };
      ["utm_source","utm_medium","utm_campaign"].forEach(function(k){ try { var v = new URLSearchParams(location.search).get(k); if (v) body[k] = v; } catch (x) {} });
      return fetch(API + "ad-lead-intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (window.fbq) window.fbq("track", "Lead");
          if (window.gtag) window.gtag("event", "generate_lead", { method: "deal_analyzer", deal_type: type });
          contact = { name: c.name, phone: c.phone, email: c.email, leadId: (j && j.leadId) || null, ts: Date.now() };
          try { localStorage.setItem("bp_az_contact", JSON.stringify({ name: c.name, phone: c.phone, email: c.email })); localStorage.setItem("bp_az_lead", JSON.stringify(contact)); } catch (x) {}
          return contact;
        });
    }

    el("az-go").addEventListener("click", function(){
      var err = el("az-err"); err.textContent = "";
      var msg = validate(readGroup("i")); if (msg){ err.textContent = msg; return; }
      if (currentAddress().length >= 8 && !(contact && contact.leadId)){
        pendingRun = true;
        openContactModal("Run the pro analysis", "To pull recent sales, value and market data for this address, we need your contact info. We'll email you the finished analysis too.");
        return;
      }
      runAnalysis();
    });

    function runAnalysis(){
      var err = el("az-err"), btn = el("az-go"), i = readGroup("i"), f = readGroup("f"), addr = currentAddress(), d = DEALS[type];
      btn.disabled = true; btn.textContent = addr ? "Pulling recent sales and running the numbers…" : "Running the numbers…";
      var needs = type === "rental" ? ["value", "rent", "market"] : ["value", "sold", "market"];
      var proP = (addr.length >= 8 && contact && contact.leadId)
        ? fetch(API + "deal-data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: addr, leadId: contact.leadId, email: contact.email, need: needs }) }).then(function(r){ return r.json(); }).catch(function(){ return null; })
        : Promise.resolve(null);
      Promise.all([fetchBallpark(i), proP, getCostIndex()]).then(function(res){
        var bp = res[0], pd = res[1], idx = res[2], rateNote, pro = null, arvNote = null, rentNote = null, rehab = null;
        if (bp && !touchedRate){ f.rate = bp.rateHigh; rateNote = "Interest rate " + bp.rateHigh + "% is the top of our live ballpark range (" + bp.rateLow + "%–" + bp.rateHigh + "%) for your profile. Your actual rate depends on the full loan file."; }
        else if (touchedRate){ rateNote = "Interest rate " + f.rate + "% was entered by you. Ask a loan officer for current pricing on your deal."; }
        else { rateNote = "Interest rate " + f.rate + "% is a typical assumption (a live ballpark was unavailable). Ask a loan officer for current pricing."; }
        f.maxLoan = (bp && bp.maxLoan) ? bp.maxLoan : null;
        if (type === "build") f.capPct = f.arvCapPct;
        if (pd && pd.ok && pd.configured !== false && pd.found){
          pro = pd;
          if (type !== "rental" && !touched.arv && pd.compStats && pd.compStats.count >= 3 && pd.compStats.arvMid){
            i.arv = pd.compStats.arvMid; setField("arv", i.arv);
            arvNote = "After-repair value of " + usd(i.arv) + " was filled in from nearby closed sales (median price per sq ft times this property's square footage). Change it if you know better.";
          }
          if (type === "rental" && !touched.rent && pd.rentEstimate && pd.rentEstimate.rent){
            i.rent = pd.rentEstimate.rent; setField("rent", i.rent);
            rentNote = "Monthly rent of " + usd(i.rent) + " was filled in from the automated market-rent estimate for this address. Change it if you have a lease or better data.";
          }
          if (pd.subject && pd.subject.sqft && !el("az-sqft").value){ el("az-sqft").value = Number(pd.subject.sqft).toLocaleString("en-US"); }
        } else if (pd && pd.found === false){ err.textContent = pd.detail || "We couldn't find that address, so this analysis uses your numbers only."; }
        else if (pd && pd.error){ err.textContent = pd.detail || ""; }
        var scope = el("az-scope").value, sq = parseFloat(String(el("az-sqft").value).replace(/[^0-9.]/g, ""));
        if ((type === "flip" || type === "bridge") && scope && sq) rehab = rehabEstimate(scope, sq, el("az-state").value, idx);
        lastReport = buildReport(type, i, f, { rateNote: rateNote, pro: pro, arvNote: arvNote, rentNote: rentNote, rehab: rehab });
        lastReport.state = el("az-state").value; lastReport.credit = el("az-credit").value; lastReport.experience = el("az-exp").value;
        el("az-out").innerHTML = renderReport(lastReport);
        btn.disabled = false; btn.textContent = "Analyze my deal";
        var out = el("az-out"); if (out.scrollIntoView && window.innerWidth < 900) out.scrollIntoView({ behavior: "smooth", block: "start" });
        if (contact && contact.leadId && pro) deliver({ download: false });
      });
    }

    root.addEventListener("click", function(e){
      var tg = e.target;
      if (tg.closest && tg.closest("#az-userehab")){ var mid = tg.closest("#az-userehab").getAttribute("data-mid"); setField("rehab", mid); touched.rehab = true; return; }
      if (tg.closest && tg.closest("#az-dlbtn")){
        if (contact && contact.leadId) { deliver({ download: true }); return; }
        var sv = {}; try { sv = JSON.parse(localStorage.getItem("bp_az_contact") || "{}"); } catch (x) {}
        pendingDownload = true;
        if (sv.name && sv.phone && sv.email){ submitLead(sv).then(function(){ pendingDownload = false; deliver({ download: true }); }); }
        else { openContactModal("Where should we send your PDF?", "Your analysis downloads right away and a copy is emailed to you. A loan officer may follow up with exact numbers for this deal."); }
        return;
      }
      if (tg.id === "az-x" || tg.id === "az-modal"){ el("az-modal").hidden = true; pendingRun = false; pendingDownload = false; }
    });
    el("az-form").addEventListener("submit", function(e){
      e.preventDefault(); var err = el("az-ferr"); err.textContent = "";
      var f = e.target, name = f.elements.name.value.trim(), phone = f.elements.phone.value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""), email = f.elements.email.value.trim();
      if (name.length < 2) return err.textContent = "Please enter your name.";
      if (phone.length !== 10) return err.textContent = "Please enter a 10-digit phone number.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err.textContent = "Please enter a valid email.";
      if (!f.elements.consent.checked) return err.textContent = "Please check the box so we can contact you about your request.";
      var btn = el("az-dl"); btn.disabled = true; btn.textContent = "One moment…";
      submitLead({ name: name, phone: f.elements.phone.value, email: email, website: f.elements.website.value }).then(function(){
        btn.disabled = false; btn.textContent = "Continue"; el("az-modal").hidden = true;
        if (pendingRun){ pendingRun = false; runAnalysis(); }
        else if (pendingDownload){ pendingDownload = false; deliver({ download: true }); }
      }).catch(function(){ btn.disabled = false; btn.textContent = "Continue"; err.textContent = "Something went wrong. Please try again or call (850) 279-8588."; });
    });

    function emailReport(rep, doc, fname){
      if (!contact || !contact.leadId || rep.emailed) return Promise.resolve();
      var first = String(contact.name || "").split(/\s+/)[0] || "there";
      var lines = ["Hi " + first + ",", "", "Your " + rep.label + " deal analysis is attached as a PDF.", "", "Highlights:", "- " + rep.headline].concat(rep.kpis.map(function(k){ return "- " + k[0] + ": " + k[1] + " (" + k[2] + ")"; }));
      if (rep.pro && rep.pro.verdict) lines.push("- " + rep.pro.verdict.text);
      lines = lines.concat(["", "Next steps:", "- Get exact terms from a loan officer: https://bplending.com/get-quote/", "- Start your application: https://bplending.com/apply/", "- Or call or text us at (850) 279-8588", "", "This analysis is an illustration based on the numbers entered and automated data. It is not an offer, rate lock or commitment to lend.", "", "BridgePoint Lending"]);
      var b64 = doc.output("datauristring").split(",")[1];
      return fetch(API + "send-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: contact.leadId, to: contact.email, subject: "Your " + rep.label + " deal analysis from BridgePoint Lending", text: lines.join("\n"), fromName: "BridgePoint Lending", fromAddress: "info@bplending.com", attachmentBase64: b64, attachmentName: fname, attachmentContentType: "application/pdf" }) })
        .then(function(r){ return r.json(); }).then(function(j){ if (j && j.ok){ rep.emailed = true; var m = document.getElementById("az-msg"); if (m) m.textContent = "A copy of this analysis was emailed to " + contact.email + "."; } }).catch(function(){});
    }
    function deliver(opts){
      var rep = lastReport; if (!rep) return Promise.resolve();
      return makePdf(rep).then(function(res){
        if (!res) return;
        if (opts.download) res.doc.save(res.fname);
        return emailReport(rep, res.doc, res.fname);
      });
    }

    function proHTML(r){
      var p = r.pro; if (!p) return "";
      var s = p.subject || {}, facts = [s.address, s.beds ? s.beds + " bd" : null, s.baths ? s.baths + " ba" : null, s.sqft ? Number(s.sqft).toLocaleString("en-US") + " sq ft" : null, s.yearBuilt ? "built " + s.yearBuilt : null, s.lastSalePrice ? "last sold " + usd(s.lastSalePrice) + (s.lastSaleDate ? " (" + String(s.lastSaleDate).slice(0, 4) + ")" : "") : null].filter(Boolean).join(" · ");
      var html = '<h3 class="az-h3">Property &amp; market data <span>real data for this address</span></h3><div class="az-pro"><p class="az-facts">' + esc(facts) + '</p>';
      if (p.verdict) html += '<div class="az-call ' + esc(p.verdict.tone) + '">' + esc(p.verdict.text) + '</div>';
      if (p.soldComps && p.soldComps.length){
        html += '<table class="az-table az-comps"><thead><tr><th>Closed sale nearby (last 12 months)</th><th class="r">Sold</th><th class="r">Price</th><th class="r">Sq ft</th><th class="r">$/sq ft</th><th class="r">Mi</th></tr></thead><tbody>' +
          p.soldComps.slice(0, 8).map(function(c){ return '<tr><td>' + esc(c.address) + '</td><td class="r">' + esc(String(c.soldDate).slice(0, 7)) + '</td><td class="r">' + usd(c.price) + '</td><td class="r">' + Number(c.sqft).toLocaleString("en-US") + '</td><td class="r">' + usd(c.ppsf) + '</td><td class="r">' + (c.distance != null ? c.distance.toFixed(2) : "—") + '</td></tr>'; }).join("") + '</tbody></table>';
      }
      if (p.valueEstimate && p.valueEstimate.price) html += '<p class="az-fine">Automated value estimate: ' + usd(p.valueEstimate.price) + ' (range ' + usd(p.valueEstimate.low) + ' to ' + usd(p.valueEstimate.high) + ').' + (p.rentEstimate && p.rentEstimate.rent ? ' Estimated market rent: ' + usd(p.rentEstimate.rent) + ' a month (' + usd(p.rentEstimate.low) + ' to ' + usd(p.rentEstimate.high) + ').' : '') + '</p>';
      if (p.market && p.market.medianPrice) html += '<p class="az-fine">Local market (' + esc(p.market.zip || "") + '): median sale price ' + usd(p.market.medianPrice) + (p.market.medianDaysOnMarket ? ', median ' + Math.round(p.market.medianDaysOnMarket) + ' days on market' : '') + '.</p>';
      if (p.rehab) html += '<p class="az-fine"><b>Rehab estimate:</b> ' + esc(rehabLine(p.rehab)) + '</p>';
      (p.warnings || []).forEach(function(w){ html += '<div class="az-call note">' + esc(w) + '</div>'; });
      return html + '</div>';
    }

    function renderReport(r){
      var kp = r.kpis.map(function(k){ return '<div class="az-kpi"><div class="az-kl">' + esc(k[0]) + '</div><div class="az-kv">' + esc(k[1]) + '</div><div class="az-ks">' + esc(k[2]) + '</div></div>'; }).join("");
      var tbl = '<table class="az-table"><thead><tr>' + r.table[0].map(function(h, n){ return '<th' + (n ? ' class="r"' : '') + '>' + esc(h) + '</th>'; }).join("") + '</tr></thead><tbody>' +
        r.table.slice(1).map(function(row){ return '<tr>' + row.map(function(c, n){ return '<td' + (n ? ' class="r' + (n === 2 ? ' fin' : '') + '"' : '') + '>' + esc(c) + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody></table>';
      var maxV = 0.0001; r.chart.a.concat(r.chart.b).forEach(function(v){ if (v > maxV) maxV = v; });
      var chart = '<div class="az-chart"><div class="az-ct">' + esc(r.chart.title) + '</div>' + r.chart.labels.map(function(lab, n){
        var wa = Math.max(2, Math.max(r.chart.a[n], 0) / maxV * 100), wb = Math.max(2, Math.max(r.chart.b[n], 0) / maxV * 100);
        return '<div class="az-row"><div class="az-rl">' + esc(lab) + '</div><div class="az-bars"><div class="az-bar a" style="width:' + wa + '%"><span>All cash ' + esc(r.chart.fmt(r.chart.a[n])) + '</span></div><div class="az-bar b" style="width:' + wb + '%"><span>Financed ' + esc(r.chart.fmt(r.chart.b[n])) + '</span></div></div></div>';
      }).join("") + '</div>';
      var stress = '<table class="az-table"><thead><tr><th>If this happens…</th>' + (r.stressKind === "rental" ? '<th class="r">Cash flow / mo</th><th class="r">DSCR</th>' : '<th class="r">Net profit</th><th class="r">Return on cash</th>') + '</tr></thead><tbody>' +
        r.stress.map(function(s){ return r.stressKind === "rental" ? '<tr><td>' + esc(s.name) + '</td><td class="r ' + (s.cf < 0 ? "neg" : "") + '">' + usd(s.cf) + '</td><td class="r ' + (s.dscr < 1 ? "neg" : "") + '">' + s.dscr.toFixed(2) + '</td></tr>' : '<tr><td>' + esc(s.name) + '</td><td class="r ' + (s.profit < 0 ? "neg" : "") + '">' + usd(s.profit) + '</td><td class="r ' + (s.roi < 0 ? "neg" : "") + '">' + pct(s.roi, 0) + '</td></tr>'; }).join("") + '</tbody></table>';
      return '<div class="az-res"><div class="az-head">' + esc(r.label) + ' analysis</div><h2>' + esc(r.headline) + '</h2><div class="az-kpis">' + kp + '</div>' +
        proHTML(r) + '<h3 class="az-h3">Financed vs. all-cash</h3>' + tbl + chart +
        '<h3 class="az-h3">Why financing makes sense on this deal</h3><ul class="az-ins">' + r.insights.map(function(t){ return '<li>' + esc(t) + '</li>'; }).join("") + '</ul>' +
        '<h3 class="az-h3">Stress test <span>' + esc(r.stressNote) + '</span></h3>' + stress +
        '<div class="az-cta"><div><b>Turn this analysis into a funded deal.</b><br>Get exact terms from a loan officer, or start your application now.</div><div class="az-ctab"><a class="btn btn-gold" href="' + BASE + '/apply/">Apply Now</a><a class="btn btn-ghost" href="' + BASE + '/get-quote/">Get Exact Terms</a><button type="button" class="btn btn-ghost" id="az-dlbtn">Download PDF</button></div></div>' +
        '<div class="az-msg" id="az-msg"></div>' +
        '<p class="az-fine">' + r.assumptions.map(esc).join(" ") + ' Illustration only: not an offer, rate lock or commitment to lend. Results depend on the numbers you entered; actual terms, costs and returns will differ. Business-purpose loans only.</p></div>';
    }

    /* ---------- PDF ---------- */
    function loadJsPdf(){
      if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
      if (!jsPdfPromise) jsPdfPromise = new Promise(function(resolve, reject){
        var s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
        s.onload = resolve; s.onerror = function(){ reject(new Error("pdf library")); }; document.head.appendChild(s);
      });
      return jsPdfPromise;
    }
    function loadLogo(){
      if (!logoPromise) logoPromise = fetch(BASE + "/static/logo-wide.png").then(function(r){ return r.blob(); }).then(function(b){ return new Promise(function(res){ var fr = new FileReader(); fr.onload = function(){ res(fr.result); }; fr.readAsDataURL(b); }); }).catch(function(){ return null; });
      return logoPromise;
    }
    function makePdf(r){
      return Promise.all([loadJsPdf(), loadLogo()]).then(function(res){
        var logo = res[1], doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
        var W = 612, H = 792, M = 42, y = 0, page = 1;
        var NAVY = [27,43,75], GOLD = [179,145,79], INK = [28,36,51], MUTED = [86,96,116], LIGHT = [243,245,248], GREEN = [47,107,74], RED = [168,64,44];
        function setC(c){ doc.setTextColor(c[0], c[1], c[2]); }
        function fill(c){ doc.setFillColor(c[0], c[1], c[2]); }
        function line(c, x1, y1, x2, y2, w){ doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(w || 0.7); doc.line(x1, y1, x2, y2); }
        function footer(){
          line([220,224,232], M, H - 52, W - M, H - 52, 0.6);
          doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); setC(MUTED);
          var t = doc.splitTextToSize("Illustration only based on the numbers you entered and the assumptions shown. Not an offer, rate lock, loan approval or commitment to lend; actual terms, costs and returns will differ. Business-purpose loans on investment property only. Not tax, legal or investment advice. BridgePoint Lending.", W - 2 * M - 40);
          doc.text(t, M, H - 42); doc.text("Page " + page, W - M, H - 42, { align: "right" });
        }
        function header(){
          fill(NAVY); doc.rect(0, 0, W, 6, "F"); fill(GOLD); doc.rect(0, 6, W, 2, "F");
          if (logo) { try { doc.addImage(logo, "PNG", M, 24, 140, 38, "bplogo", "FAST"); } catch (x) {} }
          doc.setFont("helvetica", "bold"); doc.setFontSize(8); setC(GOLD); doc.text("DEAL ANALYSIS", W - M, 36, { align: "right" });
          doc.setFont("helvetica", "normal"); doc.setFontSize(8); setC(MUTED); doc.text(new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), W - M, 48, { align: "right" });
          y = 84;
        }
        function need(h){ if (y + h > H - 64){ footer(); doc.addPage(); page++; header(); } }
        function h2(t){ need(40); doc.setFont("times", "bold"); doc.setFontSize(14); setC(NAVY); doc.text(t, M, y); y += 6; line(GOLD, M, y, M + 36, y, 1.6); y += 16; }
        function para(t, size, color, indent, gap){
          doc.setFont("helvetica", "normal"); doc.setFontSize(size || 9.5); setC(color || INK);
          var lines = doc.splitTextToSize(t, W - 2 * M - (indent || 0));
          need(lines.length * (size || 9.5) * 1.35 + 4); doc.text(lines, M + (indent || 0), y); y += lines.length * (size || 9.5) * 1.35 + (gap === undefined ? 4 : gap);
        }
        function table(rows, widths, opts){
          opts = opts || {}; var rowH = 19, x;
          rows.forEach(function(row, ri){
            need(rowH + 2);
            if (ri === 0){ fill(NAVY); doc.rect(M, y - 13, W - 2 * M, rowH, "F"); } else if (ri % 2 === 0){ fill(LIGHT); doc.rect(M, y - 13, W - 2 * M, rowH, "F"); }
            x = M + 8;
            row.forEach(function(cell, ci){
              doc.setFont("helvetica", ri === 0 || (ci === 0 && opts.boldFirst) ? "bold" : "normal"); doc.setFontSize(9);
              var col = ri === 0 ? [255,255,255] : INK;
              if (ri > 0 && ci > 0 && /^-\$|^-\d/.test(String(cell))) col = RED;
              if (ri > 0 && ci === row.length - 1 && opts.highlightLast) { doc.setFont("helvetica", "bold"); if (col === INK) col = GREEN; }
              setC(col);
              if (ci === 0) doc.text(String(cell), x, y); else doc.text(String(cell), x + widths[ci] - 16, y, { align: "right" });
              x += widths[ci];
            });
            y += rowH;
          });
          y += 8;
        }
        header();
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); setC(GOLD); doc.text(r.label.toUpperCase(), M, y); y += 20;
        doc.setFont("times", "bold"); doc.setFontSize(21); setC(NAVY);
        var hl = doc.splitTextToSize(r.headline, W - 2 * M); doc.text(hl, M, y); y += hl.length * 25 + 4;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9); setC(MUTED); doc.text((r.state ? "Property state: " + r.state + "   |   " : "") + "Credit: " + r.credit + "   |   Experience: " + r.experience, M, y); y += 20;
        var bw = (W - 2 * M - 3 * 10) / 4, k, bx;
        for (k = 0; k < 4; k++){
          bx = M + k * (bw + 10); fill(LIGHT); doc.roundedRect(bx, y, bw, 66, 4, 4, "F"); fill(k === 0 ? GOLD : NAVY); doc.rect(bx, y, 3, 66, "F");
          doc.setFont("helvetica", "normal"); doc.setFontSize(7.6); setC(MUTED); doc.text(doc.splitTextToSize(r.kpis[k][0], bw - 18), bx + 12, y + 16);
          doc.setFont("times", "bold"); doc.setFontSize(15); setC(/^-\$|^-\d/.test(r.kpis[k][1]) ? RED : NAVY); doc.text(r.kpis[k][1], bx + 12, y + 40);
          doc.setFont("helvetica", "normal"); doc.setFontSize(7.4); setC(MUTED); doc.text(doc.splitTextToSize(r.kpis[k][2], bw - 18), bx + 12, y + 55);
        }
        y += 90;
        if (r.pro){
          var pr = r.pro, ps = pr.subject || {};
          h2("Property & market data");
          para([ps.address, ps.beds ? ps.beds + " bd" : null, ps.baths ? ps.baths + " ba" : null, ps.sqft ? Number(ps.sqft).toLocaleString("en-US") + " sq ft" : null, ps.yearBuilt ? "built " + ps.yearBuilt : null].filter(Boolean).join("   |   "), 9.5, INK, 0, 6);
          if (pr.verdict) para(pr.verdict.text, 9.5, pr.verdict.tone === "warn" ? RED : GREEN, 0, 8);
          if (pr.soldComps && pr.soldComps.length){
            para("Closed sales nearby, last 12 months (public record)", 8.5, MUTED, 0, 4);
            var pw = [(W - 2 * M) * 0.38, (W - 2 * M) * 0.14, (W - 2 * M) * 0.17, (W - 2 * M) * 0.16, (W - 2 * M) * 0.15];
            table([["Address", "Sold", "Price", "$/sq ft", "Miles"]].concat(pr.soldComps.slice(0, 6).map(function(c){ return [String(c.address).replace(/, [A-Z]{2} \d{5}$/, ""), String(c.soldDate).slice(0, 7), usd(c.price), usd(c.ppsf), c.distance != null ? c.distance.toFixed(2) : "-"]; })), pw);
          }
          if (pr.valueEstimate && pr.valueEstimate.price) para("Automated value estimate: " + usd(pr.valueEstimate.price) + " (range " + usd(pr.valueEstimate.low) + " to " + usd(pr.valueEstimate.high) + ")." + (pr.rentEstimate && pr.rentEstimate.rent ? " Estimated market rent: " + usd(pr.rentEstimate.rent) + "/month (" + usd(pr.rentEstimate.low) + " to " + usd(pr.rentEstimate.high) + ")." : ""), 9, INK, 0, 4);
          if (pr.market && pr.market.medianPrice) para("Local market (" + (pr.market.zip || "") + "): median sale price " + usd(pr.market.medianPrice) + (pr.market.medianDaysOnMarket ? ", median " + Math.round(pr.market.medianDaysOnMarket) + " days on market" : "") + ".", 9, INK, 0, 4);
          if (pr.rehab) para("Rehab estimate: " + rehabLine(pr.rehab), 8.5, MUTED, 0, 4);
          (pr.warnings || []).forEach(function(w){ para(w, 8.5, RED, 0, 4); });
          y += 4;
        }
        h2("Financed vs. all-cash");
        var cw = [(W - 2 * M) * 0.46, (W - 2 * M) * 0.27, (W - 2 * M) * 0.27];
        table(r.table, cw, { highlightLast: true });
        // grouped bar chart
        need(130); doc.setFont("helvetica", "bold"); doc.setFontSize(9); setC(NAVY); doc.text(r.chart.title, M, y); y += 14;
        var maxV = 0.0001; r.chart.a.concat(r.chart.b).forEach(function(v){ if (v > maxV) maxV = v; });
        var cx = M + 92, cwid = W - 2 * M - 92 - 130, n;
        for (n = 0; n < r.chart.labels.length; n++){
          doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); setC(INK); doc.text(r.chart.labels[n], M, y + 17);
          var wa = Math.max(3, Math.max(r.chart.a[n], 0) / maxV * cwid), wb = Math.max(3, Math.max(r.chart.b[n], 0) / maxV * cwid);
          fill([160,170,190]); doc.rect(cx, y + 2, wa, 13, "F"); fill(GOLD); doc.rect(cx, y + 18, wb, 13, "F");
          doc.setFontSize(8); setC(MUTED); doc.text("All cash " + r.chart.fmt(r.chart.a[n]), cx + wa + 5, y + 12); setC(NAVY); doc.setFont("helvetica", "bold"); doc.text("Financed " + r.chart.fmt(r.chart.b[n]), cx + wb + 5, y + 28);
          y += 42;
        }
        y += 6;
        h2("Why financing makes sense on this deal");
        r.insights.forEach(function(t){
          need(40); fill(GOLD); doc.circle(M + 4, y - 3, 2.2, "F"); para(t, 9.5, INK, 14, 5);
        });
        y += 4;
        need(150); h2("Stress test");
        para(r.stressNote + ".", 8.5, MUTED, 0, 6);
        var srows = r.stressKind === "rental"
          ? [["If this happens…", "Cash flow / month", "DSCR"]].concat(r.stress.map(function(s){ return [s.name, usd(s.cf), s.dscr.toFixed(2)]; }))
          : [["If this happens…", "Net profit", "Return on cash"]].concat(r.stress.map(function(s){ return [s.name, usd(s.profit), pct(s.roi, 0)]; }));
        table(srows, cw);
        h2("Your inputs & assumptions");
        r.inputs.forEach(function(row){ need(14); doc.setFont("helvetica", "normal"); doc.setFontSize(9); setC(MUTED); doc.text(row[0], M, y); setC(INK); doc.setFont("helvetica", "bold"); doc.text(row[1], M + 220, y); y += 14; });
        y += 4; r.assumptions.forEach(function(t){ para(t, 8.3, MUTED, 0, 3); });
        y += 8; need(104);
        fill(NAVY); doc.roundedRect(M, y, W - 2 * M, 92, 5, 5, "F"); fill(GOLD); doc.rect(M, y, 4, 92, "F");
        doc.setFont("times", "bold"); doc.setFontSize(15); setC([255,255,255]); doc.text("Ready to put these numbers to work?", M + 20, y + 28);
        doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); setC([215,222,235]);
        doc.text(doc.splitTextToSize("Get exact terms from a loan officer who answers the phone, or start your application online in minutes.", W - 2 * M - 40), M + 20, y + 46);
        doc.setFont("helvetica", "bold"); doc.setFontSize(10); setC([225,196,130]);
        doc.text("Apply: bplending.com/apply     Quote: bplending.com/get-quote     Call or text: (850) 279-8588", M + 20, y + 74);
        footer();
        var fname = "BridgePoint-" + r.label.replace(/[^A-Za-z]+/g, "-") + "-Deal-Analysis.pdf";
        return { doc: doc, fname: fname };
      }).catch(function(){ var e = document.getElementById("az-ferr"); if (e) e.textContent = "We couldn't build the PDF just now. Please try again."; });
    }

    renderFields();
    window.BPAnalyzer = { calcFlip: calcFlip, calcRental: calcRental, calcBridge: calcBridge, calcBuild: calcBuild, buildReport: buildReport };
  }

  var root = document.getElementById("analyzer");
  if (root) init(root);
})();
