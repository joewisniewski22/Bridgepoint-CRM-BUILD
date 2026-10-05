# Builds the bplending.com marketing site: site-src/**/*.html (front matter + body) -> site/**
#   -Base ""      production: pages are served from the domain root (vercel.json rewrites bplending.com -> /site)
#   -Base "/site" preview:    pages live under https://<crm-host>/site/ so every internal link is prefixed\n#   -OutName site-prod        output folder (production build is served for bplending.com via vercel.json)
# Run:  powershell -File tools/build-site.ps1 -Base "/site"      (preview)
#       powershell -File tools/build-site.ps1 -Base ""           (production)
param([switch]$Prod)
$ErrorActionPreference = "Stop"
# Preview (default): served from /site on the CRM host. -Prod: served from the domain root for bplending.com (via vercel.json routes).
if ($Prod) { $Base = ""; $OutName = "site-prod" } else { $Base = "/site"; $OutName = "site" }
$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $root "site-src"
$outDir = Join-Path $root $OutName
$domain = "https://bplending.com"
. (Join-Path $PSScriptRoot "states.ps1")
$exAbbr = @((Get-Content (Join-Path $PSScriptRoot "excluded-states.txt") -Raw).Trim() -split "\s+" | Where-Object { $_ })
$exList = @($AllStates | Where-Object { $exAbbr -contains $_.abbr } | ForEach-Object { $_.name })
$exNames = if ($exList.Count -gt 1) { ($exList[0..($exList.Count-2)] -join ", ") + " or " + $exList[-1] } else { $exList -join "" }
$stCount = @($AllStates | Where-Object { $exAbbr -notcontains $_.abbr -and $_.abbr -ne "DC" }).Count
# Optional tracking / verification tags, filled from tools/site-config.json (blank = nothing is injected).
$cfg = Get-Content (Join-Path $PSScriptRoot "site-config.json") -Raw | ConvertFrom-Json
$tracking = ""
if ($cfg.googleSiteVerification) { $tracking += '<meta name="google-site-verification" content="' + $cfg.googleSiteVerification + '">' + "`n" }
if ($cfg.bingSiteVerification) { $tracking += '<meta name="msvalidate.01" content="' + $cfg.bingSiteVerification + '">' + "`n" }
if ($cfg.ga4Id) {
  $tracking += '<script async src="https://www.googletagmanager.com/gtag/js?id=' + $cfg.ga4Id + '"></script>' + "`n"
  $tracking += "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','" + $cfg.ga4Id + "');</script>`n"
}
if ($cfg.metaPixelId) {
  $px = @'
<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','@@PX@@');fbq('track','PageView');</script>
'@
  $tracking += $px.Replace('@@PX@@', $cfg.metaPixelId)
}
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null

$head = @'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<meta name="description" content="{{DESC}}">
<link rel="canonical" href="{{DOMAIN}}{{CANON}}">
{{ROBOTS}}
<meta property="og:site_name" content="BridgePoint Lending">
<meta property="og:type" content="website">
<meta property="og:title" content="{{TITLE}}">
<meta property="og:description" content="{{DESC}}">
<meta property="og:url" content="{{DOMAIN}}{{CANON}}">
<meta property="og:image" content="{{DOMAIN}}{{OGIMG}}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{{BASE}}/static/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{{BASE}}/static/site.css">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FinancialService","name":"BridgePoint Lending","url":"https://bplending.com","logo":"https://bplending.com/static/logo-wide.png","telephone":"+1-850-279-8588","email":"info@bplending.com","areaServed":"US","description":"Private lender for real estate investors: DSCR rental loans, fix and flip, bridge, ground-up construction and portfolio loans. Business-purpose loans only."}</script>
<script>window.BP_BASE="{{BASE}}";</script>
{{TRACKING}}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
  <a class="brand" href="{{BASE}}/" aria-label="BridgePoint Lending home"><img src="{{BASE}}/static/logo-wide.png" alt="BridgePoint Lending — real estate financing solutions" width="170" height="46"></a>
  <button class="menu-btn" aria-label="Menu" aria-expanded="false" aria-controls="site-nav">☰</button>
  <nav class="nav" id="site-nav" aria-label="Main">
    <a href="{{BASE}}/loan-programs/">Loan Programs</a>
    <a href="{{BASE}}/tools/">Free Tools</a>
    <a href="{{BASE}}/locations/">Locations</a>
    <a href="{{BASE}}/blog/">Resources</a>
    <a href="{{BASE}}/about/">About</a>
    <a class="phone" href="tel:+18502798588">(850) 279-8588</a>
    <a href="{{BASE}}/get-quote/">Get a Quote</a>
    <a class="btn btn-gold" href="{{BASE}}/apply/">Apply Now</a>
  </nav>
</div></header>
<main id="main">
'@

