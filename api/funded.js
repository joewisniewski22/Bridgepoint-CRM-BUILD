// Server-rendered "Recently funded" pages for bplending.com, so each approved deal is real HTML that Google can index.
//   /funded/            -> list of approved deals
//   /funded/<slug>/     -> one deal
//   /funded-sitemap.xml -> sitemap of approved deals
//   /api/funded?format=json&limit=6 -> safe public JSON used by the home page strip
// Only rows with status=approved AND borrower_ok=true are readable (Postgres RLS), and no borrower name or exact
// address is ever stored in this table. Page chrome (header/footer) comes from the static /funded-shell/ page.
const SUPABASE_URL = "https://idzkigmvovehjpapatxv.supabase.co";
const SUPABASE_KEY = "sb_publishable_zn3PaFZPVrsUq0LEWxbDJg_k1TUlzVd"; // publishable (anon) key; RLS is the security boundary
const ORIGIN = "https://bplending.com";

const STATES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"Washington, D.C.",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};
const NO_LEND = ["NV","ND","SD","VT","UT","OR"];
const PROGRAM_PAGE = { "DSCR": "/dscr-loans/", "Fix & Flip": "/fix-and-flip-loans/", "Bridge": "/bridge-loans/", "Ground Up Construction": "/ground-up-construction-loans/", "Portfolio/Blanket": "/portfolio-loans/" };

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Math.round(Number(n)).toLocaleString("en-US");
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dateLong = (d) => { try { return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return ""; } };

async function getDeals(extra) {
  const url = SUPABASE_URL + "/rest/v1/funded_deals?select=slug,city,state,property_type,loan_type,loan_amount,funded_date,headline,summary,image_url,show_amount,approved_at&status=eq.approved&borrower_ok=eq.true&slug=not.is.null&order=funded_date.desc.nullslast" + (extra || "");
  const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } });
  if (!r.ok) throw new Error("db " + r.status);
  return r.json();
}

async function getShell(host) {
  const r = await fetch("https://" + host + "/funded-shell/", { headers: { "x-shell": "1" } });
  if (!r.ok) throw new Error("shell " + r.status);
  return r.text();
}

function place(d) { return [d.city, d.state].filter(Boolean).join(", "); }
function card(d) {
  const amt = d.show_amount && d.loan_amount ? "<span class=\"fd-amt\">" + money(d.loan_amount) + "</span>" : "";
  const img = d.image_url ? "<img class=\"fd-img\" loading=\"lazy\" alt=\"" + esc("Funded " + d.loan_type + " loan property in " + place(d)) + "\" src=\"" + esc(d.image_url) + "\">" : "";
  return "<a class=\"fd-card\" href=\"/funded/" + esc(d.slug) + "/\">" + img + "<div class=\"fd-body\"><div class=\"cat\">" + esc(d.loan_type || "Loan") + " &middot; " + esc(dateLong(d.funded_date)) + "</div><h3>" + esc(d.headline || (d.loan_type + " loan in " + place(d))) + "</h3><p>" + esc(place(d)) + (d.property_type ? " &middot; " + esc(d.property_type) : "") + "</p>" + amt + "</div></a>";
}

