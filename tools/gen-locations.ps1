# Generates site-src/locations/** (hub + one page per state we lend in) and keeps the state lists in
# quote.js and public-estimate in sync. Edit tools/states.ps1 (copy) or tools/excluded-states.txt (who we skip),
# run this, then run build-site.ps1 (preview) and build-site.ps1 -Prod.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "states.ps1")
$excluded = @((Get-Content (Join-Path $PSScriptRoot "excluded-states.txt") -Raw).Trim() -split "\s+" | Where-Object { $_ })
$served = @($AllStates | Where-Object { $excluded -notcontains $_.abbr })
$dir = Join-Path $root "site-src\locations"
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)

foreach ($s in $served) {
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
  <div class="qw" data-qw data-program="auto" data-state="$a" data-title="$n loan estimate" data-sub="About a minute. See a ballpark, then get exact numbers."></div>
</div></section>
<section class="sec"><div class="wrap"><div class="crumbs"><a href="{{BASE}}/">Home</a> &rsaquo; <a href="{{BASE}}/locations/">Locations</a> &rsaquo; $n</div>
  <div class="prose">
    <h2>Financing for $n investors</h2>
    <p>$($s.note)</p>
    <h2>Loan programs available for $n properties</h2>
    <ul>
      <li><a href="{{BASE}}/dscr-loans/">DSCR rental loans</a> &mdash; qualify on the property&rsquo;s rent</li>
      <li><a href="{{BASE}}/fix-and-flip-loans/">Fix and flip loans</a> &mdash; purchase plus rehab funding</li>
      <li><a href="{{BASE}}/bridge-loans/">Bridge loans</a> &mdash; fast short-term financing</li>
      <li><a href="{{BASE}}/ground-up-construction-loans/">Ground-up construction loans</a></li>
      <li><a href="{{BASE}}/portfolio-loans/">Portfolio and blanket loans</a></li>
    </ul>
    <h2>Markets we see investors active in</h2>
    <p>$($s.metros), and surrounding areas. If your property is somewhere else in $n, send it over &mdash; we will confirm quickly.</p>
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
  [IO.File]::WriteAllText((Join-Path $d "index.html"), $html, $utf8)
}

$cards = ($served | ForEach-Object { "<a class=""pill"" href=""{{BASE}}/locations/$($_.slug)/"">$($_.name)</a>" }) -join "`n  "
$count = @($served | Where-Object { $_.abbr -ne "DC" }).Count
$hub = @"
---
title: Investor Loans by State | BridgePoint Lending
description: BridgePoint Lending makes DSCR, fix and flip, bridge, construction and portfolio loans to real estate investors in most of the U.S. Find your state.
canon: /locations/
priority: 0.8
---
<section class="phead"><div class="wrap"><h1>Investor loans by state</h1><p>We lend on investment properties in {{STATE_COUNT}} states and D.C. (we do not currently lend in {{EXCLUDED_NAMES}}). Pick your state, or send us any property and we will confirm.</p></div></section>
<section class="sec"><div class="wrap"><div class="pills">
  $cards
</div>
<div class="prose" style="margin-top:34px"><p>Not sure about a location? <a href="{{BASE}}/get-quote/">Get a quote</a> or call <a href="tel:+18502798588">(850) 279-8588</a> and we will tell you what is possible for your property.</p></div></div></section>
"@
[IO.File]::WriteAllText((Join-Path $dir "index.html"), $hub, $utf8)

# Keep quote widget and public estimator state lists in sync with the served list.
$list = ($served | ForEach-Object { $_.abbr }) -join " "
$qj = Join-Path $root "site-src\static\quote.js"
$t = [IO.File]::ReadAllText($qj)
$t = [regex]::Replace($t, 'var STATES = "[^"]*"\.split\(" "\);', 'var STATES = "' + $list + '".split(" ");')
[IO.File]::WriteAllText($qj, $t, $utf8)
$pe = Join-Path $root "supabase\functions\public-estimate\index.ts"
$t = [IO.File]::ReadAllText($pe)
$arr = ($served | ForEach-Object { '"' + $_.abbr + '"' }) -join ","
$t = [regex]::Replace($t, 'const STATES = \[[^\]]*\];', 'const STATES = [' + $arr + '];')
[IO.File]::WriteAllText($pe, $t, $utf8)
Write-Output ("Generated " + $served.Count + " state pages + hub; excluded: " + ($excluded -join ", "))