$foot = @'
</main>
<footer class="ft"><div class="wrap">
  <div class="cols">
    <div>
      <div class="logo"><img src="{{BASE}}/static/logo-wide.png" alt="BridgePoint Lending" width="148" height="40"></div>
      <p>Private capital for real estate investors. Business-purpose loans only.</p>
      <p><a href="tel:+18502798588">(850) 279-8588</a><br><a href="mailto:info@bplending.com">info@bplending.com</a></p>
    </div>
    <div><h4>Loans</h4><ul>
      <li><a href="{{BASE}}/fix-and-flip-loans/">Fix &amp; Flip Loans</a></li>
      <li><a href="{{BASE}}/bridge-loans/">Bridge Loans</a></li>
      <li><a href="{{BASE}}/ground-up-construction-loans/">Ground-Up Construction</a></li>
      <li><a href="{{BASE}}/dscr-loans/">DSCR Rental Loans</a></li>
      <li><a href="{{BASE}}/portfolio-loans/">Portfolio Loans</a></li>
      <li><a href="{{BASE}}/commercial-multifamily-loans/">Commercial &amp; Multifamily</a></li></ul></div>
    <div><h4>Tools</h4><ul>
      <li><a href="{{BASE}}/deal-analyzer/">Deal Analyzer</a></li>
      <li><a href="{{BASE}}/estimate/">Rate &amp; Loan Estimator</a></li>
      <li><a href="{{BASE}}/dscr-calculator/">DSCR Calculator</a></li>
      <li><a href="{{BASE}}/fix-and-flip-calculator/">Fix &amp; Flip Calculator</a></li>
      <li><a href="{{BASE}}/apply/">Apply Now</a></li>
      <li><a href="{{BASE}}/get-quote/">Get a Quote</a></li></ul></div>
    <div><h4>Company</h4><ul>
      <li><a href="{{BASE}}/about/">About</a></li>
      <li><a href="{{BASE}}/locations/">Locations</a></li>
      <li><a href="{{BASE}}/blog/">Resources</a></li>
      <li><a href="{{BASE}}/partners/">Referral Partners</a></li>
      <li><a href="{{BASE}}/contact/">Contact</a></li>
      <li><a href="{{BASE}}/privacy-policy/">Privacy Policy</a></li>
      <li><a href="{{BASE}}/terms-of-service/">Terms of Service</a></li></ul></div>
  </div>
  <div class="legal">BridgePoint Lending provides business-purpose loans secured by investment real estate. Not for personal, family or household use. All loans are subject to underwriting and approval; rates, terms, loan amounts and availability vary by property, borrower and market. Estimates on this site are not offers, rate locks or commitments to lend. Not available in all states.</div>
</div></footer>
<div class="sticky"><a class="c" href="tel:+18502798588">Call us</a><a class="q" href="{{BASE}}/get-quote/">Get a Quote</a></div>
{{SCRIPTS}}
</body>
</html>
'@

$pages = @()
Get-ChildItem $srcDir -Recurse -Filter *.html | ForEach-Object {
  $rel = $_.FullName.Substring($srcDir.Length + 1).Replace("\", "/")
  $text = [IO.File]::ReadAllText($_.FullName)
  if (-not $text.StartsWith("---")) { throw "Missing front matter: $rel" }
  $end = $text.IndexOf("`n---", 3)
  $fm = $text.Substring(3, $end - 3).Trim() -split "`r?`n"
  $body = $text.Substring($end + 4).TrimStart("`r", "`n")
  $meta = @{}
  foreach ($line in $fm) { $i = $line.IndexOf(":"); if ($i -gt 0) { $meta[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() } }
  $canon = $meta["canon"]; if (-not $canon) { throw "Missing canon: $rel" }
  $robots = if ($meta["noindex"] -eq "true") { '<meta name="robots" content="noindex,follow">' } else { '' }
  $scripts = '<script src="{{BASE}}/static/site.js" defer></script>'
  if ($body.Contains('id="analyzer"')) { $scripts += "`n" + '<script src="{{BASE}}/static/analyzer.js" defer></script>' }
  if ($body.Contains("data-qw")) { $scripts += "`n" + '<script src="{{BASE}}/static/quote.js" defer></script>' }
  $html = $head + $body + "`n" + $foot
  $html = $html.Replace("{{SCRIPTS}}", $scripts).Replace("{{ROBOTS}}", $robots)
  $html = $html.Replace("{{TITLE}}", $meta["title"]).Replace("{{DESC}}", $meta["description"]).Replace("{{OGIMG}}", $(if ($meta["image"]) { $meta["image"] } else { "/static/logo-wide.png" })).Replace("{{CANON}}", $canon).Replace("{{DOMAIN}}", $domain).Replace("{{BASE}}", $Base).Replace("{{EXCLUDED_NAMES}}", $exNames).Replace("{{STATE_COUNT}}", [string]$stCount).Replace("{{TRACKING}}", $tracking)
  $dest = Join-Path $outDir $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  [IO.File]::WriteAllText($dest, $html, (New-Object Text.UTF8Encoding($false)))
  if ($meta["noindex"] -ne "true" -and $rel -ne "404.html") { $pages += @{ canon = $canon; pri = $(if ($meta["priority"]) { $meta["priority"] } else { "0.6" }) } }
}

# static assets
$staticOut = Join-Path $outDir "static"
New-Item -ItemType Directory -Force -Path $staticOut | Out-Null
Copy-Item (Join-Path $srcDir "static\*") $staticOut -Recurse -Force
Copy-Item (Join-Path $root "assets\logo-wide.png") $staticOut -Force
Copy-Item (Join-Path $root "assets\icon-192.png") $staticOut -Force

# sitemap + robots
$today = (Get-Date).ToString("yyyy-MM-dd")
$sm = '<?xml version="1.0" encoding="UTF-8"?>' + "`n" + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + "`n"
foreach ($p in ($pages | Sort-Object { $_.canon })) { $sm += "  <url><loc>$domain$($p.canon)</loc><lastmod>$today</lastmod><priority>$($p.pri)</priority></url>`n" }
$sm += "</urlset>`n"
[IO.File]::WriteAllText((Join-Path $outDir "sitemap.xml"), $sm, (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $outDir "robots.txt"), "User-agent: *`nAllow: /`nDisallow: /thank-you/`nDisallow: /funded-shell/`nSitemap: $domain/sitemap.xml`nSitemap: $domain/funded-sitemap.xml`n", (New-Object Text.UTF8Encoding($false)))
Write-Output ("Built " + $pages.Count + " indexable pages into " + $outDir + " (base '" + $Base + "')")
