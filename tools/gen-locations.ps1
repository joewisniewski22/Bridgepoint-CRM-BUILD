# One-off generator for site-src/locations/** (hub + state pages). Edit the table, re-run, then run build-site.ps1.
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root "site-src\locations"
$states = @(
  @{ slug="florida";        name="Florida";        abbr="FL"; metros="Tampa, Orlando, Jacksonville, Miami, Fort Lauderdale, Tallahassee, Pensacola"; note="Florida has one of the most active investor markets in the country, with strong long-term and short-term rental demand and a steady flow of renovation projects. Insurance costs can be a big factor in how a rental pencils out, which is exactly what a DSCR calculation captures." },
  @{ slug="texas";          name="Texas";          abbr="TX"; metros="Houston, Dallas–Fort Worth, San Antonio, Austin, El Paso"; note="Texas investors benefit from a large, growing rental market. Property taxes are higher than in many states, so it is worth running the full payment — taxes and insurance included — before assuming a rental will qualify." },
  @{ slug="georgia";        name="Georgia";        abbr="GA"; metros="Atlanta, Savannah, Augusta, Macon, Columbus"; note="Metro Atlanta and its surrounding suburbs have drawn investors for years thanks to steady rental demand and a deep supply of single-family and small multifamily properties." },
  @{ slug="north-carolina"; name="North Carolina"; abbr="NC"; metros="Charlotte, Raleigh, Greensboro, Durham, Wilmington, Asheville"; note="Population growth in the Carolinas has kept rental demand strong in Charlotte, the Triangle and coastal markets, creating opportunities for both buy-and-hold investors and flippers." },
  @{ slug="south-carolina"; name="South Carolina"; abbr="SC"; metros="Charleston, Greenville, Columbia, Myrtle Beach"; note="From the Lowcountry to the Upstate, South Carolina combines coastal vacation-rental activity with growing inland rental markets." },
  @{ slug="tennessee";      name="Tennessee";      abbr="TN"; metros="Nashville, Memphis, Knoxville, Chattanooga"; note="Tennessee's metros attract both cash-flow investors and flippers, with a mix of price points from Memphis single-family rentals to Nashville renovation projects." },
  @{ slug="alabama";        name="Alabama";        abbr="AL"; metros="Birmingham, Huntsville, Mobile, Montgomery"; note="Alabama offers lower price points that can produce strong rent-to-price ratios, with Huntsville and Birmingham standing out for demand." },
  @{ slug="ohio";           name="Ohio";           abbr="OH"; metros="Columbus, Cleveland, Cincinnati, Dayton, Toledo"; note="Ohio is a long-time favorite for cash-flow-focused investors, where purchase prices are modest relative to rents in many neighborhoods." },
  @{ slug="pennsylvania";   name="Pennsylvania";   abbr="PA"; metros="Philadelphia, Pittsburgh, Allentown, Harrisburg, Reading, Scranton"; note="Pennsylvania has a deep supply of older single-family homes and small multifamily buildings, which makes for plenty of renovation and rental opportunities." },
  @{ slug="new-jersey";     name="New Jersey";     abbr="NJ"; metros="Newark, Jersey City, Trenton, Camden, Atlantic City"; note="New Jersey's higher property values and strong demand for 2–4 unit properties make careful numbers especially important for both rentals and flips." },
  @{ slug="maryland";       name="Maryland";       abbr="MD"; metros="Baltimore, Frederick, Rockville, Annapolis"; note="Maryland combines Baltimore-area investment properties with the Washington, D.C. suburbs. Availability and terms can vary by property and area, so we confirm each deal individually." },
  @{ slug="arizona";        name="Arizona";        abbr="AZ"; metros="Phoenix, Mesa, Tucson, Scottsdale, Chandler"; note="Arizona's fast-growing metros have supported both rental and renovation activity, with single-family rentals especially popular." }
)
New-Item -ItemType Directory -Force -Path $dir | Out-Null
foreach ($s in $states) {
  $d = Join-Path $dir $s.slug
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $n = $s.name; $a = $s.abbr
  $html = @"
---
title: Real Estate Investor Loans in $n | DSCR, Fix & Flip, Bridge | BridgePoint Lending
description: Investor loans in $n ($a): DSCR rental loans, fix and flip, bridge, ground-up construction and portfolio loans. See a ballpark estimate in a minute.
canon: /locations/$($s.slug)/
priority: 0.7
---
<section class="hero"><div class="wrap grid">
  <div>
    <div class="eyebrow">$n investor loans</div>
    <h1>Real estate investor loans in <em>$n.</em></h1>
    <p class="lead">DSCR rentals, fix &amp; flips, bridge and construction financing for investment properties in $n. See a ballpark estimate, then get exact numbers from a loan officer.</p>
    <ul class="ticks"><li>Business-purpose loans on $n investment property</li><li>DSCR loans qualify on the rent, not your tax returns</li><li>Close in your LLC</li></ul>
  </div>
  <div class="qw" data-qw data-program="auto" data-title="$n loan estimate" data-sub="About a minute. See a ballpark, then get exact numbers."></div>
</div></section>
<section class="sec"><div class="wrap"><div class="crumbs"><a href="{{BASE}}/">Home</a> › <a href="{{BASE}}/locations/">Locations</a> › $n</div>
  <div class="prose">
    <h2>Financing for $n investors</h2>
    <p>$($s.note)</p>
    <h2>Loan programs available for $n properties</h2>
    <ul>
      <li><a href="{{BASE}}/dscr-loans/">DSCR rental loans</a> — qualify on the property’s rent</li>
      <li><a href="{{BASE}}/fix-and-flip-loans/">Fix and flip loans</a> — purchase plus rehab funding</li>
      <li><a href="{{BASE}}/bridge-loans/">Bridge loans</a> — fast short-term financing</li>
      <li><a href="{{BASE}}/ground-up-construction-loans/">Ground-up construction loans</a></li>
      <li><a href="{{BASE}}/portfolio-loans/">Portfolio and blanket loans</a></li>
    </ul>
    <h2>Markets we see investors active in</h2>
    <p>$($s.metros), and surrounding areas. If your property is somewhere else in $n, send it over — we will confirm quickly.</p>
    <p class="note">Availability, terms and pricing vary by property, borrower and program. Business-purpose loans only.</p>
    <h2>Common questions about $n investor loans</h2>
  </div>
  <div class="faq" style="margin-top:6px">
    <details><summary>Do you offer DSCR loans in $n?</summary><p>Yes, on qualifying investment properties in $n. Run the <a href="{{BASE}}/dscr-calculator/">DSCR calculator</a> or get an estimate to see where your property lands.</p></details>
    <details><summary>Can I buy in an LLC in $n?</summary><p>Most investors close in an LLC or similar entity. Your loan officer will walk you through the entity documents.</p></details>
    <details><summary>Is this for a primary residence?</summary><p>No. BridgePoint makes business-purpose loans on investment properties only.</p></details>
  </div>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do you offer DSCR loans in $n?","acceptedAnswer":{"@type":"Answer","text":"Yes, on qualifying investment properties in $n."}},{"@type":"Question","name":"Can I buy in an LLC in $n?","acceptedAnswer":{"@type":"Answer","text":"Most investors close in an LLC or similar entity."}}]}</script>
</div></section>
<section class="band"><div class="wrap"><h2>Have a $n deal?</h2><p>Get a ballpark in about a minute, then exact numbers from a loan officer.</p><a class="btn btn-gold" href="{{BASE}}/get-quote/">Get My $n Estimate</a></div></section>
"@
  [IO.File]::WriteAllText((Join-Path $d "index.html"), $html, (New-Object Text.UTF8Encoding($false)))
}
$cards = ($states | ForEach-Object { "<a class=""pill"" href=""{{BASE}}/locations/$($_.slug)/"">$($_.name)</a>" }) -join "`n  "
$hub = @"
---
title: Investor Loans by State | BridgePoint Lending
description: BridgePoint Lending makes DSCR, fix and flip, bridge, construction and portfolio loans to real estate investors across most of the U.S. Find your state.
canon: /locations/
priority: 0.8
---
<section class="phead"><div class="wrap"><h1>Investor loans by state</h1><p>We lend on investment properties across most of the U.S. Start with your state, or send us any property and we will confirm.</p></div></section>
<section class="sec"><div class="wrap"><div class="pills">
  $cards
</div>
<div class="prose" style="margin-top:34px"><p>Don’t see your state? We lend in many more than we list here. <a href="{{BASE}}/get-quote/">Get a quote</a> or call <a href="tel:+18502798588">(850) 279-8588</a> and we will tell you what is possible for your property.</p></div></div></section>
"@
[IO.File]::WriteAllText((Join-Path $dir "index.html"), $hub, (New-Object Text.UTF8Encoding($false)))
Write-Output ("Generated " + $states.Count + " state pages + hub")