function render(shell, o) {
  let h = shell;
  h = h.replace(/<title>[\s\S]*?<\/title>/, "<title>" + esc(o.title) + "</title>");
  h = h.replace(/<meta name="description" content="[^"]*">/, "<meta name=\"description\" content=\"" + esc(o.desc) + "\">");
  h = h.replace(/<link rel="canonical" href="[^"]*">/, "<link rel=\"canonical\" href=\"" + ORIGIN + o.path + "\">");
  h = h.replace(/<meta property="og:title" content="[^"]*">/, "<meta property=\"og:title\" content=\"" + esc(o.title) + "\">");
  h = h.replace(/<meta property="og:description" content="[^"]*">/, "<meta property=\"og:description\" content=\"" + esc(o.desc) + "\">");
  h = h.replace(/<meta property="og:url" content="[^"]*">/, "<meta property=\"og:url\" content=\"" + ORIGIN + o.path + "\">");
  h = h.replace(/<meta name="robots"[^>]*>\s*/, o.noindex ? "<meta name=\"robots\" content=\"noindex,follow\">\n" : "");
  h = h.replace("@@CONTENT@@", o.content);
  return h;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const host = req.headers["x-forwarded-host"] || req.headers.host;

    if (q.format === "json") {
      const limit = Math.min(parseInt(q.limit, 10) || 6, 24);
      const rows = await getDeals("&limit=" + limit);
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).json(rows.map((d) => ({ slug: d.slug, city: d.city, state: d.state, propertyType: d.property_type, loanType: d.loan_type, loanAmount: d.show_amount ? d.loan_amount : null, fundedDate: d.funded_date, headline: d.headline, imageUrl: d.image_url })));
    }

    if (q.view === "sitemap") {
      const rows = await getDeals();
      const xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
        (rows.length ? "  <url><loc>" + ORIGIN + "/funded/</loc><priority>0.7</priority></url>\n" : "") +
        rows.map((d) => "  <url><loc>" + ORIGIN + "/funded/" + esc(d.slug) + "/</loc><lastmod>" + esc((d.approved_at || d.funded_date || "").slice(0, 10)) + "</lastmod><priority>0.6</priority></url>").join("\n") + "\n</urlset>\n";
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).send(xml);
    }

    const shell = await getShell(host);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");

    if (q.slug) {
      const rows = await getDeals("&slug=eq." + encodeURIComponent(String(q.slug)));
      const d = rows[0];
      if (!d) {
        const html = render(shell, { title: "Funded deal not found | BridgePoint Lending", desc: "This funded deal could not be found.", path: "/funded/", noindex: true,
          content: "<section class=\"phead\"><div class=\"wrap\"><h1>That deal isn&rsquo;t available</h1><p>See our other recently funded loans.</p></div></section><section class=\"sec\"><div class=\"wrap\"><a class=\"btn btn-gold\" href=\"/funded/\">Recently funded loans</a></div></section>" });
        return res.status(404).send(html);
      }
      const where = place(d);
      const stateName = STATES[d.state] || d.state || "";
      const lendOk = d.state && NO_LEND.indexOf(d.state) === -1;
      const stateLink = lendOk && stateName ? "<a href=\"/locations/" + slugify(stateName) + "/\">" + esc(stateName) + " investor loans</a>" : "";
      const programLink = PROGRAM_PAGE[d.loan_type] ? "<a href=\"" + PROGRAM_PAGE[d.loan_type] + "\">" + esc(d.loan_type) + " loans</a>" : "<a href=\"/loan-programs/\">All loan programs</a>";
      const facts = [
        ["Location", where], ["Property type", d.property_type], ["Loan program", d.loan_type],
        ["Loan amount", d.show_amount && d.loan_amount ? money(d.loan_amount) : null], ["Funded", dateLong(d.funded_date)],
      ].filter((f) => f[1]).map((f) => "<tr><td>" + esc(f[0]) + "</td><td><b>" + esc(f[1]) + "</b></td></tr>").join("");
      const img = d.image_url ? "<img class=\"fd-hero\" alt=\"" + esc("Property funded with a " + d.loan_type + " loan in " + where) + "\" src=\"" + esc(d.image_url) + "\">" : "";
      const paras = String(d.summary || "").split(/\n{2,}/).filter(Boolean).map((p) => "<p>" + esc(p) + "</p>").join("");
      const title = (d.headline || (d.loan_type + " loan funded in " + where)) + " | BridgePoint Lending";
      const desc = (d.summary || ("BridgePoint Lending funded a " + d.loan_type + " loan in " + where + ".")).replace(/\s+/g, " ").slice(0, 155);
      const ld = { "@context": "https://schema.org", "@type": "Article", headline: d.headline || (d.loan_type + " loan funded in " + where), datePublished: d.approved_at || d.funded_date, dateModified: d.approved_at || d.funded_date, image: d.image_url || undefined, author: { "@type": "Organization", name: "BridgePoint Lending" }, publisher: { "@type": "Organization", name: "BridgePoint Lending", logo: { "@type": "ImageObject", url: ORIGIN + "/static/logo-wide.png" } }, mainEntityOfPage: ORIGIN + "/funded/" + d.slug + "/" };
      const content = "<section class=\"phead\"><div class=\"wrap\"><div class=\"meta\" style=\"color:#c9d3e6\"><a href=\"/funded/\" style=\"color:#c9d3e6\">Recently funded</a> &rsaquo; " + esc(where) + "</div><h1>" + esc(d.headline || (d.loan_type + " loan funded in " + where)) + "</h1><p>" + esc(d.loan_type || "") + (d.property_type ? " &middot; " + esc(d.property_type) : "") + " &middot; " + esc(where) + "</p></div></section>" +
        "<section class=\"sec\"><div class=\"wrap two\"><article class=\"prose\">" + img + paras + "<table>" + facts + "</table>" +
        "<p>" + programLink + (stateLink ? " &middot; " + stateLink : "") + "</p>" +
        "<p class=\"meta\">Every loan is different. Rates, terms and availability vary by property, borrower and program, and all loans are subject to underwriting and approval. Business-purpose loans only. Details shown with the borrower&rsquo;s permission.</p>" +
        "<script type=\"application/ld+json\">" + JSON.stringify(ld).replace(/</g, "\\u003c") + "</script></article>" +
        "<aside class=\"panel\"><h3>Have a similar deal?</h3><p>Get a ballpark in about a minute, then exact numbers from a loan officer.</p><a class=\"btn btn-gold\" href=\"/get-quote/\">Get a Quote</a><p style=\"margin-top:16px\"><a href=\"/estimate/\">Rate &amp; loan estimator</a><br><a href=\"/funded/\">More funded loans</a></p></aside></div></section>";
      return res.status(200).send(render(shell, { title, desc, path: "/funded/" + d.slug + "/", content }));
    }

    const rows = await getDeals();
    if (!rows.length) {
      return res.status(200).send(render(shell, { title: "Recently Funded Loans | BridgePoint Lending", desc: "Real estate investor loans funded by BridgePoint Lending.", path: "/funded/", noindex: true,
        content: "<section class=\"phead\"><div class=\"wrap\"><h1>Recently funded loans</h1><p>Check back soon.</p></div></section><section class=\"sec\"><div class=\"wrap\"><a class=\"btn btn-gold\" href=\"/get-quote/\">Get a Quote</a></div></section>" }));
    }
    const content = "<section class=\"phead\"><div class=\"wrap\"><h1>Recently funded loans</h1><p>Real deals we&rsquo;ve funded for real estate investors, shared with the borrower&rsquo;s permission.</p></div></section>" +
      "<section class=\"sec\"><div class=\"wrap\"><div class=\"fd-grid\">" + rows.map(card).join("") + "</div></div></section>" +
      "<section class=\"band\"><div class=\"wrap\"><h2>Your deal could be next</h2><p>Get a ballpark estimate in about a minute, then talk to a loan officer.</p><a class=\"btn btn-gold\" href=\"/get-quote/\">Get a Quote</a></div></section>";
    return res.status(200).send(render(shell, { title: "Recently Funded Real Estate Investor Loans | BridgePoint Lending", desc: "See real estate investor loans BridgePoint Lending has funded: fix and flip, bridge, construction, DSCR and more.", path: "/funded/", content }));
  } catch (e) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(500).send("Temporarily unavailable");
  }
};
